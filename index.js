/**
 * index.js
 * -----------------------------------------------------------------------------
 * Backwards-compatible entry point.
 *
 * The original file was a 500-line single-session bot with an inline HTML
 * dashboard and a private copy of the OTP logic. That logic now lives in
 * `src/` where it can serve many devices at once:
 *
 *   src/sessionManager.js  -> browser lifecycle, one Map per sessionId
 *   src/messageService.js  -> OTP store, alerts, message sending (per session)
 *   src/server.js          -> Express + REST + SSE, serves public/
 *
 * So this file is only a launcher: `node index.js` and `npm start` now boot the
 * exact same gateway. Everything the old API exposed is still reachable, and
 * `/api/send-otp` and friends may omit `sessionId` while a single session
 * exists — see `resolveSessionId` in src/messageService.js.
 * ---------------------------------------------------------------------------
 */

import './src/server.js';
