/**
 * server.js
 * -----------------------------------------------------------------------------
 * HTTP layer of the Multi-Session WhatsApp Gateway.
 *
 * Responsibilities:
 *   1. Serve the pre-built frontend from `public/`.
 *   2. Expose the session REST API on top of `sessionManager.js`.
 *   3. Expose the messaging API on top of `messageService.js`.
 *   4. Stream live session changes over SSE so the UI never polls.
 *   5. Own process concerns: port binding, errors, graceful shutdown.
 *
 * REST API
 *   GET    /api/health                      -> liveness probe
 *   GET    /api/config                      -> dashboard bootstrap (auth mode)
 *   GET    /api/events                      -> SSE stream of session changes
 *   GET    /api/sessions                    -> every session + its status
 *   GET    /api/sessions/:sessionId         -> single session (poll for QR)
 *   POST   /api/sessions/create             -> { "sessionId": "my-session" }
 *   DELETE /api/sessions/:sessionId         -> logout + destroy the client
 *   POST   /api/send-otp                    -> issue + deliver an OTP
 *   POST   /api/verify-otp                  -> consume an OTP
 *   POST   /api/send-login-alert            -> templated sign-in alert
 *   POST   /api/send-message                -> arbitrary WhatsApp message
 *
 * Every route from /api/send-otp onwards is guarded by `requireApiKey` when
 * GATEWAY_API_KEY is set. Without it the gateway is open (local dev default) and
 * says so loudly on boot.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { sessionManager } from './sessionManager.js';
import {
  ServiceError,
  sendOtp,
  verifyOtp,
  sendLoginAlert,
  sendTextMessage,
  otpStats,
} from './messageService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.GATEWAY_API_KEY || '';

const app = express();

/* -------------------------------------------------------------------------- */
/* Global middleware                                                          */
/* -------------------------------------------------------------------------- */

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Tiny request log — swap for pino/morgan if you need structured logs.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
});

/**
 * Guard for anything that can send a WhatsApp message.
 * No-ops when GATEWAY_API_KEY is unset so local development stays frictionless.
 */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const provided = req.get('x-api-key') || req.query.apiKey;
  if (provided && provided === API_KEY) return next();

  res.status(401).json({
    success: false,
    error: 'Unauthorized: provide the gateway key in the x-api-key header.',
  });
}

/**
 * Wraps a handler so ServiceError status codes reach the client verbatim.
 * @param {(body: object, req: object) => any} handler
 */
const route = (handler) => async (req, res) => {
  try {
    const payload = await handler(req.body ?? {}, req);
    res.json({ success: true, ...payload });
  } catch (error) {
    if (error instanceof ServiceError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error('[server] route failure:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

/* -------------------------------------------------------------------------- */
/* Static frontend                                                            */
/* -------------------------------------------------------------------------- */

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
);

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

// Liveness probe.
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    uptimeSeconds: Math.round(process.uptime()),
    sessions: sessionManager.sessions.size,
    otp: otpStats(),
    timestamp: new Date().toISOString(),
  });
});

// Bootstrap for the dashboard: tells the UI whether it must send an API key.
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    authRequired: Boolean(API_KEY),
    apiKey: API_KEY && req.get('x-api-key') === API_KEY ? API_KEY : null,
    otpTtlMs: Number(process.env.OTP_TTL_MS) || 5 * 60 * 1000,
    timezone: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
  });
});

/**
 * Server-Sent Events: push every session state change to the browser.
 * `no-cache, no-transform` + a heartbeat keeps proxies from buffering us.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial snapshot so a fresh page load renders without an extra fetch.
  send('snapshot', { sessions: sessionManager.getAllSessions() });

  const unsubscribe = sessionManager.subscribe((event, session) => send(event, { session }));

  // Comment frame every 25s keeps the socket (and any load balancer) alive.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// 1) List every session and its current status.
app.get('/api/sessions', (req, res) => {
  const sessions = sessionManager.getAllSessions();
  res.json({ success: true, count: sessions.length, sessions });
});

// 2) Single session — used by the QR countdown fallback if SSE is blocked.
app.get('/api/sessions/:sessionId', (req, res) => {
  try {
    const session = sessionManager.getSessionStatus(req.params.sessionId);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }

    return res.json({ success: true, session });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

// 3) Create a session -> WhatsApp emits a QR that the UI scans.
app.post('/api/sessions/create', async (req, res) => {
  const { sessionId } = req.body ?? {};

  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return res.status(400).json({
      success: false,
      error: 'Request body must include "sessionId".',
    });
  }

  try {
    const { session, created } = await sessionManager.createSession(sessionId);

    return res.status(created ? 201 : 200).json({
      success: true,
      created,
      message: created
        ? 'Session created. Poll for the QR code.'
        : 'Session already exists — returning current state.',
      session,
    });
  } catch (error) {
    const isValidationError = /sessionId|Invalid/i.test(error.message);
    return res
      .status(isValidationError ? 400 : 500)
      .json({ success: false, error: error.message });
  }
});

// 4) Delete a session -> logout() + destroy(), removing it from the registry.
app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const deleted = await sessionManager.deleteSession(req.params.sessionId);

    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }

    return res.json({
      success: true,
      message: `Session "${req.params.sessionId}" logged out and destroyed.`,
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Messaging (guarded)                                                        */
/* -------------------------------------------------------------------------- */

app.post('/api/send-otp', requireApiKey, route((body) => sendOtp(sessionManager, body)));

app.post('/api/verify-otp', requireApiKey, route((body) => verifyOtp(sessionManager, body)));

app.post(
  '/api/send-login-alert',
  requireApiKey,
  route((body) => sendLoginAlert(sessionManager, body))
);

app.post(
  '/api/send-message',
  requireApiKey,
  route((body) => sendTextMessage(sessionManager, body))
);

// Unknown API route -> JSON 404 (never fall through to the SPA).
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Unknown endpoint: ${req.method} ${req.originalUrl}` });
});

/* -------------------------------------------------------------------------- */
/* SPA fallback + error handling                                              */
/* -------------------------------------------------------------------------- */

// Client-side routing fallback: any non-API GET returns the frontend shell.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();

  if (!fs.existsSync(INDEX_HTML)) {
    return res.status(404).type('text/plain').send(
      `Frontend not found at ${PUBLIC_DIR}. Drop the built HTML/JS files into the "public" folder.`
    );
  }

  return res.sendFile(INDEX_HTML);
});

// Central error handler: never leak stack traces to the client.
app.use((err, req, res, next) => {
  // body-parser flags client mistakes (bad JSON, oversized body) with a 4xx
  // status and an `expose` flag — surface those as-is instead of a 500.
  const status = Number(err.status || err.statusCode) || 500;
  const clientError = status >= 400 && status < 500;

  if (!clientError) console.error('[server] unhandled error:', err);

  res.status(status).json({
    success: false,
    error:
      clientError && err.expose
        ? err.message
        : status === 413
          ? 'Request body too large.'
          : 'Internal server error.',
  });
});

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const server = app.listen(PORT, HOST, async () => {
  console.log('============================================================');
  console.log(`🚀 WhatsApp Gateway listening on http://localhost:${PORT}`);
  console.log(`📂 Static frontend: ${PUBLIC_DIR}`);
  console.log(`💾 Auth storage:    ${sessionManager.dataPath}`);
  if (API_KEY) {
    console.log('🔐 API key required for message routes (x-api-key header)');
  } else {
    console.log('⚠️  No GATEWAY_API_KEY set — message routes are OPEN. Set it before exposing this host.');
  }
  console.log('============================================================');

  // Restore previously linked WhatsApp sessions after restart
  try {
    await sessionManager.restoreSavedSessions();
  } catch (err) {
    console.error('[server] session restore failed:', err.message);
  }
});


/** Close browsers then the HTTP server so Chromium never leaks on restart. */
async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down.`);
  server.close();
  try {
    await sessionManager.destroyAll();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last line of defence: if we are killed outright there is no time to await the
// graceful teardown, so take the Chromium processes down synchronously.
process.on('exit', () => sessionManager.killBrowsersSync());

process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

export { app, server, API_KEY, PUBLIC_DIR };
