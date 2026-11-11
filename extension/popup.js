'use strict';

const FORM_STORAGE_KEY = 'ptb-reload-form';
const TIME_FORMAT = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
};

const $ = (id) => document.getElementById(id);
const formatTime = (ms) => new Date(ms).toLocaleTimeString('de-DE', TIME_FORMAT);
const formatDelta = (ms) => `${ms >= 0 ? '+' : ''}${ms.toFixed(1).replace('.', ',')} ms`;

let status = null;
let localError = null;

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function nextFullMinute() {
  const date = new Date(Date.now() + 60000);
  date.setSeconds(0, 0);
  return toLocalInputValue(date);
}

function loadForm() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FORM_STORAGE_KEY)) || {};
  } catch (_) {
    // A missing or damaged draft only means the defaults are used.
  }
  const savedIsFuture = saved.target && new Date(saved.target).getTime() > Date.now();
  $('target').value = savedIsFuture ? saved.target : nextFullMinute();
  $('offset').value = saved.offset ?? 0;
  $('hard').checked = Boolean(saved.hard);
  $('warmup').checked = Boolean(saved.warmUp);
  $('lead').checked = Boolean(saved.applyLead);
  syncOptionAvailability();
}

function syncOptionAvailability() {
  // A hard reload opens a new connection, so a warmed-up one would go unused.
  $('warmup').disabled = $('hard').checked;
  if ($('warmup').disabled) $('warmup').checked = false;
  // The lead is derived from the warm-up measurements.
  $('lead').disabled = !$('warmup').checked;
  if ($('lead').disabled) $('lead').checked = false;
}

function saveForm() {
  try {
    localStorage.setItem(
      FORM_STORAGE_KEY,
      JSON.stringify({
        target: $('target').value,
        offset: $('offset').value,
        hard: $('hard').checked,
        warmUp: $('warmup').checked,
        applyLead: $('lead').checked,
      }),
    );
  } catch (_) {
    // Saving the draft is a convenience and must not block arming.
  }
}

function renderClock() {
  if (!status || !status.clock) return;
  const ptbMs = Date.now() + status.clock.offsetMs;
  $('ptb-time').textContent = formatTime(ptbMs);
  if (status.job && status.job.state === 'armed') {
    $('armed-remaining').textContent = `noch ${formatRemaining(status.job.targetMs - ptbMs)}`;
  }
}

function formatServerRtt(result) {
  const source = result.rttSource === 'handshake' ? 'Verbindungsaufbau' : 'Anfrage';
  return `${Math.round(result.serverRttMs)} ms (${source})`;
}

function renderResult(result) {
  $('result').hidden = !result;
  if (!result) return;
  const probed = result.serverRttMs !== null && result.serverRttMs !== undefined;
  const rows = [
    ['RTT zum Server', probed ? formatServerRtt(result) : undefined],
    ['Vorlauf', probed ? `${Math.round(result.leadMs)} ms` : undefined],
    ['Ausgelöst', formatDelta(result.firedDeltaMs)],
    ['Navigation', result.navigationDeltaMs],
    ['Request gesendet', result.requestDeltaMs],
    ['Erstes Byte', result.firstByteDeltaMs],
    ['Messunsicherheit', `±${Math.ceil(result.rttMs / 2)} ms`],
  ];
  const list = $('result-list');
  list.replaceChildren();
  $('result-list').previousElementSibling.textContent =
    `Letzter Reload (Soll ${formatTime(result.targetMs)})`;
  for (const [name, value] of rows) {
    if (value === undefined) continue;
    const term = document.createElement('dt');
    term.textContent = name;
    const detail = document.createElement('dd');
    detail.textContent = typeof value === 'number' ? formatDelta(value) : value;
    list.append(term, detail);
  }
}

function render() {
  const { clock, job, lastResult, lastError } = status;
  if (clock) {
    const accuracy = Math.ceil(clock.rttMs / 2);
    $('clock-info').textContent =
      `PTB-Zeit · Systemuhr weicht ${formatDelta(-clock.offsetMs)} ab · ±${accuracy} ms`;
  }
  $('form').hidden = Boolean(job);
  $('armed').hidden = !job;
  if (job) {
    const fired = job.state === 'fired';
    $('armed-title').textContent = fired ? 'Ausgelöst' : 'Scharf';
    $('armed-time').textContent = formatTime(job.targetMs);
    // A busy server can take a while; the result appears once the page has loaded.
    if (fired) $('armed-remaining').textContent = 'Warte, bis die Seite geladen ist …';
  }
  const error = localError || lastError;
  $('error').hidden = !error;
  $('error').textContent = error || '';
  renderResult(lastResult);
  renderClock();
}

$('form').addEventListener('input', () => {
  syncOptionAvailability();
  saveForm();
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  saveForm();
  localError = null;
  const targetMs = new Date($('target').value).getTime() + Number($('offset').value || 0);
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await browser.runtime.sendMessage({
      type: 'arm',
      tabId: tab.id,
      targetMs,
      hardReload: $('hard').checked,
      warmUp: $('warmup').checked,
      applyLead: $('lead').checked,
    });
  } catch (error) {
    localError = error.message;
    render();
  }
});

$('cancel').addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'cancel' });
});

browser.runtime.connect({ name: 'popup' }).onMessage.addListener((next) => {
  status = next;
  render();
});

loadForm();
setInterval(renderClock, 47);
