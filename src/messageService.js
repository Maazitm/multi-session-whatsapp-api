/**
 * messageService.js
 * -----------------------------------------------------------------------------
 * Everything that *uses* a connected WhatsApp session.
 *
 * Kept separate from `sessionManager.js` (which only owns browser lifecycle) and
 * from `server.js` (which only owns HTTP). Every operation is bound to a
 * `sessionId`, so two linked numbers can issue and verify their own OTPs
 * independently instead of sharing one global store.
 *
 * OTP lifecycle: generated -> delivered over WhatsApp -> verified, or auto
 * expires after `OTP_TTL_MS`. Entries are keyed `sessionId:phone`.
 * ---------------------------------------------------------------------------
 */

import { randomInt } from 'node:crypto';
import { SESSION_STATUS } from './sessionManager.js';

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS) || 5 * 60 * 1000;
const OTP_LENGTH = 6;

/** sessionId -> phone -> { otp, expiresAt, attempts } */
const otpStore = new Map();

/**
 * Error carrying an HTTP status so route handlers can forward it untouched.
 */
export class ServiceError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status = 500) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

/**
 * Reduce a user-entered phone number to bare digits and sanity check it.
 * Accepts spaces, dashes, brackets and a leading +.
 * @param {unknown} phone
 * @returns {string} digits only, e.g. "919552103467"
 */
export function normalizePhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') {
    throw new ServiceError('A "phone" number is required.', 400);
  }

  const digits = String(phone).replace(/\D/g, '');

  // 8-15 digits covers every real E.164 number (min ITU is far lower).
  if (digits.length < 8 || digits.length > 15) {
    throw new ServiceError('Invalid phone number. Use the full number with country code, e.g. 919552103467.', 400);
  }

  return digits;
}

/** WhatsApp jid for a normalized number. */
function toChatId(phone) {
  return `${phone}@c.us`;
}

/**
 * Cryptographically-random numeric OTP.
 * `randomInt` is uniform, so no modulo bias (unlike `% 10**6`).
 * @returns {string} `OTP_LENGTH` digits
 */
function generateOtp() {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * Drop expired entries for a key (and the parent map when it empties).
 * @param {string} sessionId
 * @param {string} phone
 */
function pruneExpired(sessionId, phone) {
  const bucket = otpStore.get(sessionId);
  if (!bucket) return;

  const record = bucket.get(phone);
  if (record && record.expiresAt > Date.now()) return;

  bucket.delete(phone);
  if (bucket.size === 0) otpStore.delete(sessionId);
}

/**
 * Work out which session an operation targets.
 *
 * `sessionId` may be omitted when the gateway hosts exactly one session: that
 * keeps single-session callers (the legacy `index.js` API) working unchanged,
 * while still forcing an explicit choice as soon as a second device exists.
 *
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {string} [sessionId]
 * @returns {string} the resolved session id
 */
function resolveSessionId(manager, sessionId) {
  let id = sessionId;

  if (!id) {
    if (manager.sessions.size === 1) {
      [id] = manager.sessions.keys();
    } else {
      throw new ServiceError(
        manager.sessions.size === 0
          ? 'No sessions exist yet. Create one and link a device first.'
          : 'A "sessionId" is required when more than one session exists.',
        400
      );
    }
  }

  if (typeof id !== 'string') {
    throw new ServiceError('"sessionId" must be a string.', 400);
  }

  return id;
}

/**
 * Resolve a live, authenticated client or fail with a helpful status code.
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {string} [sessionId]
 * @returns {import('whatsapp-web.js').Client}
 */
function requireConnectedClient(manager, sessionId) {
  const id = resolveSessionId(manager, sessionId);
  const session = manager.getSessionStatus(id);

  if (!session) {
    throw new ServiceError(`Session "${id}" does not exist.`, 404);
  }

  if (session.status === SESSION_STATUS.DISCONNECTED) {
    throw new ServiceError(`Session "${id}" is disconnected. Re-create it and scan a new QR code.`, 409);
  }

  if (session.status !== SESSION_STATUS.CONNECTED) {
    throw new ServiceError(
      `Session "${id}" is not ready yet (${session.statusLabel}). Scan the QR code and wait for it to connect.`,
      409
    );
  }

  const client = manager.getClient(id);
  if (!client) {
    throw new ServiceError(`Session "${id}" has no active browser.`, 409);
  }

  return client;
}

/**
 * Low-level send used by every public operation.
 * @param {import('./whatsapp-web.js').Client} client
 * @param {string} chatId
 * @param {string} body
 * @returns {Promise<string>} the message id WhatsApp assigned
 */
async function dispatch(client, chatId, body) {
  try {
    const response = await client.sendMessage(chatId, body);
    return response?.id ?? 'sent';
  } catch (error) {
    // Surface WhatsApp's own reason (chat blocked, not on WhatsApp, rate limit)
    // instead of a generic failure — it is the single most useful thing here.
    throw new ServiceError(`WhatsApp rejected the message: ${error.message}`, 502);
  }
}

/* -------------------------------------------------------------------------- */
/* Public operations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Generate an OTP, store it, and deliver it over WhatsApp.
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {{ sessionId: string, phone: string, appName?: string }} input
 */
export async function sendOtp(manager, { sessionId, phone, appName }) {
  // Cheap input validation first: a malformed phone should report 400, not a
  // 409 about session readiness.
  const clean = normalizePhone(phone);
  const id = resolveSessionId(manager, sessionId);
  const client = requireConnectedClient(manager, id);

  const otp = generateOtp();
  const expiresAt = Date.now() + OTP_TTL_MS;

  if (!otpStore.has(id)) otpStore.set(id, new Map());
  otpStore.get(id).set(clean, { otp, expiresAt, attempts: 0 });

  const brand = (appName && String(appName).trim()) || 'Secure Access';
  const minutes = Math.round(OTP_TTL_MS / 60000);

  const body =
    `🔐 *${brand}* — Verification Code\n` +
    `\nYour one-time code is: *${otp}*\n\n` +
    `⏳ Valid for ${minutes} minute${minutes === 1 ? '' : 's'}.\n` +
    `⚠️ Never share this code — staff will never ask for it.`;

  const messageId = await dispatch(client, toChatId(clean), body);

  return { sessionId: id, phone: clean, otp, expiresAt, ttlMs: OTP_TTL_MS, messageId };
}

/**
 * Verify a previously issued OTP.
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {{ sessionId: string, phone: string, otp: string }} input
 * @returns {{ verified: boolean, message: string }}
 */
export function verifyOtp(manager, { sessionId, phone, otp }) {
  if (!otp) throw new ServiceError('An "otp" value is required.', 400);

  const id = resolveSessionId(manager, sessionId);
  const clean = normalizePhone(phone);
  pruneExpired(id, clean);

  const bucket = otpStore.get(id);
  const record = bucket?.get(clean);

  if (!record) {
    throw new ServiceError('No active code was requested for this number on this session.', 400);
  }

  if (record.otp !== String(otp).trim()) {
    record.attempts += 1;
    throw new ServiceError('Incorrect code.', 400);
  }

  // Single-use: burn the code the moment it validates.
  bucket.delete(clean);
  if (bucket.size === 0) otpStore.delete(id);

  return { verified: true, sessionId: id, message: 'Phone number verified successfully.' };
}

/**
 * Send a templated "new sign-in" security alert.
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {object} input
 */
export async function sendLoginAlert(manager, {
  sessionId,
  phone,
  appName,
  deviceName,
  ipAddress,
  location,
}) {
  const clean = normalizePhone(phone);
  const id = resolveSessionId(manager, sessionId);
  const client = requireConnectedClient(manager, id);

  const brand = (appName && String(appName).trim()) || 'Account Portal';
  const stamp = new Date().toLocaleString('en-IN', {
    timeZone: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const body =
    `🔔 *Security Alert: New Sign-in*\n\n` +
    `Hello! Your *${brand}* account was just accessed.\n\n` +
    `📅 *Time:* ${stamp}\n` +
    `💻 *Device:* ${(deviceName && deviceName.trim()) || 'Web Browser'}\n` +
    `🌐 *IP Address:* ${(ipAddress && ipAddress.trim()) || 'Not logged'}\n` +
    `📍 *Location:* ${(location && location.trim()) || 'Unknown'}\n\n` +
    `If this was not you, secure your account immediately.`;

  const messageId = await dispatch(client, toChatId(clean), body);

  return { sessionId: id, phone: clean, messageId };
}

/**
 * Send an arbitrary message.
 * @param {import('./sessionManager.js').SessionManager} manager
 * @param {{ sessionId: string, phone: string, message: string }} input
 */
export async function sendTextMessage(manager, { sessionId, phone, message }) {
  const clean = normalizePhone(phone);

  if (typeof message !== 'string' || message.trim() === '') {
    throw new ServiceError('A non-empty "message" is required.', 400);
  }

  if (message.length > 4096) {
    throw new ServiceError('Message is too long (WhatsApp allows 4096 characters).', 400);
  }

  const id = resolveSessionId(manager, sessionId);
  const client = requireConnectedClient(manager, id);

  const messageId = await dispatch(client, toChatId(clean), message);

  return { sessionId: id, phone: clean, messageId, characters: message.length };
}

/**
 * Diagnostics for the dashboard footer.
 */
export function otpStats() {
  let pending = 0;
  const now = Date.now();

  for (const bucket of otpStore.values()) {
    for (const record of bucket.values()) if (record.expiresAt > now) pending += 1;
  }

  return { pending, sessions: otpStore.size };
}

/** Test/shutdown helper: forget every in-flight OTP. */
export function clearOtpStore() {
  otpStore.clear();
}
  