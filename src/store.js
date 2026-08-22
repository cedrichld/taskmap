'use strict';
// store.js — the only module that reads and writes map.json, log.jsonl,
// inbox.jsonl and ~/.taskmap/registry.json. See docs/SPEC.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA = 1;
const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];
const MAX_DEPTH = 3;
const TITLE_WORDS_WARN = 8;
const VERSION = require('../.claude-plugin/plugin.json').version || '0.0.0';

class UserError extends Error {
  constructor(message, exit = 1) {
    super(message);
    this.exit = exit;
  }
}

// ---------- small helpers ----------

function now() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function home() {
  return process.env.TASKMAP_HOME || path.join(os.homedir(), '.taskmap');
}

function port() {
  const p = parseInt(process.env.TASKMAP_PORT || '', 10);
  return Number.isFinite(p) && p > 0 ? p : 4242;
}

function baseUrl() {
  return `http://127.0.0.1:${port()}`;
}

function projectUrl(id) {
  return `${baseUrl()}/?p=${encodeURIComponent(id)}`;
}

function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

function projectIdFor(name, dir) {
  const hash = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 6);
  return `${slug(name)}-${hash}`;
}

function idNum(id) {
  return parseInt(String(id).slice(1), 10) || 0;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

// Write temp file in the same directory, fsync, rename over the target.
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// O_EXCL lock file with backoff; a lock older than staleMs is removed.
function withLock(lockPath, fn, { timeoutMs = 10000, staleMs = 5000 } = {}) {
  const start = Date.now();
  let delay = 5;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new UserError(`${path.basename(lockPath)} is held by another process. Retry, or delete ${lockPath} if nothing is running.`);
      }
      sleepSync(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 100);
      continue;
    }
    try {
      fs.writeSync(fd, `${process.pid} ${now()}\n`);
    } catch (e) {
      // ignore: the lock exists, that is what matters
    }
    fs.closeSync(fd);
    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {
        // already gone
      }
    }
  }
}

// ---------- registry ----------

function registryFile() {
  return path.join(home(), 'registry.json');
}

function readRegistry() {
  const r = readJson(registryFile(), null);
  if (!r || typeof r !== 'object' || typeof r.projects !== 'object' || !r.projects) {
    return { schema: SCHEMA, projects: {} };
  }
  return r;
}

function updateRegistry(fn) {
  fs.mkdirSync(home(), { recursive: true });
  return withLock(path.join(home(), 'registry.lock'), () => {
    const reg = readRegistry();
    const result = fn(reg);
    writeJsonAtomic(registryFile(), reg);
    return result;
  });
}

function registerProject({ id, name, path: projectPath }) {
  updateRegistry((reg) => {
    const prev = reg.projects[id] || {};
    reg.projects[id] = { id, name, path: projectPath, updated: now(), created: prev.created || now() };
  });
}

function touchRegistry(id, name) {
  try {
    updateRegistry((reg) => {
      if (!reg.projects[id]) return;
      reg.projects[id].updated = now();
      if (name) reg.projects[id].name = name;
    });
  } catch (e) {
    // best effort
  }
}

function unregisterProject(id) {
  return updateRegistry((reg) => {
    if (!reg.projects[id]) return false;
    delete reg.projects[id];
    return true;
  });
}

function listProjects() {
  return Object.values(readRegistry().projects)
    .map((p) => ({ ...p, exists: fs.existsSync(mapFile(p.path)) }))
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

function projectById(id) {
  return readRegistry().projects[id] || null;
}

// ---------- project resolution ----------

function dataDir(projectDir) {
  return path.join(projectDir, '.taskmap');
}

function mapFile(projectDir) {
  return path.join(dataDir(projectDir), 'map.json');
}

function hasMap(projectDir) {
  return fs.existsSync(mapFile(projectDir));
}

function findProjectDir(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (hasMap(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Subagents run in linked worktrees that do not contain the untracked .taskmap/.
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const m = out.match(/^worktree (.+)$/m);
    if (m && hasMap(m[1])) return m[1];
  } catch (e) {
    // not a git repo, or git missing
  }
  return null;
}

function resolveProjectDir({ cwd = process.cwd(), id = process.env.TASKMAP_PROJECT } = {}) {
  if (id) {
    const p = projectById(id);
    if (!p) throw new UserError(`unknown project id "${id}". Check ~/.taskmap/registry.json or run 'taskmap init'.`);
    if (!hasMap(p.path)) throw new UserError(`project "${id}" points at ${p.path} but there is no .taskmap/map.json there.`);
    return p.path;
  }
  return findProjectDir(cwd);
}

function requireProjectDir(opts) {
  const dir = resolveProjectDir(opts);
  if (!dir) throw new UserError('no taskmap here. Run: taskmap init "<name>" --goal "<one sentence>"');
  return dir;
}

// ---------- map files ----------

function readMap(projectDir) {
  const file = mapFile(projectDir);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    sleepSync(25); // a rename may be mid-flight on a non-POSIX filesystem
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}

function statMap(projectDir) {
  try {
    const st = fs.statSync(mapFile(projectDir));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return null;
  }
}

function readLog(projectDir, limit = 100) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dataDir(projectDir), 'log.jsonl'), 'utf8');
  } catch (e) {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const tail = limit ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // skip a torn line
    }
  }
  return out;
}

function appendLines(file, actor, ts, events) {
  if (!events.length) return;
  const text = events.map((e) => JSON.stringify({ ts, actor, ...e })).join('\n') + '\n';
  fs.appendFileSync(file, text);
}

function createMap({ id, name, goal, ts = now() }) {
  return {
    schema: SCHEMA,
    id,
    name,
    goal,
    root: 'n0',
    created: ts,
    updated: ts,
    version: 1,
    next_id: 1,
    nodes: {
      n0: {
        id: 'n0',
        parent: null,
        order: 0,
        title: name,
        what: goal,
        why: '',
        done_when: '',
        status: 'pending',
        status_reason: null,
        source: 'claude',
        links: [],
        notes: [],
        feedback: [],
        created: ts,
        updated: ts,
        started_at: null,
        finished_at: null,
      },
    },
  };
}

function gitignoreAdd(projectDir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch (e) {
    return false; // not a git work tree: nothing to do
  }
  const file = path.join(projectDir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    text = '';
  }
  if (text.split('\n').some((l) => l.trim() === '.taskmap/' || l.trim() === '.taskmap')) return false;
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + '.taskmap/\n');
  return true;
}

// Create .taskmap/ with a root node. Returns the map. Throws if it exists.
function initProject(projectDir, { name, goal, track = false }) {
  name = String(name || '').trim();
  goal = String(goal || '').trim();
  if (!name) throw new UserError('init needs a name: taskmap init "<name>" --goal "<one sentence>"');
  if (hasMap(projectDir)) throw new UserError('a map already exists here.');
  const dir = dataDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const ts = now();
  const id = projectIdFor(name, projectDir);
  const map = createMap({ id, name, goal, ts });
  writeJsonAtomic(mapFile(projectDir), map);
  for (const f of ['log.jsonl', 'inbox.jsonl']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
  appendLines(path.join(dir, 'log.jsonl'), 'cli', ts, [{ type: 'init', node: 'n0', detail: { name, goal } }]);
  if (!track) gitignoreAdd(projectDir);
  registerProject({ id, name, path: projectDir });
  return map;
}

// Install a complete map (demo). Rewrites log/inbox from the map's history.
function installMap(projectDir, map) {
  const dir = dataDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  map.schema = SCHEMA;
  map.id = map.id || projectIdFor(map.name, projectDir);
  if (!map.next_id) map.next_id = Math.max(0, ...Object.keys(map.nodes).map(idNum)) + 1;
  map.version = map.version || 1;
  map.updated = map.updated || now();
  writeJsonAtomic(mapFile(projectDir), map);
  const log = [];
  const inbox = [];
  const verb = { in_progress: 'start', done: 'done', blocked: 'block', skipped: 'skip' };
  for (const n of Object.values(map.nodes)) {
    if (n.id === map.root) log.push({ ts: n.created, actor: 'cli', type: 'init', node: n.id, detail: { name: map.name, goal: map.goal } });
    else {
      const userAdded = n.source === 'user';
      log.push({ ts: n.created, actor: userAdded ? 'ui' : 'cli', type: 'add', node: n.id, detail: { title: n.title, parent: n.parent, source: n.source } });
      if (userAdded) inbox.push({ ts: n.created, actor: 'ui', type: 'node_added', node: n.id, title: n.title, parent: n.parent });
    }
    if (n.started_at) log.push({ ts: n.started_at, actor: 'cli', type: 'start', node: n.id, detail: { from: 'pending', to: 'in_progress' } });
    if (n.status !== 'pending' && n.status !== 'in_progress') {
      const ts = n.finished_at || n.updated || n.created;
      log.push({ ts, actor: 'cli', type: verb[n.status], node: n.id, detail: { from: n.started_at ? 'in_progress' : 'pending', to: n.status, ...(n.status_reason ? { reason: n.status_reason } : {}) } });
    }
    for (const note of n.notes || []) log.push({ ts: note.ts, actor: 'cli', type: 'note', node: n.id, detail: { text: note.text } });
    for (const f of n.feedback || []) {
      if ((f.kind || 'feedback') !== 'feedback') continue;
      log.push({ ts: f.ts, actor: 'ui', type: 'feedback', node: n.id, detail: { text: f.text } });
      inbox.push({ ts: f.ts, actor: 'ui', type: 'feedback', node: n.id, title: n.title, text: f.text });
    }
  }
  log.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  inbox.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  fs.writeFileSync(path.join(dir, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + (log.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'inbox.jsonl'), inbox.map((l) => JSON.stringify(l)).join('\n') + (inbox.length ? '\n' : ''));
  registerProject({ id: map.id, name: map.name, path: projectDir });
  return map;
}

// The one write path. fn(map, ctx) mutates the map and returns a result.
function mutate(projectDir, actor, fn) {
  const dir = dataDir(projectDir);
  const out = withLock(path.join(dir, 'map.lock'), () => {
    const map = readMap(projectDir);
    const ctx = { now: now(), actor, events: [], inbox: [], touched: new Set(), warnings: [] };
    const result = fn(map, ctx);
    map.version = (map.version || 0) + 1;
    map.updated = ctx.now;
    for (const id of ctx.touched) if (map.nodes[id]) map.nodes[id].updated = ctx.now;
    writeJsonAtomic(mapFile(projectDir), map);
    appendLines(path.join(dir, 'log.jsonl'), actor, ctx.now, ctx.events);
    appendLines(path.join(dir, 'inbox.jsonl'), actor, ctx.now, ctx.inbox);
    return { result, map, warnings: ctx.warnings };
  });
  touchRegistry(out.map.id, out.map.name);
  return out;
}

// ---------- queries (pure) ----------

function getNode(map, id) {
  const n = map.nodes[id];
  if (!n) throw new UserError(`unknown node ${id}. Run 'taskmap tree --all' to list ids.`);
  return n;
}

function children(map, id) {
  return Object.values(map.nodes)
    .filter((n) => n.parent === id)
    .sort((a, b) => a.order - b.order || idNum(a.id) - idNum(b.id));
}

function isLeaf(map, id) {
  return id !== map.root && children(map, id).length === 0;
}

function depthOf(map, id) {
  let d = 0;
  let n = map.nodes[id];
  const seen = new Set();
  while (n && n.parent !== null && n.parent !== undefined && !seen.has(n.id)) {
    seen.add(n.id);
    d += 1;
    n = map.nodes[n.parent];
  }
  return d;
}

function height(map, id) {
  const kids = children(map, id);
  if (!kids.length) return 0;
  return 1 + Math.max(...kids.map((k) => height(map, k.id)));
}

function ancestors(map, id) {
  const out = [];
  let n = map.nodes[id];
  const seen = new Set();
  while (n && n.parent !== null && n.parent !== undefined && !seen.has(n.id)) {
    seen.add(n.id);
    out.push(n.parent);
    n = map.nodes[n.parent];
  }
  return out;
}

function descendants(map, id) {
  const out = [];
  const walk = (x) => {
    for (const k of children(map, x)) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

function effectivelySkipped(map, id) {
  if (map.nodes[id] && map.nodes[id].status === 'skipped') return true;
  return ancestors(map, id).some((a) => map.nodes[a] && map.nodes[a].status === 'skipped');
}

function blockedOrSkippedAbove(map, id) {
  return ancestors(map, id).some((a) => map.nodes[a] && (map.nodes[a].status === 'skipped' || map.nodes[a].status === 'blocked'));
}

function leavesUnder(map, id) {
  return descendants(map, id).filter((n) => isLeaf(map, n.id));
}

function progress(map, id = map.root) {
  const leaves = leavesUnder(map, id);
  let done = 0;
  let skipped = 0;
  for (const l of leaves) {
    if (effectivelySkipped(map, l.id)) skipped += 1;
    else if (l.status === 'done') done += 1;
  }
  return { done, total: leaves.length - skipped, skipped, leaves: leaves.length };
}

function isClosed(map, id) {
  const n = map.nodes[id];
  if (!n || (n.status !== 'done' && n.status !== 'skipped')) return false;
  return descendants(map, id).every((d) => d.status === 'done' || d.status === 'skipped');
}

function unreadOf(node) {
  return (node.feedback || []).filter((f) => !f.read).length;
}

function unreadCount(map) {
  return Object.values(map.nodes).reduce((s, n) => s + unreadOf(n), 0);
}

function inProgressNodes(map) {
  return Object.values(map.nodes)
    .filter((n) => n.status === 'in_progress' && n.id !== map.root)
    .sort((a, b) => idNum(a.id) - idNum(b.id));
}

function blockedNodes(map) {
  return Object.values(map.nodes)
    .filter((n) => n.status === 'blocked' && n.id !== map.root)
    .sort((a, b) => idNum(a.id) - idNum(b.id));
}

function statusCounts(map) {
  const c = { pending: 0, in_progress: 0, done: 0, blocked: 0, skipped: 0 };
  for (const n of Object.values(map.nodes)) if (n.id !== map.root && c[n.status] !== undefined) c[n.status] += 1;
  return c;
}

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

// First pending leaf in depth-first order whose links are all done/skipped.
function nextActionable(map) {
  const waiting = [];
  const blocked = [];
  let leafCount = 0;
  const visit = (id) => {
    const n = map.nodes[id];
    if (!n) return null;
    if (id !== map.root && (n.status === 'blocked' || n.status === 'skipped')) {
      if (n.status === 'blocked') blocked.push(id);
      return null;
    }
    const kids = children(map, id);
    if (!kids.length) {
      if (id === map.root) return null;
      leafCount += 1;
      if (n.status !== 'pending') return null;
      const unmet = (n.links || []).filter((l) => {
        const t = map.nodes[l];
        return t && t.status !== 'done' && t.status !== 'skipped';
      });
      if (unmet.length) {
        waiting.push({ id, on: unmet[0], status: map.nodes[unmet[0]].status });
        return null;
      }
      return id;
    }
    for (const k of kids) {
      const r = visit(k.id);
      if (r) return r;
    }
    return null;
  };
  const found = visit(map.root);
  if (found) return { id: found };
  if (children(map, map.root).length === 0) return { none: 'no nodes yet' };
  if (waiting.length) return { none: `${waiting[0].id} waits on ${waiting[0].on} (${waiting[0].status})` };
  if (blocked.length) return { none: `remaining leaves are blocked: ${blocked.join(', ')}` };
  const p = progress(map);
  if (p.done >= p.total) return { none: 'all leaves done' };
  const ip = inProgressNodes(map);
  if (ip.length) return { none: `nothing pending; in progress: ${ip.map((n) => n.id).join(', ')}` };
  return { none: 'no pending leaves' };
}

// ---------- mutations (call inside mutate()) ----------

function cleanTitle(title) {
  const t = String(title === undefined || title === null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!t) throw new UserError('title is empty.');
  return t;
}

function warnTitle(ctx, title, id) {
  const w = wordCount(title);
  if (w > TITLE_WORDS_WARN) ctx.warnings.push(`${id ? id + ': ' : ''}title has ${w} words (aim for 2-6): "${title}"`);
}

function normalizeLinks(map, links, selfId) {
  const out = [];
  for (const l of links || []) {
    const id = String(l).trim();
    if (!id) continue;
    getNode(map, id);
    if (id === selfId) throw new UserError(`${id} cannot depend on itself.`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function checkDepth(map, parentId, subtreeHeight, force, label) {
  const d = depthOf(map, parentId) + 1 + subtreeHeight;
  if (d > MAX_DEPTH && !force) {
    throw new UserError(`${label} would sit ${d} levels below the root; the limit is ${MAX_DEPTH}. Add it higher up or pass --force.`);
  }
}

function newNode(map, ctx, opts) {
  const { parent, what = '', why = '', done_when = '', links = [], source = 'claude', after = null, force = false } = opts;
  const p = getNode(map, parent);
  const title = cleanTitle(opts.title);
  checkDepth(map, p.id, 0, force, `"${title}"`);
  const cleanLinks = normalizeLinks(map, links, null);
  const id = `n${map.next_id}`;
  map.next_id += 1;
  warnTitle(ctx, title, id);
  const sibs = children(map, p.id);
  let order = sibs.length;
  if (after) {
    const a = getNode(map, after);
    if (a.parent !== p.id) throw new UserError(`--after ${after} is not a child of ${p.id}.`);
    order = a.order + 1;
    for (const s of sibs) if (s.order >= order) s.order += 1;
  }
  const node = {
    id,
    parent: p.id,
    order,
    title,
    what: String(what || ''),
    why: String(why || ''),
    done_when: String(done_when || ''),
    status: 'pending',
    status_reason: null,
    source: source === 'user' ? 'user' : 'claude',
    links: cleanLinks,
    notes: [],
    feedback: [],
    created: ctx.now,
    updated: ctx.now,
    started_at: null,
    finished_at: null,
  };
  map.nodes[id] = node;
  ctx.events.push({ type: 'add', node: id, detail: { title, parent: p.id, source: node.source } });
  if (node.source === 'user') {
    node.feedback.push({ ts: ctx.now, text: `added by user under ${p.id}`, read: false, kind: 'added' });
    ctx.inbox.push({ type: 'node_added', node: id, title, parent: p.id });
  }
  return node;
}

const STATUS_VERB = { in_progress: 'start', done: 'done', blocked: 'block', skipped: 'skip', pending: 'reopen' };

function setStatus(map, ctx, id, status, { reason = null, note = null, override = false } = {}) {
  const n = getNode(map, id);
  if (!STATUSES.includes(status)) throw new UserError(`unknown status "${status}". Use ${STATUSES.join('|')}.`);
  const needsReason = status === 'blocked' || status === 'skipped';
  reason = reason === undefined || reason === null ? '' : String(reason).trim();
  if (needsReason && !reason) throw new UserError(`${STATUS_VERB[status]} needs --reason "<why>".`);
  const from = n.status;
  n.status = status;
  n.status_reason = needsReason ? reason : null;
  if (status === 'in_progress') {
    if (!n.started_at) n.started_at = ctx.now;
    n.finished_at = null;
    if (isLeaf(map, id)) {
      const others = inProgressNodes(map).filter((o) => o.id !== id && isLeaf(map, o.id));
      if (others.length) ctx.warnings.push(`also in progress: ${others.map((o) => `${o.id} ${o.title}`).join('; ')} (one leaf at a time)`);
    }
  } else if (status === 'done') {
    n.finished_at = ctx.now;
    const open = leavesUnder(map, id).filter((l) => l.status !== 'done' && !effectivelySkipped(map, l.id));
    if (open.length) ctx.warnings.push(`${open.length} leaf(s) under ${id} not done: ${open.slice(0, 5).map((l) => l.id).join(', ')}`);
  } else if (status === 'pending') {
    n.finished_at = null;
  }
  const noteText = note ? String(note).trim() : '';
  if (noteText) n.notes.push({ ts: ctx.now, text: noteText });
  ctx.touched.add(id);
  const detail = { from, to: status };
  if (reason) detail.reason = reason;
  if (noteText) detail.note = noteText;
  ctx.events.push({ type: override ? 'status' : STATUS_VERB[status], node: id, detail });
  if (override) {
    n.feedback.push({ ts: ctx.now, text: `set to ${status} by user${reason ? ': ' + reason : ''}`, read: false, kind: 'status' });
    ctx.inbox.push({ type: 'status', node: id, title: n.title, status, reason: reason || null });
  }
  return n;
}

function addNote(map, ctx, id, text) {
  const n = getNode(map, id);
  const t = String(text || '').trim();
  if (!t) throw new UserError('note text is empty.');
  n.notes.push({ ts: ctx.now, text: t });
  ctx.touched.add(id);
  ctx.events.push({ type: 'note', node: id, detail: { text: t } });
  return n;
}

function addFeedback(map, ctx, id, text) {
  const n = getNode(map, id);
  const t = String(text || '').trim();
  if (!t) throw new UserError('feedback text is empty.');
  n.feedback.push({ ts: ctx.now, text: t, read: false, kind: 'feedback' });
  ctx.touched.add(id);
  ctx.events.push({ type: 'feedback', node: id, detail: { text: t } });
  ctx.inbox.push({ type: 'feedback', node: id, title: n.title, text: t });
  return n;
}

function markRead(map, ctx, ids = null) {
  const nodes = ids ? ids.map((i) => getNode(map, i)) : Object.values(map.nodes);
  let total = 0;
  for (const n of nodes) {
    let count = 0;
    for (const f of n.feedback || []) {
      if (!f.read) {
        f.read = true;
        count += 1;
      }
    }
    if (count) {
      total += count;
      ctx.touched.add(n.id);
      ctx.events.push({ type: 'read', node: n.id, detail: { count } });
    }
  }
  return total;
}

function editNode(map, ctx, id, changes) {
  const n = getNode(map, id);
  const fields = [];
  if (changes.title !== undefined) {
    n.title = cleanTitle(changes.title);
    warnTitle(ctx, n.title, id);
    fields.push('title');
  }
  for (const f of ['what', 'why', 'done_when']) {
    if (changes[f] !== undefined) {
      n[f] = String(changes[f]);
      fields.push(f);
    }
  }
  if (changes.parent !== undefined) {
    if (id === map.root) throw new UserError('the root cannot be moved.');
    const p = getNode(map, changes.parent);
    if (p.id === id || ancestors(map, p.id).includes(id)) throw new UserError(`${id} cannot be its own ancestor.`);
    if (p.id !== n.parent) {
      checkDepth(map, p.id, height(map, id), changes.force, id);
      const oldParent = n.parent;
      n.parent = p.id;
      n.order = children(map, p.id).length - 1;
      normalizeOrders(map, oldParent);
      normalizeOrders(map, p.id);
      fields.push('parent');
    }
  }
  if (changes.order !== undefined) {
    const want = parseInt(changes.order, 10);
    if (!Number.isFinite(want) || want < 0) throw new UserError('--order expects a non-negative integer.');
    const sibs = children(map, n.parent).filter((s) => s.id !== id);
    sibs.splice(Math.min(want, sibs.length), 0, n);
    sibs.forEach((s, i) => {
      s.order = i;
    });
    fields.push('order');
  }
  if (changes.link) {
    for (const l of [].concat(changes.link)) {
      const add = normalizeLinks(map, [l], id);
      for (const a of add) if (!n.links.includes(a)) n.links.push(a);
    }
    fields.push('link');
  }
  if (changes.unlink) {
    for (const l of [].concat(changes.unlink)) {
      const i = n.links.indexOf(String(l).trim());
      if (i < 0) throw new UserError(`${id} has no link to ${l}.`);
      n.links.splice(i, 1);
    }
    fields.push('unlink');
  }
  if (!fields.length) throw new UserError('edit needs at least one of --title --what --why --done-when --parent --order --link --unlink.');
  ctx.touched.add(id);
  ctx.events.push({ type: 'edit', node: id, detail: { fields } });
  return n;
}

function normalizeOrders(map, parentId) {
  children(map, parentId).forEach((k, i) => {
    k.order = i;
  });
}

// Batch create: items [{key, parent, title, what, why, done_when, links, after}]
// parent/links/after may reference earlier keys. Returns [{key, id}].
function addBatch(map, ctx, items, { source = 'claude', force = false } = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new UserError('--batch expects a JSON array on stdin: [{key, parent, title, what, why, done_when, links}].');
  }
  const byKey = new Map();
  const resolve = (ref, what, i) => {
    if (ref === undefined || ref === null || ref === '') throw new UserError(`batch item ${i + 1} has no ${what}.`);
    const r = String(ref);
    if (byKey.has(r)) return byKey.get(r);
    if (map.nodes[r]) return r;
    throw new UserError(`batch item ${i + 1}: ${what} "${r}" is neither an existing id nor an earlier key.`);
  };
  const out = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') throw new UserError(`batch item ${i + 1} is not an object.`);
    const key = it.key === undefined || it.key === null || it.key === '' ? `#${i + 1}` : String(it.key);
    if (byKey.has(key)) throw new UserError(`batch key "${key}" is used twice.`);
    const parent = resolve(it.parent, 'parent', i);
    const links = (it.links || []).map((l) => resolve(l, 'link', i));
    const after = it.after ? resolve(it.after, 'after', i) : null;
    let node;
    try {
      node = newNode(map, ctx, { ...it, parent, links, after, source: it.source === 'user' ? 'user' : source, force });
    } catch (e) {
      if (e instanceof UserError) throw new UserError(`batch item ${i + 1} (${key}): ${e.message}`);
      throw e;
    }
    byKey.set(key, node.id);
    out.push({ key, id: node.id });
  });
  return out;
}

module.exports = {
  SCHEMA,
  STATUSES,
  MAX_DEPTH,
  VERSION,
  UserError,
  now,
  sleepSync,
  home,
  port,
  baseUrl,
  projectUrl,
  projectIdFor,
  idNum,
  readJson,
  writeJsonAtomic,
  withLock,
  readRegistry,
  registerProject,
  unregisterProject,
  touchRegistry,
  listProjects,
  projectById,
  dataDir,
  mapFile,
  hasMap,
  findProjectDir,
  resolveProjectDir,
  requireProjectDir,
  readMap,
  statMap,
  readLog,
  createMap,
  initProject,
  installMap,
  mutate,
  getNode,
  children,
  isLeaf,
  depthOf,
  height,
  ancestors,
  descendants,
  effectivelySkipped,
  blockedOrSkippedAbove,
  leavesUnder,
  progress,
  isClosed,
  unreadOf,
  unreadCount,
  inProgressNodes,
  blockedNodes,
  statusCounts,
  wordCount,
  nextActionable,
  newNode,
  setStatus,
  addNote,
  addFeedback,
  markRead,
  editNode,
  addBatch,
};
