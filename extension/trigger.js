'use strict';

// Runs inside the target tab so the reload starts in the page's own process.
(() => {
  if (window.__ptbReloadLoaded) return;
  window.__ptbReloadLoaded = true;

  const SPIN_VISIBLE_MS = 300;
  // Firefox can delay timers in hidden tabs by about a second.
  const SPIN_HIDDEN_MS = 2500;
  const TICK_MS = 100;
  const MAX_LATE_MS = 5000;

  const PROBE_COUNT = 4;
  const PROBE_GAP_MS = 120;
  // Late enough to keep the connection warm, early enough to finish before the spin.
  const FINAL_PROBE_BEFORE_MS = 4000;
  const LEAD_SAFETY_MARGIN_MS = 5;
  // Server think time inflates the estimate, so this caps how early a request can arrive.
  const MAX_LEAD_MS = 30;

  let config = null;
  let timer = null;
  let pill = null;
  let label = null;
  let leadMs = 0;
  let serverRttMs = null;
  let probing = false;
  let finalProbeStarted = false;

  const ptbNow = () => Date.now() + config.offsetMs;
  const appliedLeadMs = () => (config.applyLead ? leadMs : 0);
  const fireAtMs = () => config.targetMs - appliedLeadMs();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Arriving too early is far worse than arriving a few ms late, so the lead stays
  // below half the fastest round trip minus every known uncertainty.
  function computeLead(roundTripMs) {
    const ptbUncertaintyMs = config.rttMs / 2;
    const leadEstimateMs = roundTripMs / 2 - ptbUncertaintyMs - LEAD_SAFETY_MARGIN_MS;
    return Math.min(Math.max(leadEstimateMs, 0), MAX_LEAD_MS);
  }

  // The favicon is usually static, which keeps server think time out of the estimate
  // and avoids load on the shop application. The same requests warm up the connection.
  async function probeServer() {
    if (probing) return;
    probing = true;
    const url = `${location.origin}/favicon.ico`;
    const options = cloneInto(
      { method: 'HEAD', cache: 'no-store', credentials: 'include' },
      window,
    );
    let fastestMs = null;
    for (let i = 0; i < PROBE_COUNT; i++) {
      const startedAt = performance.now();
      try {
        await content.fetch(url, options);
        const roundTripMs = performance.now() - startedAt;
        // The first probe may include the connection setup.
        if (i > 0 && (fastestMs === null || roundTripMs < fastestMs)) fastestMs = roundTripMs;
      } catch (_) {
        // Without usable probes the reload simply runs without a lead.
      }
      await sleep(PROBE_GAP_MS);
    }
    probing = false;
    if (config && fastestMs !== null) {
      serverRttMs = fastestMs;
      leadMs = computeLead(fastestMs);
    }
  }

  // Styles are set through CSSOM because a strict page CSP can block inline style sheets.
  function createPill() {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      borderRadius: '8px',
      background: '#1c1b1f',
      color: '#fff',
      font: '13px/1.3 ui-monospace, Menlo, monospace',
      boxShadow: '0 2px 10px rgba(0,0,0,.4)',
    });
    label = document.createElement('span');
    const cancel = document.createElement('button');
    cancel.textContent = 'Abbrechen';
    Object.assign(cancel.style, {
      font: 'inherit',
      color: '#fff',
      background: '#b3261e',
      border: '0',
      borderRadius: '5px',
      padding: '3px 8px',
      cursor: 'pointer',
    });
    cancel.addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'cancel' });
      disarm();
    });
    box.append(label, cancel);
    root.append(box);
    (document.documentElement || document).append(host);
    pill = host;
  }

  function render(remainingMs) {
    const time = new Date(config.targetMs).toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
    const seconds = (Math.max(remainingMs, 0) / 1000).toFixed(1).replace('.', ',');
    const lead = config.applyLead ? ` · Vorlauf ${Math.round(leadMs)} ms` : '';
    label.textContent = `Reload ${time} · noch ${seconds} s · ±${Math.ceil(config.rttMs / 2)} ms${lead}`;
  }

  function disarm() {
    clearTimeout(timer);
    config = null;
    if (pill) pill.remove();
    pill = null;
  }

  function fire() {
    const ptbMs = ptbNow();
    const { hardReload } = config;
    // A hard reload is only available through the tabs API in the background script.
    if (!hardReload) location.reload();
    browser.runtime.sendMessage({
      type: 'fired',
      ptbMs,
      hardReload,
      leadMs: appliedLeadMs(),
      serverRttMs,
    });
    config = null;
  }

  function tick() {
    if (!config) return;
    const remainingMs = fireAtMs() - ptbNow();
    if (config.warmUp && !finalProbeStarted && remainingMs <= FINAL_PROBE_BEFORE_MS) {
      finalProbeStarted = true;
      probeServer();
    }
    if (remainingMs < -MAX_LATE_MS) {
      browser.runtime.sendMessage({ type: 'missed', lateMs: -remainingMs });
      disarm();
      return;
    }
    render(remainingMs);
    const spinMs = document.hidden ? SPIN_HIDDEN_MS : SPIN_VISIBLE_MS;
    if (remainingMs <= spinMs) {
      const fireAt = fireAtMs();
      while (ptbNow() < fireAt);
      fire();
      return;
    }
    timer = setTimeout(tick, Math.min(remainingMs - spinMs, TICK_MS));
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'arm') {
      clearTimeout(timer);
      config = message;
      if (!pill) createPill();
      if (config.warmUp) probeServer();
      tick();
    } else if (message.type === 'clock' && config) {
      config.offsetMs = message.offsetMs;
      config.rttMs = message.rttMs;
    } else if (message.type === 'cancel') {
      disarm();
    }
  });
})();
