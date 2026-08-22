'use strict';
// cli.js — the taskmap command line. Output is terse: a language model reads it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const store = require('./store');
const { UserError } = store;

const BOOL_FLAGS = new Set(['track', 'open', 'all', 'peek', 'json', 'force', 'batch', 'ensure', 'stop', 'restart', 'foreground', 'help', 'version', 'quiet']);
const LIST_FLAGS = new Set(['link', 'unlink']);

const GLYPH = { pending: '[ ]', in_progress: '[~]', done: '[x]', blocked: '[!]', skipped: '[-]' };
const COLOR = { done: '2', in_progress: '34', blocked: '31', skipped: '2' };

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor && code ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (s) => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write(`warn: ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      let name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val;
      if (eq > 0) val = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(name)) val = true;
      else {
        val = argv[i + 1];
        if (val === undefined) throw new UserError(`--${name} needs a value.`);
        i += 1;
      }
      name = name.replace(/-/g, '_');
      if (LIST_FLAGS.has(name)) (flags[name] = flags[name] || []).push(val);
      else flags[name] = val;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function usage() {
  return [
    'taskmap <command> [args]   (state: <project>/.taskmap/, dashboard: ' + store.baseUrl() + ')',
    '  init "<name>" --goal "<one sentence>" [--track]',
    '  add "<title>" --parent <id> [--what ..] [--why ..] [--done-when ..] [--link <id>].. [--after <id>] [--source user]',
    '  add --batch < items.json      [{key, parent, title, what, why, done_when, links}]',
    '  start <id> | done <id> [--note ".."] | block <id> --reason ".." | skip <id> --reason ".." | reopen <id>',
    '  edit <id> [--title|--what|--why|--done-when|--parent|--order|--link|--unlink ..] [--force]',
    '  note <id> "<text>"',
    '  tree [--open|--all] [--depth N] | show <id> | next | inbox [--peek] | status | check [--json]',
    '  serve [--ensure|--stop|--restart|--foreground] [--port N] | open | watch | demo | forget <project id>',
    '  export --obsidian <dir>       one markdown note per node with [[wikilinks]]',
    '  config [prompt-reminder on|off]',
    '  hook session-start|stop|prompt   (used by hooks/hooks.json)',
    'global: --project <id> (or TASKMAP_PROJECT), TASKMAP_PORT, TASKMAP_HOME',
  ].join('\n');
}

// ---------- project helpers ----------

function projectDir(flags) {
  return store.requireProjectDir({ cwd: process.cwd(), id: flags.project || process.env.TASKMAP_PROJECT });
}

function loadMap(flags) {
  const dir = projectDir(flags);
  return { dir, map: store.readMap(dir) };
}

function doMutate(flags, fn) {
  const dir = projectDir(flags);
  const r = store.mutate(dir, 'cli', fn);
  for (const w of r.warnings) warn(w);
  return r;
}

function nodeId(pos, i = 0, what = 'node id') {
  const id = pos[i];
  if (!id) throw new UserError(`missing ${what}. Run 'taskmap tree' to list ids.`);
  return id;
}

function readStdinJson() {
  if (process.stdin.isTTY) throw new UserError('--batch reads a JSON array from stdin: taskmap add --batch < items.json');
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf8');
  } catch (e) {
    throw new UserError('could not read stdin.');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UserError('--batch expects a JSON array on stdin: [{key, parent, title, what, why, done_when, links}].');
  }
}

// ---------- rendering ----------

function nodeLine(map, n, level, hasKids) {
  const glyph = paint(COLOR[n.status], GLYPH[n.status] || '[?]');
  let s = '  '.repeat(level) + glyph + ' ' + n.id + '  ' + n.title;
  if (n.source === 'user') s += ' *';
  if (hasKids) {
    const p = store.progress(map, n.id);
    s += `  (${p.done}/${p.total})`;
  }
  const u = store.unreadOf(n);
  if (u) s += paint('33', `  (${u} unread)`);
  if (n.status === 'blocked') s += paint('31', `  blocked: ${n.status_reason || ''}`);
  if (n.status === 'skipped') s += paint('2', `  skipped: ${n.status_reason || ''}`);
  return s;
}

function headerLine(map) {
  const p = store.progress(map);
  return `${map.name}  ${p.done}/${p.total} leaves done  ${store.inProgressNodes(map).length} in progress  ${store.unreadCount(map)} unread`;
}

function renderTree(map, { open = true, depth = Infinity } = {}) {
  const lines = [headerLine(map)];
  const visit = (id, level) => {
    const n = map.nodes[id];
    if (!n) return;
    const kids = store.children(map, id);
    lines.push(nodeLine(map, n, level, kids.length > 0));
    if (!kids.length || level + 1 > depth) return;
    if (open && store.isClosed(map, id)) return;
    for (const k of kids) visit(k.id, level + 1);
  };
  visit(map.root, 0);
  return lines;
}

function renderShow(map, n) {
  const lines = [`${n.id}  ${n.title}  [${n.status}]${n.status_reason ? '  ' + n.status_reason : ''}${n.source === 'user' ? '  (added by user)' : ''}`];
  const meta = [`parent: ${n.parent === null ? 'none' : n.parent}`, `order: ${n.order}`, `source: ${n.source}`];
  if (n.links && n.links.length) meta.push(`links: ${n.links.join(', ')}`);
  const kids = store.children(map, n.id);
  if (kids.length) {
    const p = store.progress(map, n.id);
    meta.push(`children: ${kids.map((k) => k.id).join(', ')} (${p.done}/${p.total} leaves done)`);
  }
  lines.push(meta.join('  '));
  for (const f of ['what', 'why', 'done_when']) if (n[f]) lines.push(`${f}: ${n[f]}`);
  if (n.notes && n.notes.length) {
    lines.push('notes:');
    for (const x of n.notes) lines.push(`  ${x.ts}  ${x.text}`);
  }
  if (n.feedback && n.feedback.length) {
    lines.push('feedback:');
    for (const f of n.feedback) lines.push(`  ${f.ts}  ${f.read ? 'read' : 'unread'}  ${f.text}`);
  }
  const times = [`created ${n.created}`];
  if (n.started_at) times.push(`started ${n.started_at}`);
  if (n.finished_at) times.push(`finished ${n.finished_at}`);
  lines.push(times.join('  '));
  return lines;
}

function inboxLines(map) {
  const lines = [];
  const ids = [];
  const nodes = Object.values(map.nodes).sort((a, b) => store.idNum(a.id) - store.idNum(b.id));
  for (const n of nodes) {
    let any = false;
    for (const f of n.feedback || []) {
      if (f.read) continue;
      any = true;
      const kind = f.kind || 'feedback';
      const text = String(f.text || '').replace(/\s+/g, ' ').trim();
      lines.push(kind === 'feedback' ? `${n.id} "${n.title}": ${text}` : `${n.id} "${n.title}" ${text}`);
    }
    if (any) ids.push(n.id);
  }
  return { lines, ids };
}

function statusLine(map) {
  const p = store.progress(map);
  const ip = store.inProgressNodes(map);
  const ipText = ip.length ? ip.map((n) => `${n.id} ${n.title}`).join('; ') : 'none';
  return `${map.name}  ${p.done}/${p.total} leaves done  in progress: ${ipText}  ${store.unreadCount(map)} unread  ${store.projectUrl(map.id)}`;
}

// ---------- server control ----------

function health(timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get(`${store.baseUrl()}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          finish(j && j.ok && j.app === 'taskmap' ? j : null);
        } catch (e) {
          finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
  });
}

async function ensureServer({ quiet = false, waitMs = 3000 } = {}) {
  const url = store.baseUrl();
  if (await health()) {
    if (!quiet) out(`server running at ${url}`);
    return true;
  }
  const home = store.home();
  fs.mkdirSync(home, { recursive: true });
  const logFd = fs.openSync(path.join(home, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: home,
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(logFd);
  try {
    fs.writeFileSync(path.join(home, 'server.pid'), `${child.pid}\n`);
  } catch (e) {
    // not fatal
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (await health(400)) {
      if (!quiet) out(`server started at ${url}`);
      return true;
    }
  }
  if (!quiet) warn(`server did not answer at ${url}; see ${path.join(home, 'server.log')}`);
  return false;
}

async function stopServer() {
  const pidFile = path.join(store.home(), 'server.pid');
  const h = await health();
  let pid = h && h.pid;
  if (!pid) {
    try {
      pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    } catch (e) {
      pid = null;
    }
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      pid = null;
    }
  }
  const deadline = Date.now() + 2500;
  while (pid && Date.now() < deadline && (await health(300))) await sleep(100);
  try {
    fs.unlinkSync(pidFile);
  } catch (e) {
    // already gone
  }
  out(pid ? 'server stopped' : 'server not running');
}

// ---------- commands ----------

async function cmdInit({ pos, flags }) {
  const cwd = process.cwd();
  if (store.hasMap(cwd)) {
    out(statusLine(store.readMap(cwd)));
    return;
  }
  const name = pos[0];
  if (!name) throw new UserError('init needs a name: taskmap init "<name>" --goal "<one sentence>"');
  if (!flags.goal) throw new UserError('init needs --goal "<one sentence>".');
  const map = store.initProject(cwd, { name, goal: flags.goal, track: Boolean(flags.track) });
  await ensureServer({ quiet: true });
  out(`n0  ${map.name}  ${store.projectUrl(map.id)}`);
}

function cmdAdd({ pos, flags }) {
  if (flags.batch) {
    const items = readStdinJson();
    const r = doMutate(flags, (map, ctx) => store.addBatch(map, ctx, items, { source: flags.source === 'user' ? 'user' : 'claude', force: Boolean(flags.force) }));
    for (const { key, id } of r.result) out(`${key} -> ${id}`);
    return;
  }
  const title = pos[0];
  if (!flags.parent) throw new UserError('add needs --parent <id> (use n0 for a top-level milestone).');
  const r = doMutate(flags, (map, ctx) =>
    store.newNode(map, ctx, {
      parent: flags.parent,
      title,
      what: flags.what,
      why: flags.why,
      done_when: flags.done_when,
      links: flags.link || [],
      after: flags.after || null,
      source: flags.source === 'user' ? 'user' : 'claude',
      force: Boolean(flags.force),
    })
  );
  out(r.result.id);
}

function cmdSetStatus(status, { pos, flags }) {
  const id = nodeId(pos);
  doMutate(flags, (map, ctx) => store.setStatus(map, ctx, id, status, { reason: flags.reason, note: flags.note }));
  out(id);
}

function cmdEdit({ pos, flags }) {
  const id = nodeId(pos);
  const changes = {};
  for (const f of ['title', 'what', 'why', 'done_when', 'parent', 'order', 'link', 'unlink']) if (flags[f] !== undefined) changes[f] = flags[f];
  changes.force = Boolean(flags.force);
  doMutate(flags, (map, ctx) => store.editNode(map, ctx, id, changes));
  out(id);
}

function cmdNote({ pos, flags }) {
  const id = nodeId(pos);
  const text = pos.slice(1).join(' ');
  doMutate(flags, (map, ctx) => store.addNote(map, ctx, id, text));
  out(id);
}

function cmdTree({ flags }) {
  const { map } = loadMap(flags);
  const depth = flags.depth !== undefined ? parseInt(flags.depth, 10) : Infinity;
  if (!(depth >= 0)) throw new UserError('--depth expects a non-negative integer.');
  for (const line of renderTree(map, { open: !flags.all, depth })) out(line);
}

function cmdShow({ pos, flags }) {
  const { map } = loadMap(flags);
  const n = store.getNode(map, nodeId(pos));
  for (const line of renderShow(map, n)) out(line);
}

function cmdNext({ flags }) {
  const { map } = loadMap(flags);
  const r = store.nextActionable(map);
  if (!r.id) {
    out(`none  ${r.none}`);
    return;
  }
  const n = map.nodes[r.id];
  out(`${n.id}  ${n.title}`);
  if (n.what) out(`what: ${n.what}`);
  if (n.done_when) out(`done_when: ${n.done_when}`);
  if (n.links && n.links.length) out(`links: ${n.links.join(', ')}`);
  const ip = store.inProgressNodes(map).filter((x) => store.isLeaf(map, x.id));
  if (ip.length) out(`also in_progress: ${ip.map((x) => x.id).join(', ')}`);
}

function cmdInbox({ flags }) {
  const { map } = loadMap(flags);
  const { lines, ids } = inboxLines(map);
  if (!lines.length) {
    out('inbox empty');
    return;
  }
  for (const l of lines) out(l);
  if (!flags.peek) doMutate(flags, (m, ctx) => store.markRead(m, ctx, ids));
}

function cmdStatus({ flags }) {
  const { map } = loadMap(flags);
  out(statusLine(map));
}

function cmdCheck({ flags }) {
  let dir = null;
  try {
    dir = store.resolveProjectDir({ cwd: process.cwd(), id: flags.project || process.env.TASKMAP_PROJECT });
  } catch (e) {
    dir = null;
  }
  if (!dir) {
    out(flags.json ? '{"map":false}' : 'no map');
    return;
  }
  const map = store.readMap(dir);
  const ip = store.inProgressNodes(map).map((n) => ({ id: n.id, title: n.title, leaf: store.isLeaf(map, n.id) }));
  const unread = store.unreadCount(map);
  if (flags.json) {
    out(JSON.stringify({ map: true, id: map.id, name: map.name, in_progress: ip, unread }));
    return;
  }
  if (!ip.length) out('in_progress: none');
  for (const n of ip) out(`in_progress: ${n.id}  ${n.title}${n.leaf ? '  (leaf)' : ''}`);
  out(`unread: ${unread}`);
}

async function cmdServe({ flags }) {
  if (flags.stop) return stopServer();
  if (flags.restart) {
    await stopServer();
    return ensureServer();
  }
  if (flags.foreground) {
    const server = require('./server');
    const srv = server.start({ port: store.port() });
    try {
      fs.mkdirSync(store.home(), { recursive: true });
      fs.writeFileSync(path.join(store.home(), 'server.pid'), `${process.pid}\n`);
    } catch (e) {
      // not fatal
    }
    out(`serving ${store.baseUrl()} (Ctrl-C to stop)`);
    return new Promise(() => srv);
  }
  return ensureServer();
}

async function cmdOpen({ flags }) {
  let url = store.baseUrl();
  try {
    const { map } = loadMap(flags);
    url = store.projectUrl(map.id);
  } catch (e) {
    // no project here: open the dashboard root
  }
  await ensureServer({ quiet: true });
  try {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (e) {
    // fall through: the URL is printed either way
  }
  out(url);
}

function cmdWatch() {
  require('./watch').watch({ cwd: process.cwd() });
  return new Promise(() => {});
}

async function cmdDemo() {
  const src = path.join(__dirname, '..', 'examples', 'demo-map.json');
  const map = JSON.parse(fs.readFileSync(src, 'utf8'));
  const dir = path.join(store.home(), 'demo');
  delete map.id; // derived from the install path so repeated runs reuse the id
  const installed = store.installMap(dir, map);
  await ensureServer({ quiet: true });
  out(store.projectUrl(installed.id));
}

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const text = fs.readFileSync(0, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    return {};
  }
}

// ---------- hooks (stdin: the hook's JSON; stdout: what Claude sees) ----------

function readConfig() {
  try {
    const c = store.readJson(path.join(store.home(), 'config.json'), {});
    return c && typeof c === 'object' ? c : {};
  } catch (e) {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(store.home(), { recursive: true });
  store.writeJsonAtomic(path.join(store.home(), 'config.json'), cfg);
}

function resolveQuiet(cwd, flags) {
  try {
    return store.resolveProjectDir({ cwd, id: flags.project || process.env.TASKMAP_PROJECT });
  } catch (e) {
    return null;
  }
}

// SessionStart: plain stdout reaches Claude's context. Fires with source "compact"
// after compaction, which is where the plan gets re-injected (PostCompact output does not reach Claude).
async function hookSessionStart(input, cwd, flags) {
  try {
    await ensureServer({ quiet: true, waitMs: 1500 });
  } catch (e) {
    // the dashboard is optional; never fail the session
  }
  const dir = resolveQuiet(cwd, flags);
  if (!dir) return;
  const map = store.readMap(dir);
  const p = store.progress(map);
  const ip = store.inProgressNodes(map);
  const unread = store.unreadCount(map);
  if (input.source === 'compact') {
    let lines = renderTree(map, { open: true });
    for (const depth of [3, 2, 1]) {
      if (lines.join('\n').length <= 9000) break; // hook output is capped at 10,000 characters
      lines = renderTree(map, { open: true, depth });
    }
    out(`[taskmap] Context was compacted. The map for "${map.name}" is the plan (taskmap tree --open):`);
    for (const l of lines) out(l);
    if (ip.length) out(`[taskmap] In progress: ${ip.map((n) => `${n.id} ${n.title}`).join('; ')}.`);
    if (unread) out(`[taskmap] ${unread} unread user event(s); taskmap inbox lists them.`);
    out('[taskmap] The next actionable node comes from taskmap next.');
    return;
  }
  out(`[taskmap] Map found: ${map.name}, ${p.done}/${p.total} done, ${ip.length} in progress, ${unread} unread. Run /taskmap to resume.`);
}

// Stop: block once while a leaf is still in progress; stop_hook_active is the loop guard.
function hookStop(input, cwd, flags) {
  if (input.stop_hook_active) return;
  const dir = resolveQuiet(cwd, flags);
  if (!dir) return;
  const map = store.readMap(dir);
  const leaves = store.inProgressNodes(map).filter((n) => store.isLeaf(map, n.id));
  if (!leaves.length) return;
  const list = leaves.map((n) => `${n.id} "${n.title}"`).join(', ');
  out(JSON.stringify({
    decision: 'block',
    reason: `taskmap: ${list} is still in_progress on the map. Close it out before ending the turn: taskmap done <id> --note "<decision; where the code lives>" if it is finished, taskmap block <id> --reason "waiting on user: <question>" if it waits on the user, or taskmap reopen <id> plus taskmap note <id> "<where you stopped>". Then taskmap note n0 "State: ... Next: ...".`,
  }));
}

// UserPromptSubmit: off unless ~/.taskmap/config.json has prompt_reminder: true.
function hookPrompt(input, cwd, flags) {
  if (!readConfig().prompt_reminder) return;
  const prompt = String(input.prompt || '');
  if (prompt.length <= 400 || /^\s*\//.test(prompt)) return;
  const dir = resolveQuiet(cwd, flags);
  if (dir) {
    const map = store.readMap(dir);
    if (store.inProgressNodes(map).some((n) => store.isLeaf(map, n.id))) return;
  }
  out(`[taskmap] Long prompt (${prompt.length} chars) and no node in progress${dir ? ' on the map' : ' (no map here yet)'}. If this is multi-step work, the /taskmap skill applies: plan on the map before writing code.`);
}

async function cmdHook({ pos, flags }) {
  const which = pos[1];
  const input = readHookInput();
  const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  try {
    if (which === 'session-start') return await hookSessionStart(input, cwd, flags);
    if (which === 'stop') return hookStop(input, cwd, flags);
    if (which === 'prompt') return hookPrompt(input, cwd, flags);
  } catch (e) {
    return; // a hook must never break the session
  }
  throw new UserError(`unknown hook "${which}". Use: hook session-start|stop|prompt`);
}

function cmdConfig({ pos }) {
  const key = pos[0];
  const value = pos[1];
  const cfg = readConfig();
  if (!key) {
    out(JSON.stringify(cfg));
    return;
  }
  if (key === 'prompt-reminder') {
    if (value !== 'on' && value !== 'off') throw new UserError('config prompt-reminder on|off');
    cfg.prompt_reminder = value === 'on';
    writeConfig(cfg);
    out(`prompt-reminder ${value}`);
    return;
  }
  throw new UserError(`unknown config key "${key}". Keys: prompt-reminder`);
}

// ---------- export ----------

function noteName(n) {
  const clean = String(n.title).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${n.id} ${clean}`;
}

function cmdExport({ flags }) {
  const dest = flags.obsidian;
  if (!dest) throw new UserError('export needs --obsidian <dir>.');
  const { map } = loadMap(flags);
  fs.mkdirSync(dest, { recursive: true });
  const link = (id) => (map.nodes[id] ? `[[${noteName(map.nodes[id])}]]` : id);
  const yaml = (s) => JSON.stringify(String(s === null || s === undefined ? '' : s));
  let count = 0;
  for (const n of Object.values(map.nodes)) {
    const kids = store.children(map, n.id);
    const dependents = Object.values(map.nodes).filter((o) => (o.links || []).includes(n.id));
    const lines = [
      '---',
      `id: ${n.id}`,
      `title: ${yaml(n.title)}`,
      `status: ${n.status}`,
      `parent: ${n.parent === null ? 'null' : n.parent}`,
      `source: ${n.source}`,
      `created: ${n.created}`,
      `updated: ${n.updated}`,
      `project: ${yaml(map.name)}`,
      'tags: [taskmap]',
      '---',
      `# ${n.title}`,
      '',
      `**Status:** ${n.status}${n.status_reason ? ` — ${n.status_reason}` : ''}  `,
      n.parent ? `**Parent:** ${link(n.parent)}  ` : `**Goal:** ${map.goal}  `,
    ];
    if (kids.length) lines.push(`**Children:** ${kids.map((k) => link(k.id)).join(', ')}  `);
    if (n.links && n.links.length) lines.push(`**Depends on:** ${n.links.map(link).join(', ')}  `);
    if (dependents.length) lines.push(`**Needed by:** ${dependents.map((d) => link(d.id)).join(', ')}  `);
    for (const [label, key] of [['What', 'what'], ['Why', 'why'], ['Done when', 'done_when']]) if (n[key]) lines.push('', `## ${label}`, '', n[key]);
    if (n.notes && n.notes.length) {
      lines.push('', '## Notes', '');
      for (const x of n.notes) lines.push(`- ${x.ts} — ${x.text}`);
    }
    if (n.feedback && n.feedback.length) {
      lines.push('', '## Feedback', '');
      for (const f of n.feedback) lines.push(`- ${f.ts} — ${f.text}${f.read ? '' : ' (unread)'}`);
    }
    fs.writeFileSync(path.join(dest, `${noteName(n)}.md`), lines.join('\n') + '\n');
    count += 1;
  }
  out(`${count} notes -> ${dest}`);
}

// ---------- dispatch ----------

async function run(argv) {
  const { pos, flags } = parseArgs(argv);
  if (flags.port !== undefined) process.env.TASKMAP_PORT = String(flags.port);
  const cmd = pos[0];
  const args = { pos: pos.slice(1), flags };
  if (flags.version) return out(store.VERSION);
  if (!cmd || flags.help || cmd === 'help') return out(usage());
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'add':
      return cmdAdd(args);
    case 'start':
      return cmdSetStatus('in_progress', args);
    case 'done':
      return cmdSetStatus('done', args);
    case 'block':
      return cmdSetStatus('blocked', args);
    case 'skip':
      return cmdSetStatus('skipped', args);
    case 'reopen':
      return cmdSetStatus('pending', args);
    case 'edit':
      return cmdEdit(args);
    case 'note':
      return cmdNote(args);
    case 'tree':
      return cmdTree(args);
    case 'show':
      return cmdShow(args);
    case 'next':
      return cmdNext(args);
    case 'inbox':
      return cmdInbox(args);
    case 'status':
      return cmdStatus(args);
    case 'check':
      return cmdCheck(args);
    case 'serve':
      return cmdServe(args);
    case 'open':
      return cmdOpen(args);
    case 'watch':
      return cmdWatch(args);
    case 'demo':
      return cmdDemo(args);
    case 'forget': {
      const id = args.pos[0];
      if (!id) throw new UserError('forget needs a project id (see the dashboard switcher or ~/.taskmap/registry.json).');
      if (!store.unregisterProject(id)) throw new UserError(`unknown project id "${id}".`);
      return out(id);
    }
    case 'hook':
      return cmdHook({ pos, flags });
    case 'config':
      return cmdConfig(args);
    case 'export':
      return cmdExport(args);
    default:
      throw new UserError(`unknown command "${cmd}". Run 'taskmap help'.`);
  }
}

function main(argv) {
  // `taskmap tree | head` must not crash: a closed pipe just ends the output.
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
  });
  run(argv).catch((e) => {
    if (e instanceof UserError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exitCode = e.exit || 1;
    } else if (e && e.code === 'ENOENT' && /map\.json/.test(String(e.message))) {
      process.stderr.write('error: no taskmap here. Run: taskmap init "<name>" --goal "<one sentence>"\n');
      process.exitCode = 1;
    } else {
      process.stderr.write(`error: ${(e && e.stack) || e}\n`);
      process.exitCode = 2;
    }
  });
}

module.exports = { main, run, parseArgs, renderTree, renderShow, statusLine, inboxLines, ensureServer, health };
