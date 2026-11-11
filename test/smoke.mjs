// Loads the extension into headless Firefox and checks real reloads against a local server.
// Needs network access to uhr.ptb.de.
//
// GECKODRIVER          path to geckodriver (default: geckodriver in PATH)
// FIREFOX_BIN          path to Firefox (default: the macOS app, otherwise firefox in PATH)
// POPUP_SCREENSHOT     if set, saves a screenshot of the popup to this path

import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url));
const ADDON_ID = JSON.parse(
  fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'),
).browser_specific_settings.gecko.id;
const ADDON_UUID = '11111111-2222-4333-8444-555555555555';
const MARIONETTE_PORT = 2831;
const WEBDRIVER_PORT = 4457;
const MAC_FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const FIREFOX = process.env.FIREFOX_BIN || (fs.existsSync(MAC_FIREFOX) ? MAC_FIREFOX : 'firefox');
const GECKODRIVER = process.env.GECKODRIVER || 'geckodriver';
const MAX_TRIGGER_ERROR_MS = 50;
const LEAD_TIME_MS = 7000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pageLoads = 0;
let probes = 0;
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') pageLoads += 1;
  // Firefox's own favicon request has the destination "image", the warm-up "empty".
  else if (request.headers['sec-fetch-dest'] === 'empty') probes += 1;
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
  response.end('<!doctype html><title>smoke</title><h1>smoke</h1>');
});

async function webdriver(method, url, body) {
  const response = await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}${url}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
  const { value } = await response.json();
  if (value && value.error) throw new Error(`${value.error}: ${value.message}`);
  return value;
}

// Firefox can restart itself on first launch, so the session may need a few attempts.
async function createSession() {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await webdriver('POST', '/session', { capabilities: { alwaysMatch: {} } })).sessionId;
    } catch (error) {
      if (attempt >= 40) throw error;
      await sleep(1000);
    }
  }
}

function startFirefox(profile) {
  fs.writeFileSync(
    path.join(profile, 'user.js'),
    [
      `user_pref("marionette.port", ${MARIONETTE_PORT});`,
      'user_pref("app.update.enabled", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("layout.css.devPixelsPerPx", "2");',
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: ADDON_UUID }))});`,
    ].join('\n'),
  );
  spawn(FIREFOX, ['--marionette', '--remote-allow-system-access', '-no-remote', '-profile', profile], {
    stdio: 'ignore',
    env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ptb-reload-smoke-'));
  startFirefox(profile);
  const driver = spawn(
    GECKODRIVER,
    ['--port', String(WEBDRIVER_PORT), '--connect-existing', '--marionette-port', String(MARIONETTE_PORT)],
    { stdio: 'ignore' },
  );

  try {
    await sleep(3000);
    const session = `/session/${await createSession()}`;
    const run = (script, args = []) => webdriver('POST', `${session}/execute/sync`, { script, args });
    const runAsync = (script, args = []) =>
      webdriver('POST', `${session}/execute/async`, { script, args });
    const switchTo = (handle) => webdriver('POST', `${session}/window`, { handle });

    await webdriver('POST', `${session}/moz/addon/install`, { path: EXTENSION_DIR, temporary: true });
    await webdriver('POST', `${session}/url`, { url: pageUrl });
    const pageTab = await webdriver('GET', `${session}/window`);
    const popupTab = (await webdriver('POST', `${session}/window/new`, { type: 'tab' })).handle;

    // WebDriver refuses moz-extension:// URLs from content context.
    await switchTo(popupTab);
    await webdriver('POST', `${session}/moz/context`, { context: 'chrome' });
    await run(
      `window.gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });`,
      [`moz-extension://${ADDON_UUID}/popup.html`],
    );
    await webdriver('POST', `${session}/moz/context`, { context: 'content' });

    let ptbTime = '';
    for (let i = 0; i < 40 && !/^\d\d:\d\d:\d\d,\d{3}$/.test(ptbTime); i++) {
      await sleep(250);
      ptbTime = await run('return document.getElementById("ptb-time").textContent');
    }
    assert.match(ptbTime, /^\d\d:\d\d:\d\d,\d{3}$/, 'Popup zeigt keine PTB-Zeit');
    console.log(`ok  Popup zeigt PTB-Zeit (${ptbTime})`);

    const tabId = await runAsync(
      `const done = arguments[arguments.length - 1];
       browser.tabs.query({ url: "http://127.0.0.1/*" }).then((tabs) => done(tabs[0].id));`,
    );
    const send = (message) =>
      runAsync(
        `const done = arguments[arguments.length - 1];
         browser.runtime.sendMessage(arguments[0]).then(() => done("ok"), (e) => done(e.message));`,
        [message],
      );

    const nextTarget = () => Math.ceil((Date.now() + LEAD_TIME_MS) / 1000) * 1000;
    const readResult = () =>
      run(`return Object.fromEntries([...document.querySelectorAll("#result-list dt")]
        .map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));`);
    const parseMs = (text) => Number(text.replace(',', '.').replace(/[^\d.+-]/g, ''));

    async function reloadOnce(name, options) {
      await switchTo(popupTab);
      const before = pageLoads;
      const probesBefore = probes;
      const previous = JSON.stringify(await readResult());
      const targetMs = nextTarget();
      assert.equal(await send({ type: 'arm', tabId, targetMs, ...options }), 'ok');
      await sleep(300);
      const remaining = await run('return document.getElementById("armed-remaining").textContent');
      assert.match(remaining, /^noch \d,\d Sekunden$/, `${name}: Countdown im Popup fehlt`);
      await switchTo(pageTab);
      await sleep(targetMs - Date.now() + 800);
      await switchTo(popupTab);

      let result = await readResult();
      for (let i = 0; i < 40 && JSON.stringify(result) === previous; i++) {
        await sleep(250);
        result = await readResult();
      }
      assert.equal(pageLoads - before, 1, `${name}: erwartet genau einen Reload`);
      assert.equal(probes - probesBefore, options.warmUp ? 1 : 0, `${name}: Anzahl Testanfragen`);
      const errorMs = parseMs(result['Ausgelöst']);
      assert.ok(
        Math.abs(errorMs) <= MAX_TRIGGER_ERROR_MS,
        `${name}: Auslösung um ${errorMs} ms daneben`,
      );
      console.log(`ok  ${name}: ausgelöst ${result['Ausgelöst']}`);
      return result;
    }

    await reloadOnce('Reload zum Zeitpunkt', {});
    const warmed = await reloadOnce('Reload mit Vorwärmen', { warmUp: true });
    assert.match(warmed['RTT zum Server'] || '', /^\d+ ms \(/, 'Vorwärmen hat keine RTT gemessen');
    await reloadOnce('Hard-Reload', { hardReload: true });

    assert.match(
      await send({ type: 'arm', tabId, targetMs: Date.now() - 1000 }),
      /mindestens 3 Sekunden/,
    );
    console.log('ok  Zeitpunkt in der Vergangenheit wird abgelehnt');

    const before = pageLoads;
    const cancelledTarget = nextTarget();
    assert.equal(await send({ type: 'arm', tabId, targetMs: cancelledTarget }), 'ok');
    assert.equal(await send({ type: 'cancel' }), 'ok');
    await sleep(cancelledTarget - Date.now() + 800);
    assert.equal(pageLoads, before, 'Abbrechen hat den Reload nicht verhindert');
    console.log('ok  Abbrechen verhindert den Reload');

    if (process.env.POPUP_SCREENSHOT) {
      await webdriver('POST', `${session}/window/rect`, { width: 700, height: 1300 });
      const body = await webdriver('POST', `${session}/element`, {
        using: 'css selector',
        value: 'body',
      });
      const elementId = Object.values(body)[0];
      const png = await webdriver('GET', `${session}/element/${elementId}/screenshot`);
      fs.writeFileSync(process.env.POPUP_SCREENSHOT, Buffer.from(png, 'base64'));
    }
    await webdriver('DELETE', session).catch(() => {});
  } finally {
    driver.kill();
    try {
      execSync(`pkill -f ${JSON.stringify(profile)}`);
    } catch {
      // Firefox may already be gone.
    }
    fs.rmSync(profile, { recursive: true, force: true });
    server.closeAllConnections();
    server.close();
  }
}

main().catch((error) => {
  console.error(`FEHLER  ${error.message}`);
  process.exitCode = 1;
});
