#!/usr/bin/env node
'use strict';
// Headless render of the dashboard: node tests/shots.js <projectId> <WxH> <out.png> [select=<nodeId>] [view=outline]
// Drives Chrome over the DevTools protocol (an open SSE stream keeps --virtual-time-budget from ever settling).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const [PID, SIZE, OUT, ...REST] = process.argv.slice(2);
if (!PID || !SIZE || !OUT) { console.error('usage: shots.js <projectId> <WxH> <out.png> [select=<id>] [view=outline]'); process.exit(2); }
const opts = Object.fromEntries(REST.map((a) => a.split('=')));
const [W, H] = SIZE.split('x').map(Number);
const PORT = 9400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${process.env.TASKMAP_PORT || 4242}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reqJson(p, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (resp) => {
      let b = ''; resp.on('data', (d) => (b += d)); resp.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad json')); } });
    });
    r.on('error', rej); r.end();
  });
}
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-chrome-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(100); try { await reqJson('/json/version'); ready = true; } catch (e) { /* wait */ } }
    if (!ready) throw new Error('chrome devtools did not come up');
    const target = await reqJson('/json/new?about:blank', 'PUT');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map(); const logs = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'log') logs.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value !== undefined ? a.value : a.description || '').join(' ')}`);
      else if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.text} ${(m.params.exceptionDetails.exception || {}).description || ''}`);
      else if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`);
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result.result.value;
    };
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${BASE}/?p=${PID}` });
    await sleep(2000);
    if (opts.view) { await evaluate(`document.querySelector('.seg button[data-view="${opts.view}"]').click(); 'ok'`); await sleep(300); }
    if (opts.select) { await evaluate(`document.querySelector('.card[data-id="${opts.select}"]').click(); 'ok'`); await sleep(500); }
    const info = await evaluate(`JSON.stringify({
      live: document.querySelector('#live-text').textContent,
      cards: document.querySelectorAll('#nodes .card').length,
      rows: document.querySelectorAll('#outline .row').length,
      progress: document.querySelector('#progress-label').textContent,
      waiting: document.querySelectorAll('#waiting-list li').length,
      now: (document.querySelector('#now')||{textContent:''}).textContent.trim(),
      transform: document.querySelector('#viewport').getAttribute('transform'),
      main: [document.querySelector('#main').clientWidth, document.querySelector('#main').clientHeight],
      minTitlePx: Math.min(...[...document.querySelectorAll('#nodes .card .title')].map((t) => t.getBoundingClientRect().height)),
      clippedReasons: [...document.querySelectorAll('#nodes .card .reason')].filter((r) => r.scrollHeight > r.clientHeight + 1).length,
      overflowTitles: [...document.querySelectorAll('#nodes .card .title')].filter((r) => r.scrollHeight > r.clientHeight + 1).length,
    })`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
    console.log(`${OUT}: ${info}`);
    console.log('console: ' + (logs.length ? '\n' + logs.join('\n') : 'clean'));
    ws.close();
  } finally {
    chrome.kill();
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
