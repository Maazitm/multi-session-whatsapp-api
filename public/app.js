/**
 * app.js — WhatsApp Gateway control center
 * ---------------------------------------------------------------------------
 * Vanilla JS, no build step. Responsibilities:
 *   - Render the session list from a live SSE stream (fallback: 3s polling).
 *   - Show QR / linked state for the selected session.
 *   - Drive the OTP, message and login-alert forms against the REST API.
 *
 * State lives in one object; every render is a pure function of it, so an SSE
 * event and a manual refresh cannot disagree.
 */

(() => {
  'use strict';

  /* --------------------------------------------------------------------- */
  /* State                                                                  */
  /* --------------------------------------------------------------------- */

  const state = {
    sessions: new Map(), // sessionId -> session view
    activeId: null,
    apiKey: localStorage.getItem('wa.apiKey') || '',
    config: { authRequired: false, otpTtlMs: 300000 },
    sentOtp: null, // { phone, sessionId, expiresAt }
    eventSource: null,
    pollTimer: null,
  };

  /** Status -> badge class. */
  const BADGE_CLASS = {
    CONNECTED: 'badge--connected',
    QR_READY: 'badge--qr',
    CONNECTING: 'badge--connecting',
    DISCONNECTED: 'badge--disconnected',
    FAILED: 'badge--failed',
  };

  const el = (id) => document.getElementById(id);

  const dom = {
    livePill: el('livePill'),
    liveText: el('liveText'),
    themeBtn: el('themeBtn'),
    themeIcon: el('themeIcon'),
    createForm: el('createForm'),
    sessionId: el('sessionId'),
    createBtn: el('createBtn'),
    createResult: el('createResult'),
    sessionList: el('sessionList'),
    sessionCount: el('sessionCount'),
    panelTitle: el('panelTitle'),
    panelSubtitle: el('panelSubtitle'),
    panelBadge: el('panelBadge'),
    qrFrame: el('qrFrame'),
    qrSteps: el('qrSteps'),
    qrTimer: el('qrTimer'),
    logoutBtn: el('logoutBtn'),
    actionCard: el('actionCard'),
    apiKeyCard: el('apiKeyCard'),
    apiKeyForm: el('apiKeyForm'),
    apiKey: el('apiKey'),
    apiKeyResult: el('apiKeyResult'),
  };

  /* --------------------------------------------------------------------- */
  /* Small helpers                                                           */
  /* --------------------------------------------------------------------- */

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /** Show an inline success/error/info banner inside a form. */
  function showResult(node, kind, title, detail = '') {
    node.className = `result is-visible result--${kind}`;
    node.innerHTML = `<strong>${esc(title)}</strong>${detail ? esc(detail) : ''}`;
  }

  const clearResult = (node) => {
    node.className = 'result';
    node.innerHTML = '';
  };

  /** Toggle the button spinner + disabled state. */
  function busy(button, isBusy) {
    button.classList.toggle('is-busy', isBusy);
    button.disabled = isBusy;
  }

  /** Digits-only phone, used to prefill and validate client side. */
  const digits = (value) => String(value || '').replace(/\D/g, '');

  /**
   * Single JSON fetch wrapper: attaches the API key, unwraps the envelope and
   * turns non-2xx into a thrown Error carrying the server's message.
   */
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.apiKey) headers['x-api-key'] = state.apiKey;

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Cannot reach the gateway. Is the server running?');
    }

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Unexpected response from server (HTTP ${response.status}).`);
      }
    }

    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    }

    return data;
  }

  /* --------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* --------------------------------------------------------------------- */

  function statusMeta(session) {
    switch (session.status) {
      case 'CONNECTED':
        return { label: 'Connected', cls: BADGE_CLASS.CONNECTED };
      case 'QR_READY':
        return { label: 'QR Ready', cls: BADGE_CLASS.QR_READY };
      case 'CONNECTING':
        return { label: 'Connecting', cls: BADGE_CLASS.CONNECTING };
      case 'FAILED':
        return { label: 'Failed', cls: BADGE_CLASS.FAILED };
      default:
        return { label: 'Disconnected', cls: BADGE_CLASS.DISCONNECTED };
    }
  }

  function renderSessionList() {
    const list = [...state.sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));

    dom.sessionCount.textContent = list.length;

    if (list.length === 0) {
      dom.sessionList.innerHTML =
        '<div class="empty"><strong>No sessions yet</strong>Name a session above to link your first WhatsApp device.</div>';
      return;
    }

    dom.sessionList.innerHTML = list
      .map((session) => {
        const meta = statusMeta(session);
        const sub = session.isConnected
          ? `${session.pushName || 'Linked'} · ${session.number || '—'}`
          : session.lastError || session.disconnectReason || 'Waiting for a device';

        return `
          <div class="session ${session.sessionId === state.activeId ? 'is-active' : ''}"
               data-id="${esc(session.sessionId)}" role="button" tabindex="0">
            <div class="session__body">
              <div class="session__name">${esc(session.sessionId)}</div>
              <div class="session__meta">${esc(sub)}</div>
            </div>
            <span class="badge ${meta.cls}"><span class="dot"></span>${meta.label}</span>
            <div class="session__actions">
              <button class="mini-btn" data-delete="${esc(session.sessionId)}" title="Delete session" aria-label="Delete session ${esc(session.sessionId)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
              </button>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderPanel() {
    const session = state.activeId ? state.sessions.get(state.activeId) : null;

    if (!session) {
      dom.panelTitle.textContent = 'No session selected';
      dom.panelSubtitle.textContent = 'Create or pick a session to link a device';
      dom.panelBadge.className = 'badge badge--disconnected';
      dom.panelBadge.innerHTML = '<span class="dot"></span>Idle';
      dom.qrFrame.className = 'qr__frame';
      dom.qrFrame.innerHTML = '<p style="color: var(--text-3); font-size: 13px">Select a session to begin.</p>';
      dom.qrSteps.hidden = true;
      dom.qrTimer.hidden = true;
      dom.logoutBtn.hidden = true;
      dom.actionCard.hidden = true;
      return;
    }

    const meta = statusMeta(session);

    dom.panelTitle.textContent = session.sessionId;
    dom.panelSubtitle.textContent = session.isConnected
      ? `Linked as ${session.pushName || 'unknown'}${session.number ? ` (+${session.number})` : ''}`
      : session.lastError || `Status: ${meta.label}`;
    dom.panelBadge.className = `badge ${meta.cls}`;
    dom.panelBadge.innerHTML = `<span class="dot"></span>${meta.label}`;

    // Messaging is only possible once the device is linked.
    dom.actionCard.hidden = !session.isConnected;
    dom.logoutBtn.hidden = false;

    if (session.isConnected) {
      dom.qrFrame.className = 'qr__frame qr__frame--connected';
      dom.qrFrame.innerHTML = `
        <div class="qr__check">
          <span class="tick">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </span>
          <div>WhatsApp is linked and active!</div>
          <small>${esc(session.pushName || 'Device linked')}${session.number ? ' · +' + esc(session.number) : ''}</small>
        </div>`;
      dom.qrSteps.hidden = true;
      dom.qrTimer.hidden = true;
    } else if (session.isScannable && session.qrCode) {
      dom.qrFrame.className = 'qr__frame';
      dom.qrFrame.innerHTML = `<img src="${esc(session.qrCode)}" alt="WhatsApp pairing QR code" />`;
      dom.qrSteps.hidden = false;
      dom.qrTimer.hidden = false;
    } else {
      dom.qrFrame.className = 'qr__frame';
      dom.qrFrame.innerHTML =
        `<p style="color: var(--text-3); font-size: 13px">${session.status === 'CONNECTING' ? 'Starting Chromium engine…' : 'Waiting for a QR code…'}</p>`;
      dom.qrSteps.hidden = true;
      dom.qrTimer.hidden = true;
    }
  }

  function render() {
    renderSessionList();
    renderPanel();
  }

  /** Merge one session view into state (from SSE or a fetch). */
  function upsertSession(session) {
    if (!session || !session.sessionId) return;
    state.sessions.set(session.sessionId, session);
  }

  function removeSession(sessionId) {
    state.sessions.delete(sessionId);
    if (state.activeId === sessionId) {
      state.activeId = state.sessions.size ? [...state.sessions.keys()][0] : null;
    }
  }

  /** Select a session; lazily refresh it so a stale QR is never shown. */
  async function selectSession(sessionId) {
    state.activeId = sessionId;
    render();
    try {
      const { session } = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
      upsertSession(session);
      render();
    } catch {
      /* keep whatever the stream gave us */
    }
  }

  /* --------------------------------------------------------------------- */
  /* Live updates (SSE with polling fallback)                                */
  /* --------------------------------------------------------------------- */

  function setLive(online) {
    dom.livePill.classList.toggle('is-online', online);
    dom.livePill.classList.toggle('is-offline', !online);
    dom.liveText.textContent = online ? 'Live' : 'Reconnecting';
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(refreshSessions, 3000);
  }

  async function refreshSessions() {
    try {
      const { sessions } = await api('/api/sessions');
      sessions.forEach(upsertSession);
      render();
    } catch {
      /* transient — the next tick retries */
    }
  }

  function connectStream() {
    if (state.eventSource) state.eventSource.close();

    const source = new EventSource('/api/events');
    state.eventSource = source;

    source.addEventListener('open', () => {
      setLive(true);
      stopPolling();
    });

    source.addEventListener('snapshot', (event) => {
      const { sessions } = JSON.parse(event.data);
      state.sessions.clear();
      sessions.forEach(upsertSession);
      if (!state.activeId && sessions.length) state.activeId = sessions[0].sessionId;
      render();
    });

    source.addEventListener('session:updated', (event) => {
      const { session } = JSON.parse(event.data);
      upsertSession(session);
      if (!state.activeId) state.activeId = session.sessionId;
      render();
    });

    source.addEventListener('session:deleted', (event) => {
      const { session } = JSON.parse(event.data);
      removeSession(session.sessionId);
      render();
    });

    source.addEventListener('error', () => {
      // EventSource retries on its own, but poll meanwhile so the UI still moves.
      setLive(false);
      startPolling();
    });
  }

  /* --------------------------------------------------------------------- */
  /* Session actions                                                         */
  /* --------------------------------------------------------------------- */

  dom.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sessionId = dom.sessionId.value.trim();

    if (!sessionId) return;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(sessionId)) {
      showResult(dom.createResult, 'err', 'Invalid name', 'Use letters, numbers, dot, dash or underscore.');
      return;
    }

    busy(dom.createBtn, true);
    clearResult(dom.createResult);

    try {
      const data = await api('/api/sessions/create', { method: 'POST', body: { sessionId } });
      upsertSession(data.session);
      state.activeId = sessionId;
      dom.sessionId.value = '';
      render();
      showResult(
        dom.createResult,
        'ok',
        data.created ? 'Session created' : 'Session already existed',
        data.created ? 'Scan the QR code to link this device.' : 'Showing the existing session state.'
      );
    } catch (error) {
      showResult(dom.createResult, 'err', 'Could not create session', error.message);
    } finally {
      busy(dom.createBtn, false);
    }
  });

  dom.sessionList.addEventListener('click', async (event) => {
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    if (deleteId) {
      event.stopPropagation();
      await deleteSession(deleteId);
      return;
    }

    const row = event.target.closest('.session');
    if (row) selectSession(row.dataset.id);
  });

  dom.sessionList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.session');
    if (row) {
      event.preventDefault();
      selectSession(row.dataset.id);
    }
  });

  async function deleteSession(sessionId) {
    if (!confirm(`Log out and destroy session "${sessionId}"?\n\nThe stored credentials are wiped, so the next link requires a fresh QR scan.`)) {
      return;
    }

    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      removeSession(sessionId);
      render();
      toast('ok', `Session "${sessionId}" destroyed`);
    } catch (error) {
      toast('err', error.message);
    }
  }

  dom.logoutBtn.addEventListener('click', () => {
    if (state.activeId) deleteSession(state.activeId);
  });

  /* --------------------------------------------------------------------- */
  /* Toasts (top-level feedback for actions outside a form)                  */
  /* --------------------------------------------------------------------- */

  function toast(kind, message) {
    let host = el('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.style.cssText =
        'position:fixed;bottom:20px;right:20px;z-index:50;display:flex;flex-direction:column;gap:8px;max-width:340px';
      document.body.appendChild(host);
    }

    const node = document.createElement('div');
    node.style.cssText = `padding:11px 15px;border-radius:10px;font-size:13px;font-weight:500;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.22);background:${
      kind === 'err' ? '#c5221f' : '#0f7b42'
    }`;
    node.textContent = message;
    host.appendChild(node);

    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .3s';
      setTimeout(() => node.remove(), 300);
    }, 4000);
  }

  /* --------------------------------------------------------------------- */
  /* Tabs                                                                    */
  /* --------------------------------------------------------------------- */

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
      });
    });
  });

  /* --------------------------------------------------------------------- */
  /* Message forms                                                           */
  /* --------------------------------------------------------------------- */

  /**
   * Guard shared by every send form: refuse early with a clear message instead
   * of letting the server return a 409 about session state.
   */
  function activeSessionOrWarn() {
    const session = state.activeId ? state.sessions.get(state.activeId) : null;

    if (!session) {
      toast('err', 'Select a session first.');
      return null;
    }
    if (!session.isConnected) {
      toast('err', `Session "${session.sessionId}" is not connected yet — scan its QR code first.`);
      return null;
    }
    return session;
  }

  async function submitOtpSend(event) {
    event.preventDefault();
    const session = activeSessionOrWarn();
    if (!session) return;

    const phone = digits(el('otpPhone').value);
    const button = el('otpSendBtn');
    const result = el('otpSendResult');

    busy(button, true);
    clearResult(result);

    try {
      const data = await api('/api/send-otp', {
        method: 'POST',
        body: { sessionId: session.sessionId, phone, appName: el('otpApp').value.trim() },
      });

      const expiresIn = Math.round(state.config.otpTtlMs / 1000);
      showResult(result, 'ok', `Code sent to +${data.phone}`, `Expires in ${expiresIn} seconds.`);

      state.sentOtp = { phone: data.phone, sessionId: session.sessionId, otp: data.otp, expiresAt: data.expiresAt };
      el('verifyPhone').value = data.phone;
      renderOtpBanner();
    } catch (error) {
      showResult(result, 'err', 'Could not send the code', error.message);
    } finally {
      busy(button, false);
    }
  }

  function renderOtpBanner() {
    const banner = el('otpSentBanner');

    if (!state.sentOtp || state.sentOtp.sessionId !== state.activeId) {
      banner.className = 'otp-sent';
      banner.innerHTML = '';
      return;
    }

    const left = Math.max(0, Math.round((state.sentOtp.expiresAt - Date.now()) / 1000));
    if (left <= 0) {
      banner.className = 'otp-sent';
      banner.innerHTML = '<span>⏱ That code has expired — send a new one.</span>';
      return;
    }

    banner.className = 'otp-sent is-visible';
    banner.innerHTML = `<span>📨 Code sent to <b>+${esc(state.sentOtp.phone)}</b> · expires in <b>${left}s</b></span>`;
  }

  async function submitOtpVerify(event) {
    event.preventDefault();
    const session = activeSessionOrWarn();
    if (!session) return;

    const button = el('otpVerifyBtn');
    const result = el('otpVerifyResult');

    busy(button, true);
    clearResult(result);

    try {
      const data = await api('/api/verify-otp', {
        method: 'POST',
        body: {
          sessionId: session.sessionId,
          phone: digits(el('verifyPhone').value),
          otp: el('verifyOtp').value.trim(),
        },
      });

      showResult(result, 'ok', data.message, `+${digits(el('verifyPhone').value)} is verified on ${session.sessionId}.`);
      el('verifyOtp').value = '';
      state.sentOtp = null;
      renderOtpBanner();
    } catch (error) {
      showResult(result, 'err', 'Verification failed', error.message);
    } finally {
      busy(button, false);
    }
  }

  async function submitMessage(event) {
    event.preventDefault();
    const session = activeSessionOrWarn();
    if (!session) return;

    const button = el('messageBtn');
    const result = el('messageResult');

    busy(button, true);
    clearResult(result);

    try {
      const data = await api('/api/send-message', {
        method: 'POST',
        body: { sessionId: session.sessionId, phone: digits(el('msgPhone').value), message: el('msgBody').value },
      });

      showResult(result, 'ok', `Message sent to +${data.phone}`, `${data.characters} characters dispatched.`);
    } catch (error) {
      showResult(result, 'err', 'Could not send the message', error.message);
    } finally {
      busy(button, false);
    }
  }

  async function submitAlert(event) {
    event.preventDefault();
    const session = activeSessionOrWarn();
    if (!session) return;

    const button = el('alertBtn');
    const result = el('alertResult');

    busy(button, true);
    clearResult(result);

    try {
      const data = await api('/api/send-login-alert', {
        method: 'POST',
        body: {
          sessionId: session.sessionId,
          phone: digits(el('alertPhone').value),
          appName: el('alertApp').value.trim(),
          deviceName: el('alertDevice').value.trim(),
          ipAddress: el('alertIp').value.trim(),
          location: el('alertLocation').value.trim(),
        },
      });

      showResult(result, 'ok', `Alert sent to +${data.phone}`, 'The sign-in notification was delivered.');
    } catch (error) {
      showResult(result, 'err', 'Could not send the alert', error.message);
    } finally {
      busy(button, false);
    }
  }

  el('otpSendForm').addEventListener('submit', submitOtpSend);
  el('otpVerifyForm').addEventListener('submit', submitOtpVerify);
  el('messageForm').addEventListener('submit', submitMessage);
  el('alertForm').addEventListener('submit', submitAlert);

  // Live character counter for the free-form composer.
  el('msgBody').addEventListener('input', (event) => {
    el('msgCount').textContent = event.target.value.length;
  });

  // Strip formatting as the user types a phone number.
  ['otpPhone', 'verifyPhone', 'msgPhone', 'alertPhone'].forEach((id) => {
    el(id).addEventListener('input', (event) => {
      const cleaned = digits(event.target.value).slice(0, 15);
      if (cleaned !== event.target.value) event.target.value = cleaned;
    });
  });

  /* --------------------------------------------------------------------- */
  /* Theme + API key                                                         */
  /* --------------------------------------------------------------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('wa.theme', theme);
    dom.themeIcon.innerHTML =
      theme === 'dark'
        ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
        : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  }

  dom.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  dom.apiKeyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.apiKey = dom.apiKey.value.trim();
    localStorage.setItem('wa.apiKey', state.apiKey);

    try {
      const data = await api('/api/config');
      if (data.authRequired) {
        showResult(dom.apiKeyResult, 'err', 'Key rejected', 'Check that it matches GATEWAY_API_KEY.');
        return;
      }
      showResult(dom.apiKeyResult, 'ok', 'Key saved', 'Sending it with every message request.');
      dom.apiKey.value = '';
    } catch (error) {
      showResult(dom.apiKeyResult, 'err', 'Key rejected', error.message);
    }
  });

  /* --------------------------------------------------------------------- */
  /* Boot                                                                    */
  /* --------------------------------------------------------------------- */

  async function boot() {
    applyTheme(localStorage.getItem('wa.theme') || 'light');
    dom.apiKey.value = state.apiKey;

    try {
      const config = await api('/api/config');
      state.config = config;

      if (config.authRequired) {
        dom.apiKeyCard.hidden = false;
        if (!state.apiKey) {
          showResult(dom.apiKeyResult, 'info', 'Gateway key required', 'Message routes reject requests without x-api-key.');
        }
      }
    } catch {
      /* config is optional; health check below will surface real problems */
    }

    await refreshSessions();
    if (!state.activeId && state.sessions.size) state.activeId = [...state.sessions.keys()][0];
    render();
    renderOtpBanner();

    connectStream();

    // Keep the OTP expiry countdown honest even when nothing changes.
    setInterval(renderOtpBanner, 1000);
  }

  boot();
})();
