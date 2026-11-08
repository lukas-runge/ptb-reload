#!/usr/bin/env node
'use strict';

// Logs the arrival time of every request in PTB time.
// Usage: node test-server.js [port]

const http = require('node:http');

const PORT = Number(process.argv[2]) || 8123;
const PTB_URL = 'wss://uhr.ptb.de/time';
const SAMPLES_PER_SYNC = 10;
const SAMPLE_GAP_MS = 40;
const SYNC_TIMEOUT_MS = 5000;
const RESYNC_INTERVAL_MS = 30000;

const TIME_FORMAT = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
};

let clock = null; // { offsetMs, rttMs }
let requestCount = 0;

// Monotonic, so a system clock correction cannot distort a measurement.
const localNow = () => performance.timeOrigin + performance.now();
const formatTime = (ms) => new Date(ms).toLocaleTimeString('de-DE', TIME_FORMAT);
const formatDelta = (ms) => `${ms >= 0 ? '+' : ''}${ms.toFixed(1).replace('.', ',')} ms`;

function syncWithPtb() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(PTB_URL, 'time');
    let best = null;
    let received = 0;

    const finish = (error) => {
      clearTimeout(timeout);
      socket.close();
      if (best) {
        clock = best;
        resolve();
      } else {
        reject(error);
      }
    };
    const timeout = setTimeout(() => finish(new Error('Zeitüberschreitung')), SYNC_TIMEOUT_MS);

    const sendSample = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ c: performance.now() }));
      }
    };

    socket.onopen = sendSample;
    socket.onerror = () => finish(new Error('keine Verbindung'));
    socket.onmessage = (event) => {
      const receivedAt = performance.now();
      const reply = JSON.parse(event.data);
      const rttMs = receivedAt - reply.c;
      const offsetMs = reply.s - (performance.timeOrigin + receivedAt - rttMs / 2);
      if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs };
      received += 1;
      if (received < SAMPLES_PER_SYNC) setTimeout(sendSample, SAMPLE_GAP_MS);
      else finish();
    };
  });
}

function logRequest(request, arrivalMs) {
  const source = clock ? 'PTB' : 'System';
  const timeMs = arrivalMs + (clock ? clock.offsetMs : 0);
  const deltaMs = timeMs - Math.round(timeMs / 1000) * 1000;
  const accuracy = clock ? `±${Math.ceil(clock.rttMs / 2)} ms` : 'keine PTB-Zeit';
  const cacheControl = request.headers['cache-control'];

  requestCount += 1;
  console.log(
    [
      `#${String(requestCount).padEnd(3)}`,
      `${formatTime(timeMs)} ${source}`,
      `${formatDelta(deltaMs).padStart(10)} zur vollen Sekunde`,
      accuracy,
      `${request.method} ${request.url}`,
      cacheControl ? `Cache-Control: ${cacheControl}` : '',
    ]
      .filter(Boolean)
      .join('  |  '),
  );
  return { timeMs, source };
}

const server = http.createServer((request, response) => {
  const arrivalMs = localNow();
  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  const { timeMs, source } = logRequest(request, arrivalMs);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  response.end(`<!doctype html>
<meta charset="utf-8">
<title>Reload-Test</title>
<body style="font: 32px ui-monospace, Menlo, monospace; margin: 15vh auto; text-align: center">
  <div>Anfrage #${requestCount} am Server</div>
  <div style="font-size: 56px; font-weight: 600">${formatTime(timeMs)}</div>
  <div>${source}</div>
</body>`);
});

function warnSyncFailed(error) {
  const fallback = clock ? 'letzte Messung bleibt aktiv' : 'logge mit Systemuhr';
  console.warn(`PTB-Synchronisation fehlgeschlagen (${error.message}), ${fallback}`);
}

async function start() {
  await syncWithPtb().catch(warnSyncFailed);
  setInterval(() => syncWithPtb().catch(warnSyncFailed), RESYNC_INTERVAL_MS);
  server.listen(PORT, '127.0.0.1', () => {
    if (clock) {
      const macDeviationMs = Date.now() - (localNow() + clock.offsetMs);
      console.log(
        `PTB synchronisiert: Systemuhr weicht ${formatDelta(macDeviationMs)} ab, ±${Math.ceil(clock.rttMs / 2)} ms`,
      );
    }
    console.log(`Testserver läuft: http://127.0.0.1:${PORT}/  (Beenden mit Ctrl+C)\n`);
  });
}

start();
