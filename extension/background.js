'use strict';

// Protocol as used by https://uhr.ptb.de/uhr.js: send {c}, receive {c, s, e, l}.
// c = client value echoed back, s = PTB UTC in epoch ms, e = server uncertainty in ms.
const WS_URL = 'wss://uhr.ptb.de/time';
const WS_PROTOCOL = 'time';

const SAMPLES_PER_BURST = 8;
const SAMPLE_GAP_MS = 40;
const SAMPLE_TIMEOUT_MS = 2000;
const RESYNC_INTERVAL_MS = 60000;
const FINAL_SYNCS_BEFORE_MS = [20000, 5000];
const MAX_CLOCK_AGE_AT_ARM_MS = 10000;
const MIN_LEAD_MS = 3000;
const KEEP_BETTER_SAMPLE_MAX_AGE_MS = 120000;

let socket = null;
let socketOpening = null;
let pendingSample = null;
let burstInFlight = null;

let clock = null; // { offsetMs, rttMs, serverErrorMs, syncedAt }
let job = null; // { tabId, targetMs, hardReload, state, firedPtbMs, timers }
let lastResult = null;
let lastError = null;

const popupPorts = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ptbNow = () => Date.now() + clock.offsetMs;

function openSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketOpening) return socketOpening;
  socketOpening = new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, WS_PROTOCOL);
    ws.onopen = () => {
      socket = ws;
      socketOpening = null;
      resolve(ws);
    };
    ws.onerror = () => {
      socketOpening = null;
      reject(new Error('Verbindung zu uhr.ptb.de fehlgeschlagen'));
    };
    ws.onmessage = onSocketMessage;
    ws.onclose = () => {
      if (socket === ws) socket = null;
    };
  });
  return socketOpening;
}

function closeSocket() {
  if (socket) socket.close();
  socket = null;
}

function onSocketMessage(event) {
  const receivedPerf = performance.now();
  const receivedWall = Date.now();
  if (!pendingSample) return;
  const { resolve, timer } = pendingSample;
  pendingSample = null;
  clearTimeout(timer);
  const reply = JSON.parse(event.data);
  const rttMs = receivedPerf - reply.c;
  resolve({
    offsetMs: reply.s - (receivedWall - rttMs / 2),
    rttMs,
    serverErrorMs: reply.e,
  });
}

function requestSample(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSample = null;
      reject(new Error('Keine Antwort von uhr.ptb.de'));
    }, SAMPLE_TIMEOUT_MS);
    pendingSample = { resolve, timer };
    ws.send(JSON.stringify({ c: performance.now() }));
  });
}

// The sample with the shortest round trip has the smallest possible path asymmetry.
async function runBurst() {
  const ws = await openSocket();
  let best = null;
  for (let i = 0; i < SAMPLES_PER_BURST; i++) {
    try {
      const sample = await requestSample(ws);
      if (!best || sample.rttMs < best.rttMs) best = sample;
    } catch (_) {
      // A single lost sample is covered by the rest of the burst.
    }
    await sleep(SAMPLE_GAP_MS);
  }
  if (!best) throw new Error('Keine Antwort von uhr.ptb.de');
  adoptSample(best);
}

// A short network spike must not replace a recent, clearly better measurement.
function adoptSample(sample) {
  const now = Date.now();
  const previousStillBetter =
    clock &&
    now - clock.syncedAt < KEEP_BETTER_SAMPLE_MAX_AGE_MS &&
    sample.rttMs > clock.rttMs * 1.5 + 5;
  if (previousStillBetter) return;
  clock = { ...sample, syncedAt: now };
}

function syncClock() {
  if (!burstInFlight) {
    burstInFlight = runBurst()
      .then(() => {
        lastError = null;
        pushClockToTab();
      })
      .catch((error) => {
        lastError = error.message;
        throw error;
      })
      .finally(() => {
        burstInFlight = null;
        publishStatus();
      });
  }
  return burstInFlight;
}

const syncClockInBackground = () => syncClock().catch(() => {});

function clockPayload() {
  return { offsetMs: clock.offsetMs, rttMs: clock.rttMs };
}

function pushClockToTab() {
  if (!job || job.state !== 'armed') return;
  browser.tabs
    .sendMessage(job.tabId, { type: 'clock', ...clockPayload() })
    .catch(() => {});
}

function sendJobToTab() {
  return browser.tabs.sendMessage(job.tabId, {
    type: 'arm',
    targetMs: job.targetMs,
    hardReload: job.hardReload,
    warmUp: job.warmUp,
    applyLead: job.applyLead,
    ...clockPayload(),
  });
}

async function injectTrigger(tabId) {
  await browser.tabs.executeScript(tabId, { file: 'trigger.js', runAt: 'document_start' });
}

function scheduleJobSyncs() {
  const timers = [setInterval(syncClockInBackground, RESYNC_INTERVAL_MS)];
  for (const beforeMs of FINAL_SYNCS_BEFORE_MS) {
    const delayMs = job.targetMs - ptbNow() - beforeMs;
    if (delayMs > 0) timers.push(setTimeout(syncClockInBackground, delayMs));
  }
  job.timers = timers;
}

async function armJob({ tabId, targetMs, hardReload, warmUp, applyLead }) {
  if (job) throw new Error('Es ist bereits ein Reload geplant');
  if (!Number.isFinite(targetMs)) throw new Error('Ungültiger Zeitpunkt');
  if (!clock || Date.now() - clock.syncedAt > MAX_CLOCK_AGE_AT_ARM_MS) await syncClock();
  if (targetMs - ptbNow() < MIN_LEAD_MS) {
    throw new Error('Zeitpunkt muss mindestens 3 Sekunden in der Zukunft liegen');
  }
  await injectTrigger(tabId);
  job = {
    tabId,
    targetMs,
    hardReload: Boolean(hardReload),
    warmUp: Boolean(warmUp),
    applyLead: Boolean(applyLead),
    state: 'armed',
    timers: [],
  };
  await sendJobToTab();
  scheduleJobSyncs();
  browser.browserAction.setBadgeText({ text: 'ON' });
  publishStatus();
}

function clearJob() {
  if (!job) return;
  job.timers.forEach((id) => {
    clearTimeout(id);
    clearInterval(id);
  });
  job = null;
  browser.browserAction.setBadgeText({ text: '' });
  if (popupPorts.size === 0) closeSocket();
  publishStatus();
}

function cancelJob() {
  if (!job) return;
  if (job.state === 'armed') {
    browser.tabs.sendMessage(job.tabId, { type: 'cancel' }).catch(() => {});
  }
  clearJob();
}

function onFired(message, tabId) {
  if (!job || job.tabId !== tabId || job.state !== 'armed') return;
  job.state = 'fired';
  job.firedPtbMs = message.ptbMs;
  job.leadMs = message.leadMs;
  job.serverRttMs = message.serverRttMs;
  if (message.hardReload) browser.tabs.reload(tabId, { bypassCache: true });
  publishStatus();
}

function onMissed(message, tabId) {
  if (!job || job.tabId !== tabId) return;
  lastError = `Zeitpunkt um ${Math.round(message.lateMs / 1000)} s verpasst, kein Reload (Computer im Ruhezustand?)`;
  clearJob();
}

const READ_NAVIGATION_TIMING = `(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return { timeOrigin: performance.timeOrigin, requestStart: n.requestStart, responseStart: n.responseStart };
})();`;

async function collectResult() {
  const { tabId, targetMs, firedPtbMs, leadMs, serverRttMs } = job;
  const result = {
    targetMs,
    firedDeltaMs: firedPtbMs - targetMs,
    rttMs: clock.rttMs,
    leadMs,
    serverRttMs,
  };
  try {
    const [timing] = await browser.tabs.executeScript(tabId, { code: READ_NAVIGATION_TIMING });
    const startPtbMs = timing.timeOrigin + clock.offsetMs;
    result.navigationStartPtbMs = startPtbMs;
    result.navigationDeltaMs = startPtbMs - targetMs;
    result.requestDeltaMs = startPtbMs + timing.requestStart - targetMs;
    result.firstByteDeltaMs = startPtbMs + timing.responseStart - targetMs;
  } catch (_) {
    // The new page may not allow injection. The trigger time is still valid.
  }
  lastResult = result;
  clearJob();
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!job || tabId !== job.tabId || changeInfo.status !== 'complete') return;
  if (job.state === 'fired') {
    collectResult();
  } else {
    // The user navigated the armed tab, which removed the injected trigger.
    injectTrigger(tabId).then(sendJobToTab).catch((error) => {
      lastError = `Tab konnte nicht erneut vorbereitet werden: ${error.message}`;
      clearJob();
    });
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (job && tabId === job.tabId) clearJob();
});

function statusPayload() {
  return {
    clock,
    job: job && {
      tabId: job.tabId,
      targetMs: job.targetMs,
      hardReload: job.hardReload,
      state: job.state,
    },
    lastResult,
    lastError,
  };
}

function publishStatus() {
  const status = statusPayload();
  popupPorts.forEach((port) => port.postMessage(status));
}

browser.runtime.onConnect.addListener((port) => {
  popupPorts.add(port);
  port.postMessage(statusPayload());
  syncClockInBackground();
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    if (popupPorts.size === 0 && !job) closeSocket();
  });
});

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message.type) {
    case 'arm':
      return armJob(message);
    case 'cancel':
      cancelJob();
      return Promise.resolve();
    case 'fired':
      onFired(message, sender.tab.id);
      return undefined;
    case 'missed':
      onMissed(message, sender.tab.id);
      return undefined;
    default:
      return undefined;
  }
});

browser.browserAction.setBadgeBackgroundColor({ color: '#b3261e' });
