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

  // The warm-up request starts at a random moment in this window before the target:
  // late enough that the connection is still open, early enough to finish before the spin.
  const WARM_UP_EARLIEST_MS = 6000;
  const WARM_UP_LATEST_MS = 3500;
  // A slow server must not leave a request hanging into the reload.
  const PROBE_TIMEOUT_MS = 1500;
  // Only with a lead and without a clean handshake measurement.
  const EXTRA_PROBES = 2;
  const EXTRA_PROBE_GAP_MS = [150, 400];
  const MAX_PROBE_BYTES = 100000;
  const STATIC_FILE = /\.(css|js|png|svg|ico|gif|jpe?g|webp|avif|woff2?)$/i;
  const LEAD_SAFETY_MARGIN_MS = 5;
  // Server think time can inflate the estimate, so this caps how early a request can arrive.
  const MAX_LEAD_MS = 30;

  let config = null;
  let timer = null;
  let pill = null;
  let label = null;
  let leadMs = 0;
  let warmUpAtMs = 0;
  let warmUpStarted = false;
  // Fastest round trips seen so far. The network path never gets faster under load,
  // so the minimum is the estimate least affected by a busy server.
  let handshakeRttMs = null;
  let requestRttMs = null;

  const ptbNow = () => Date.now() + config.offsetMs;
  const appliedLeadMs = () => (config.applyLead ? leadMs : 0);
  const fireAtMs = () => config.targetMs - appliedLeadMs();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const minOf = (current, next) => (current === null || next < current ? next : current);
  const bestRttMs = () =>
    handshakeRttMs === null ? requestRttMs : minOf(requestRttMs, handshakeRttMs);
  const rttSource = () =>
    handshakeRttMs !== null && handshakeRttMs === bestRttMs() ? 'handshake' : 'request';

  // Arriving too early is far worse than arriving a few ms late, so the lead stays
  // below half the fastest round trip minus every known uncertainty.
  function computeLead(roundTripMs) {
    const ptbUncertaintyMs = config.rttMs / 2;
    const leadEstimateMs = roundTripMs / 2 - ptbUncertaintyMs - LEAD_SAFETY_MARGIN_MS;
    return Math.min(Math.max(leadEstimateMs, 0), MAX_LEAD_MS);
  }

  function updateLead() {
    const rtt = bestRttMs();
    if (config && rtt !== null) leadMs = computeLead(rtt);
  }

  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === location.origin;
    } catch (_) {
      return false;
    }
  };

  // The TCP handshake is answered by the operating system or the load balancer, not by
  // the shop application, so it measures the network without server think time.
  // A QUIC handshake (HTTP/3) is skipped: it includes the TLS handshake and sometimes an
  // extra round trip, which would overestimate the network and fire too early.
  function handshakeOf(entry) {
    if (!entry || !(entry.connectEnd > entry.connectStart)) return null;
    if (entry.nextHopProtocol === 'h3') return null;
    let tcpEnd;
    if (entry.secureConnectionStart === 0) tcpEnd = entry.connectEnd; // plain HTTP
    else if (entry.secureConnectionStart > entry.connectStart) tcpEnd = entry.secureConnectionStart;
    else return null; // TCP and TLS cannot be told apart
    const rtt = tcpEnd - entry.connectStart;
    return rtt > 0 ? rtt : null;
  }

  // Connections the page already opened, at no cost of extra requests.
  function collectPassiveHandshakes() {
    const entries = [
      ...performance.getEntriesByType('navigation'),
      ...performance.getEntriesByType('resource').filter((entry) => sameOrigin(entry.name)),
    ];
    for (const entry of entries) {
      const rtt = handshakeOf(entry);
      if (rtt !== null) handshakeRttMs = minOf(handshakeRttMs, rtt);
    }
  }

  // A small static file the page loaded anyway looks like a normal revalidation.
  function probeUrl() {
    const candidates = performance
      .getEntriesByType('resource')
      .filter((entry) => {
        if (!sameOrigin(entry.name) || !STATIC_FILE.test(new URL(entry.name).pathname)) return false;
        return entry.encodedBodySize > 0 && entry.encodedBodySize <= MAX_PROBE_BYTES;
      })
      .sort((a, b) => a.encodedBodySize - b.encodedBodySize);
    return candidates.length ? candidates[0].name : `${location.origin}/favicon.ico`;
  }

  // One conditional GET on the page's own connection pool. Never throws, never hangs.
  async function probe(url, startedCold) {
    const before = performance.getEntriesByName(url, 'resource').length;
    const startedAt = performance.now();
    const request = content
      .fetch(url, cloneInto({ cache: 'no-cache' }, window))
      .then((response) => response.arrayBuffer())
      .then(
        () => true,
        () => false,
      );
    const timeout = sleep(PROBE_TIMEOUT_MS).then(() => false);
    if (!(await Promise.race([request, timeout]))) return;
    const wallRttMs = performance.now() - startedAt;
    await sleep(0);
    const entries = performance.getEntriesByName(url, 'resource');
    const entry = entries.length > before ? entries[entries.length - 1] : null;
    if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
      const handshake = handshakeOf(entry);
      if (handshake !== null) handshakeRttMs = minOf(handshakeRttMs, handshake);
      requestRttMs = minOf(requestRttMs, entry.responseStart - entry.requestStart);
    } else if (!startedCold) {
      // Without timing details the wall time may include a new connection's setup.
      requestRttMs = minOf(requestRttMs, wallRttMs);
    }
    updateLead();
  }

  async function warmUp() {
    const url = probeUrl();
    await probe(url, true);
    // A lead needs a clean round trip. Without a handshake measurement, take the
    // fastest of a few requests, as long as they finish well before the spin.
    for (let i = 0; i < EXTRA_PROBES && config && config.applyLead && handshakeRttMs === null; i++) {
      await sleep(randomBetween(...EXTRA_PROBE_GAP_MS));
      if (!config || fireAtMs() - ptbNow() < SPIN_HIDDEN_MS + PROBE_TIMEOUT_MS) return;
      await probe(url, false);
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
    const lead = config.applyLead ? ` · Vorlauf ${Math.round(leadMs)} ms` : '';
    label.textContent =
      `Reload ${time} · noch ${formatRemaining(remainingMs)} · ±${Math.ceil(config.rttMs / 2)} ms${lead}`;
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
      serverRttMs: config.warmUp ? bestRttMs() : null,
      rttSource: rttSource(),
    });
    config = null;
  }

  function tick() {
    if (!config) return;
    const remainingMs = fireAtMs() - ptbNow();
    if (config.warmUp && !warmUpStarted && config.targetMs - ptbNow() <= warmUpAtMs) {
      warmUpStarted = true;
      warmUp();
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
      // A second arming on the same page, for example after a cancel, starts fresh.
      warmUpStarted = false;
      warmUpAtMs = randomBetween(WARM_UP_LATEST_MS, WARM_UP_EARLIEST_MS);
      leadMs = 0;
      collectPassiveHandshakes();
      updateLead();
      if (!pill) createPill();
      tick();
    } else if (message.type === 'clock' && config) {
      config.offsetMs = message.offsetMs;
      config.rttMs = message.rttMs;
    } else if (message.type === 'cancel') {
      disarm();
    }
  });
})();
