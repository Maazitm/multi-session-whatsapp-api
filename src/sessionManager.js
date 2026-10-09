/**
 * sessionManager.js
 * -----------------------------------------------------------------------------
 * Owns every WhatsApp client instance in the gateway.
 *
 * Each session is stored in a single `Map` keyed by its `sessionId`:
 *
 *   Map<sessionId, {
 *     sessionId, client, status, qrCode, pushName, wid,
 *     createdAt, updatedAt, lastError, disconnectReason
 *   }>
 *
 * The manager is completely transport agnostic: `server.js` only talks to the
 * public helpers (`createSession`, `getAllSessions`, `getSessionStatus`,
 * `deleteSession`), so the REST layer never touches a raw `Client`.
 * ---------------------------------------------------------------------------
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import wwebjs from 'whatsapp-web.js';
import QRCode from 'qrcode';

const { Client, LocalAuth } = wwebjs;

/** Events emitted by the manager so the HTTP layer can stream updates. */
export const SESSION_EVENTS = Object.freeze({
  UPDATED: 'session:updated',
  DELETED: 'session:deleted',
});

/** Lifecycle states a session can be in. */
export const SESSION_STATUS = Object.freeze({
  CONNECTING: 'CONNECTING',
  QR_READY: 'QR_READY',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  FAILED: 'FAILED',
});

/** Human friendly labels consumed by the dashboard UI. */
const STATUS_LABELS = Object.freeze({
  [SESSION_STATUS.CONNECTING]: 'Connecting',
  [SESSION_STATUS.QR_READY]: 'QR Ready',
  [SESSION_STATUS.CONNECTED]: 'Connected',
  [SESSION_STATUS.DISCONNECTED]: 'Disconnected',
  [SESSION_STATUS.FAILED]: 'Failed',
});

/**
 * Disconnect reasons that are transient (WhatsApp Web navigation, browser
 * crash, etc.). Terminal reasons (`LOGOUT`, `UNPAIRED`, `UNLAUNCHED`) mean the
 * device is no longer linked and the session must be re-scanned.
 *
 * Auto-reconnect is intentionally OFF by default: on `disconnected` we simply
 * clean the instance up (browser destroyed, state cleared) so no orphaned
 * Chromium process is left behind. Flip `AUTO_RECONNECT` to `true` if you would
 * rather transparently retry on the recoverable reasons above.
 */
const AUTO_RECONNECT = false;
const RECOVERABLE_REASONS = new Set(['NAVIGATION', 'UNPAIRED_TIMEOUT', 'CONFLICT']);
const RECONNECT_DELAY_MS = 5000;
const LOGOUT_TIMEOUT_MS = 15000;
const DESTROY_TIMEOUT_MS = 10000;

/**
 * Reject if `promise` takes longer than `ms`, without cancelling the original.
 * @template T
 * @param {Promise<T>|undefined} promise
 * @param {number} ms
 * @returns {Promise<T|undefined>}
 */
function withTimeout(promise, ms) {
  if (!promise) return Promise.resolve(undefined);

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    }),
  ]);
}

/** Session ids become folder names under the auth dir, so keep them tame. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** Chromium flags that keep Puppeteer usable inside containers / CI. */
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

/**
 * Normalise + validate a session id.
 * @param {unknown} sessionId
 * @returns {string} trimmed, validated id
 * @throws {Error} when the id is missing or contains illegal characters
 */
export function assertValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('"sessionId" is required and must be a non-empty string.');
  }

  const normalized = sessionId.trim();

  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(
      'Invalid "sessionId". Use 1-64 characters limited to letters, numbers, dot, dash or underscore.'
    );
  }

  return normalized;
}

export class SessionManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.dataPath] Folder where LocalAuth persists credentials.
   * @param {boolean} [options.headless] Run Chromium headless (default: true).
   */
  constructor(options = {}) {
    super();
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this.dataPath = path.resolve(options.dataPath ?? process.env.WWEBJS_DATA_PATH ?? './wwebjs_auth');
    this.headless = options.headless ?? true;
  }

  /**
   * Subscribe to live session changes.
   * @param {(event: string, session: object) => void} listener
   * @returns {() => void} unsubscribe function
   */
  subscribe(listener) {
    this.on(SESSION_EVENTS.UPDATED, listener);
    this.on(SESSION_EVENTS.DELETED, listener);

    return () => {
      this.removeListener(SESSION_EVENTS.UPDATED, listener);
      this.removeListener(SESSION_EVENTS.DELETED, listener);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Create                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Create (or re-open) a WhatsApp session.
   *
   * Re-creating an id that already exists is a no-op: the existing record is
   * returned so callers can poll it instead of spawning a second browser.
   *
   * @param {string} sessionId
   * @returns {{ session: object, created: boolean }} live session view
   * @throws {Error} on invalid ids or when Puppeteer fails to boot
   */
  async createSession(sessionId) {
    const id = assertValidSessionId(sessionId);

    if (this.sessions.has(id)) {
      return { session: this.getSessionStatus(id), created: false };
    }

    const record = {
      sessionId: id,
      client: null,
      status: SESSION_STATUS.CONNECTING,
      qrCode: null,
      pushName: null,
      wid: null,
      disconnectReason: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      /** True while `client.initialize()` is in flight. */
      isInitializing: false,
      /** Set while `deleteSession()` is tearing the client down. */
      isDeleting: false,
    };

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: id,
        dataPath: this.dataPath,
      }),
      puppeteer: {
        headless: this.headless,
        args: PUPPETEER_ARGS,
      },
    });

    record.client = client;
    this.#attachListeners(record);
    this.sessions.set(id, record);

    // Register before initializing so a very fast `qr` event is not missed.
    try {
      record.isInitializing = true;
      await client.initialize();
    } catch (error) {
      record.isInitializing = false;
      this.#markFailed(record, error);
      await this.#teardown(record, { keepRecord: true });
      throw new Error(`Failed to initialize WhatsApp session "${id}": ${error.message}`);
    } finally {
      record.isInitializing = false;
    }

    return { session: this.getSessionStatus(id), created: true };
  }

  /* ------------------------------------------------------------------ */
  /* Read                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * All known sessions with their live status.
   * @returns {object[]}
   */
  getAllSessions() {
    return [...this.sessions.values()].map((record) => this.#toPublicView(record));
  }

  /**
   * Status of a single session (includes the base64 QR data URL while waiting
   * for a scan, and the linked identity once connected).
   * @param {string} sessionId
   * @returns {object|null} null when the session is unknown
   */
  getSessionStatus(sessionId) {
    const record = this.sessions.get(assertValidSessionId(sessionId));
    return record ? this.#toPublicView(record) : null;
  }

  /**
   * Escape hatch for modules that need to actually send messages.
   * @param {string} sessionId
   * @returns {import('whatsapp-web.js').Client|null}
   */
  getClient(sessionId) {
    return this.sessions.get(assertValidSessionId(sessionId))?.client ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Delete                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Log out from WhatsApp, destroy the browser and drop the session.
   *
   * `logout()` wipes the stored credentials so the next `createSession()` with
   * the same id produces a fresh QR instead of silently reusing the device.
   * Failures are swallowed: the session is removed either way.
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>} true when a session was removed
   */
  async deleteSession(sessionId) {
    const id = assertValidSessionId(sessionId);
    const record = this.sessions.get(id);

    if (!record) return false;

    record.isDeleting = true;

    try {
      // `logout()` talks to WhatsApp Web, so it can hang on an unpaired or
      // wedged browser. Bound it: the session is destroyed either way.
      await withTimeout(record.client?.logout(), LOGOUT_TIMEOUT_MS);
    } catch (error) {
      // A dead browser cannot log out; destroying it still frees the resources.
      console.warn(`[session:${id}] logout skipped (${error.message}); forcing cleanup.`);
    }

    await this.#teardown(record, { keepRecord: false });
    this.emit(SESSION_EVENTS.DELETED, SESSION_EVENTS.DELETED, { sessionId: id });

    return true;
  }

  /**
   * Kill every browser process without awaiting.
   *
   * Used from `process.on('exit')`: on Windows a hard kill of the node process
   * would otherwise leave headless Chromium running forever, because there is no
   * chance to `await` the graceful teardown.
   */
  killBrowsersSync() {
    for (const record of this.sessions.values()) {
      try {
        // whatsapp-web.js exposes the Puppeteer `Browser` as `client.pupBrowser`;
        // `browser.process()` is the Chromium ChildProcess.
        record.client?.pupBrowser?.process?.()?.kill?.();
      } catch {
        /* nothing useful can be done while the process is exiting */
      }
    }
  }

  /**
   * Graceful shutdown helper — log out of nothing, just close every browser.
   * @returns {Promise<void>}
   */
  async destroyAll() {
    await Promise.all(
      [...this.sessions.keys()].map(async (id) => {
        const record = this.sessions.get(id);
        if (record) await this.#teardown(record, { keepRecord: true });
      })
    );
    this.sessions.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Wire the whatsapp-web.js events onto our internal session record.
   * @param {object} record
   */
  #attachListeners(record) {
    const { client, sessionId } = record;

    // A QR was issued: store it as a base64 data URL for the dashboard.
    client.on('qr', async (qr) => {
      if (record.isDeleting) return;

      try {
        record.qrCode = await QRCode.toDataURL(qr, {
          margin: 2,
          scale: 8,
          color: { dark: '#075e54', light: '#ffffff' },
        });
        this.#setStatus(record, SESSION_STATUS.QR_READY);
        console.log(`[session:${sessionId}] QR ready — scan it to link the device.`);
      } catch (error) {
        console.error(`[session:${sessionId}] failed to render QR:`, error.message);
      }
    });

    // Pairing accepted, WhatsApp Web session established.
    client.on('authenticated', () => {
      if (record.isDeleting) return;

      record.qrCode = null;
      this.#setStatus(record, SESSION_STATUS.QR_READY);
      console.log(`[session:${sessionId}] authenticated.`);
    });

    // Handshake complete: the account is linked and messages can be sent.
    client.on('ready', () => {
      if (record.isDeleting) return;

      record.qrCode = null;
      record.lastError = null;
      record.disconnectReason = null;
      record.pushName = client.info?.pushname ?? null;
      record.wid = client.info?.wid?.user ?? null;
      this.#setStatus(record, SESSION_STATUS.CONNECTED);
      console.log(`[session:${sessionId}] ready${record.pushName ? ` as ${record.pushName}` : ''}.`);
    });

    client.on('auth_failure', (message) => {
      record.lastError = message;
      console.error(`[session:${sessionId}] auth failure: ${message}`);
    });

    client.on('disconnected', async (reason) => {
      if (record.isDeleting) return;

      record.qrCode = null;
      record.disconnectReason = reason;
      record.pushName = null;
      record.wid = null;
      this.#setStatus(record, SESSION_STATUS.DISCONNECTED);
      console.warn(`[session:${sessionId}] disconnected (${reason}).`);

      if (AUTO_RECONNECT && RECOVERABLE_REASONS.has(reason)) {
        console.log(`[session:${sessionId}] retrying in ${RECONNECT_DELAY_MS}ms...`);
        setTimeout(() => {
          const live = this.sessions.get(sessionId);
          if (!live || live.isDeleting || live.status === SESSION_STATUS.CONNECTED) return;
          this.#setStatus(live, SESSION_STATUS.CONNECTING);
          live.isInitializing = true;
          live.client
            .initialize()
            .catch((error) => this.#markFailed(live, error))
            .finally(() => {
              live.isInitializing = false;
            });
        }, RECONNECT_DELAY_MS).unref();
        return;
      }

      // Default policy: drop the browser but keep the record so the UI can
      // show "Disconnected" until the user deletes it or re-creates it.
      await this.#teardown(record, { keepRecord: true });
    });
  }

  /**
   * Shape a record into the safe payload sent to the browser (never leaks the
   * Client instance or any filesystem detail).
   * @param {object} record
   * @returns {object}
   */
  #toPublicView(record) {
    return {
      sessionId: record.sessionId,
      status: record.status,
      statusLabel: STATUS_LABELS[record.status] ?? record.status,
      qrCode: record.qrCode,
      pushName: record.pushName,
      number: record.wid,
      isConnected: record.status === SESSION_STATUS.CONNECTED,
      isScannable: record.status === SESSION_STATUS.QR_READY && Boolean(record.qrCode),
      disconnectReason: record.disconnectReason,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Update the status and push the fresh view to subscribers.
   * @param {object} record
   * @param {string} status
   */
  #setStatus(record, status) {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    this.emit(SESSION_EVENTS.UPDATED, SESSION_EVENTS.UPDATED, this.#toPublicView(record));
  }

  /**
   * @param {object} record
   * @param {Error} error
   */
  #markFailed(record, error) {
    record.lastError = error.message;
    record.qrCode = null;
    this.#setStatus(record, SESSION_STATUS.FAILED);
    console.error(`[session:${record.sessionId}] ${error.message}`);
  }

  /**
   * Destroy the client and remove its listeners.
   * @param {object} record
   * @param {{ keepRecord: boolean }} options
   */
  async #teardown(record, { keepRecord }) {
    const { client, sessionId } = record;

    if (client) {
      client.removeAllListeners('qr');
      client.removeAllListeners('authenticated');
      client.removeAllListeners('ready');
      client.removeAllListeners('disconnected');
      client.removeAllListeners('auth_failure');

      try {
        await withTimeout(client.destroy(), DESTROY_TIMEOUT_MS);
      } catch (error) {
        console.warn(`[session:${sessionId}] destroy failed: ${error.message}`);
      }
      record.client = null;
    }

    if (!keepRecord) {
      this.sessions.delete(sessionId);
    }
  }
}

/** Shared instance used by `server.js`. */
export const sessionManager = new SessionManager();

export default sessionManager;
