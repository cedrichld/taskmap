#!/usr/bin/env node
'use strict';
// Headless render of the dashboard: node tests/shots.js <projectId|/path> <WxH> <out.png> [select=<nodeId>] [view=map|graph|orbs|outline] [scope=open|done|all] [mobile=1] [settle=<ms>] [interact=1] [click=<nodeId> clicks=<n> button=right then=<selector>] [js=<expression>] [at=<x,y>]
// Drives Chrome over the DevTools protocol (an open SSE stream keeps --virtual-time-budget from ever settling).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const [PID, SIZE, OUT, ...REST] = process.argv.slice(2);
if (!PID || !SIZE || !OUT) { console.error('usage: shots.js <projectId|/path> <WxH> <out.png> [select=<id>] [view=outline] [scope=open|done|all] [mobile=1] [settle=<ms>]'); process.exit(2); }
const PATHNAME = PID.startsWith('/') ? PID : `/p/${encodeURIComponent(PID)}`;
const opts = Object.fromEntries(REST.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
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
    await send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); // lets then= read what a copy put there
    const mobile = Boolean(opts.mobile && opts.mobile !== '0');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
    if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: `${BASE}${PATHNAME}` });
    await sleep(2000);
    if (opts.scope) { await evaluate(`window.taskmapUI && window.taskmapUI.setScope(${JSON.stringify(opts.scope)}); 'ok'`); await sleep(300); }
    if (opts.view) { await evaluate(`window.taskmapUI && window.taskmapUI.setView(${JSON.stringify(opts.view)}); 'ok'`); await sleep(300); }
    if (opts.select) { await evaluate(`window.taskmapUI && window.taskmapUI.select(${JSON.stringify(opts.select)}); 'ok'`); await sleep(500); }
    if (opts.js) { await evaluate(`(() => { ${opts.js}; return 'ok'; })()`); await sleep(300); } // e.g. js=document.querySelector('#run-pick').click()
    await sleep(Number(opts.settle || 900)); // let the orbs settle and the camera finish its fit
    // click=<id> clicks that task where it is drawn (orb or card) and reports what opened.
    if (opts.click) {
      const at = async () => evaluate(`(() => { const ui = window.taskmapUI; const id = ${JSON.stringify(opts.click)};
        const card = [...document.querySelectorAll('#cardmap .card[data-id="' + id + '"], #outline .card[data-id="' + id + '"]')].find((c) => c.offsetParent);
        if (card && card.offsetParent) { const r = card.getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; }
        const e = ui.scene.entries.get(id); if (!e) return null; const g = document.getElementById('graph').getBoundingClientRect();
        return { x: g.left + e.sx, y: g.top + e.sy }; })()`);
      const count = () => evaluate(`(() => { const ui = window.taskmapUI; return ui.state.view === 'map' ? ui.cm.nodes.length : ui.state.view === 'outline' ? document.querySelectorAll('#outline .row').length : [...ui.scene.entries.values()].filter((e) => !e.gone).length; })()`);
      const clicks = [];
      for (let i = 0; i < Number(opts.clicks || 1); i++) {
        const p = await at();
        if (!p) { clicks.push('not drawn'); break; }
        const before = await count();
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
        const button = opts.button || 'left'; // button=right opens the node's menu
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: 1 });
        await sleep(900);
        const menu = await evaluate(`(() => { const m = document.getElementById('ctx'); return m && !m.hidden ? [...m.querySelectorAll('button')].map((b) => (b.disabled ? '-' : '+') + b.textContent.trim()) : null; })()`);
        clicks.push({ before, after: await count(), selected: await evaluate('window.taskmapUI.state.selected'), ...(menu ? { menu } : {}) });
        // then=<css selector> clicks that element for real afterwards (a menu item, say).
        if (opts.then) {
          const q = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(opts.then)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          if (q) {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 });
            await sleep(200);
            clicks.push({ then: opts.then, clipboard: await evaluate('navigator.clipboard.readText().catch((e) => "(" + e.name + ")")') });
          } else clicks.push({ then: opts.then, missing: true });
        }
      }
      console.log('click: ' + JSON.stringify(clicks));
    }
    // at=x,y clicks that point (empty space, usually) and reports the selection after.
    if (opts.at) {
      const [x, y] = opts.at.split(',').map(Number);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(400);
      console.log('at: ' + JSON.stringify({ selected: await evaluate('window.taskmapUI.state.selected') }));
    }
    // interact=1 drives the graph like a hand would and reports what changed.
    let interaction = null;
    if (opts.interact) {
      const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
      interaction = {};
      const touch = (type, touchPoints) => send('Input.dispatchTouchEvent', { type, touchPoints });
      if (mobile) {
        const yaw0 = await evaluate('window.taskmapUI.scene.cam.yaw');
        await touch('touchStart', [{ x: 60, y: H - 80 }]);
        for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: 60 + i * 20, y: H - 80 - i * 4 }]);
        await touch('touchEnd', []); await sleep(150);
        interaction.touchYawDelta = Number(((await evaluate('window.taskmapUI.scene.cam.yaw')) - yaw0).toFixed(3));
        const dist0 = await evaluate('window.taskmapUI.scene.cam.dist');
        await touch('touchStart', [{ x: W / 2 - 40, y: H - 200 }, { x: W / 2 + 40, y: H - 200 }]);
        for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: W / 2 - 40 - i * 15, y: H - 200 }, { x: W / 2 + 40 + i * 15, y: H - 200 }]);
        await touch('touchEnd', []); await sleep(150);
        interaction.pinchDistBefore = Math.round(dist0);
        interaction.pinchDistAfter = Math.round(await evaluate('window.taskmapUI.scene.cam.dist'));
      }
      const target = mobile ? null : await evaluate(`(() => { const ui = window.taskmapUI; const id = ui.scene.nowId || [...ui.scene.entries.keys()][1]; const el = document.querySelector('.label[data-id="' + id + '"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { id, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (target) {
        await mouse('mouseMoved', target.x, target.y, { button: 'none' }); await sleep(120);
        interaction.hover = await evaluate('window.taskmapUI.state.hover');
        await mouse('mousePressed', target.x, target.y, { clickCount: 1 }); await mouse('mouseReleased', target.x, target.y, { clickCount: 1 }); await sleep(300);
        interaction.clicked = target.id;
        interaction.selected = await evaluate('window.taskmapUI.state.selected');
        interaction.panelTitle = await evaluate(`(document.querySelector('.p-title') || { textContent: '' }).textContent`);
      }
      if (mobile) { console.log('interaction: ' + JSON.stringify(interaction)); interaction = null; }
      const yaw0 = interaction ? await evaluate('window.taskmapUI.scene.cam.yaw') : 0;
      const gx = 60; const gy = H - 60;
      if (!interaction) { /* touch already reported */ } else {
      await mouse('mouseMoved', gx, gy, { button: 'none' }); await mouse('mousePressed', gx, gy, { clickCount: 1 });
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', gx + i * 20, gy - i * 5, {});
      await mouse('mouseReleased', gx + 120, gy - 30, { clickCount: 1 }); await sleep(150);
      interaction.yawDelta = Number(((await evaluate('window.taskmapUI.scene.cam.yaw')) - yaw0).toFixed(3));
      interaction.selectedAfterDrag = await evaluate('window.taskmapUI.state.selected');
      const dist0 = await evaluate('window.taskmapUI.scene.cam.dist');
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: -240 }); await sleep(150);
      interaction.distBefore = Math.round(dist0);
      interaction.distAfterWheel = Math.round(await evaluate('window.taskmapUI.scene.want.dist'));
      interaction.userMoved = await evaluate('window.taskmapUI.state.userMoved');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', text: 'f' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF' }); await sleep(700);
      interaction.userMovedAfterF = await evaluate('window.taskmapUI.state.userMoved');
      interaction.distAfterF = Math.round(await evaluate('window.taskmapUI.scene.want.dist'));
      }
    }
    const info = await evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      const t = (s) => (q(s) || { textContent: '' }).textContent.trim();
      const n = (s) => document.querySelectorAll(s).length;
      const base = {
        page: document.body.classList.contains('overview') ? 'overview' : 'project',
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        tapTargetsUnder44: [...document.querySelectorAll('button, a.ov-hit, .seg button, .bottom-tab')]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) < 44; }).length,
      };
      if (base.page === 'overview') return JSON.stringify({ ...base,
        live: t('#ov-live-text'), cards: n('.ov-card'), liveCards: n('.ov-card.is-live') });
      const ui = window.taskmapUI || { scene: { entries: new Map(), cam: {} }, state: {} };
      const labels = [...document.querySelectorAll('#labels .label')];
      const shown = labels.filter((e) => parseFloat(e.style.opacity || '0') > 0.05);
      const inFrame = (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
      return JSON.stringify({ ...base,
        live: t('#live-text'), scope: ui.state.scope, view: q('#main').className,
        orbs: ui.scene.entries.size, labels: labels.length, labelsShown: shown.length, labelsOffscreen: shown.filter((e) => !inFrame(e)).length,
        rows: n('#outline .row'), doneRows: n('#donelist .dl-row'),
        progress: t('#progress-label'), waiting: n('#waiting-list li'), now: t('#now'),
        cam: { dist: Math.round(ui.scene.cam.dist || 0), R: Math.round(ui.scene.R || 0) },
        main: [q('#main').clientWidth, q('#main').clientHeight],
        clippedReasons: [...document.querySelectorAll('.label .reason')].filter((e) => e.scrollHeight > e.clientHeight + 1).length,
      });
    })()`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
    console.log(`${OUT}: ${info}`);
    if (interaction) console.log('interaction: ' + JSON.stringify(interaction));
    console.log('console: ' + (logs.length ? '\n' + logs.join('\n') : 'clean'));
    ws.close();
  } finally {
    chrome.kill();
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
