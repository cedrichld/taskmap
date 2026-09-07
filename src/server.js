'use strict';
// server.js — one local server for every registered project.
// Static UI from ui/, JSON API, SSE change feed. Binds 127.0.0.1 only.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const store = require('./store');
const { UserError } = store;

const UI_DIR = path.join(__dirname, '..', 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const POLL_MS = 300;
const PING_MS = 20000;
const MAX_BODY = 64 * 1024;
const LOG_TAIL = 100;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendFile(res, file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    return sendJson(res, 404, { error: 'not found' });
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError('body too large (64 KB max)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const j = JSON.parse(text);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return reject(new UserError('body must be a JSON object'));
        resolve(j);
      } catch (e) {
        reject(new UserError('body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function str(v, name, max) {
  if (typeof v !== 'string' || !v.trim()) throw new UserError(`${name} must be a non-empty string`);
  if (v.length > max) throw new UserError(`${name} is too long (${max} chars max)`);
  return v.trim();
}

function optStr(v, name, max) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new UserError(`${name} must be a string`);
  if (v.length > max) throw new UserError(`${name} is too long (${max} chars max)`);
  return v;
}

function projectSummary(p, { sessions = {}, clients = {} } = {}) {
  const live = (sessions[p.id] || 0) > 0;
  const base = { id: p.id, name: p.name, path: p.path, updated: p.updated, exists: Boolean(p.exists), live, sessions: sessions[p.id] || 0, clients: clients[p.id] || 0 };
  if (!p.exists) return { ...base, goal: '', progress: null, in_progress: 0, in_progress_titles: [], blocked: 0, unread: 0 };
  try {
    const map = store.readMap(p.path);
    const pr = store.progress(map);
    const ip = store.inProgressNodes(map);
    const leaf = ip.find((n) => store.isLeaf(map, n.id)) || ip[0] || null;
    const focus = leaf
      ? {
          id: leaf.id,
          title: leaf.title,
          path: store.ancestors(map, leaf.id).filter((a) => a !== map.root).map((a) => (map.nodes[a] || {}).title || a).reverse(),
          note: leaf.notes && leaf.notes.length ? leaf.notes[leaf.notes.length - 1].text : '',
          since: leaf.started_at || null,
        }
      : null;
    return {
      focus,
      ...base,
      name: map.name || p.name,
      goal: map.goal || '',
      updated: map.updated || p.updated,
      progress: { done: pr.done, total: pr.total },
      in_progress: ip.length,
      in_progress_titles: ip.map((n) => n.title),
      blocked: store.blockedNodes(map).length,
      unread: store.unreadCount(map),
    };
  } catch (e) {
    return { ...base, exists: false, goal: '', progress: null, in_progress: 0, in_progress_titles: [], blocked: 0, unread: 0, error: String(e.message || e) };
  }
}

function fullPayload(p) {
  const map = store.readMap(p.path);
  return { project: { id: p.id, name: map.name || p.name, path: p.path, updated: map.updated || p.updated, exists: true, url: store.projectUrl(p.id) }, map, log: store.readLog(p.path, LOG_TAIL) };
}

// ---------- share guard ----------
// While ~/.taskmap/share.json exists the dashboard is reachable from outside this
// machine, and the dashboard can type into a running Claude session. So: local
// requests pass untouched, everything else must carry the token, and `share --stop`
// deletes the file, which kills every link that was ever handed out.

const SHARE_COOKIE = 'taskmap_share';
let shareCache = { key: null, rec: null };

function currentShare() {
  const file = store.shareFile();
  let st = null;
  try {
    st = fs.statSync(file);
  } catch (e) {
    shareCache = { key: null, rec: null };
    return null;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (shareCache.key !== key) shareCache = { key, rec: store.readShare() };
  return shareCache.rec;
}

function isLocalRequest(req) {
  const raw = String(req.headers.host || '');
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1' || name === '';
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns true when the request may proceed. Otherwise it has been answered.
function passesShareGuard(req, res, url) {
  const share = currentShare();
  if (!share || isLocalRequest(req)) return true;

  if (tokenMatches(cookieValue(req, SHARE_COOKIE), share.token)) return true;

  if (tokenMatches(url.searchParams.get('t'), share.token)) {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const cookie = `${SHARE_COOKIE}=${encodeURIComponent(share.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
    if (req.method === 'GET' || req.method === 'HEAD') {
      // Move the token out of the address bar (and out of any Referer) at once.
      url.searchParams.delete('t');
      const to = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '');
      res.writeHead(302, { 'Set-Cookie': cookie, Location: to, 'Cache-Control': 'no-store' });
      res.end();
      return false;
    }
    res.setHeader('Set-Cookie', cookie);
    return true;
  }

  res.writeHead(401, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
  res.end();
  return false;
}

function start({ port = store.port(), host = '127.0.0.1' } = {}) {
  const clients = new Map(); // project id -> Set<res>
  const seen = new Map(); // project id -> { mtimeMs, size }

  function addClient(id, res) {
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(res);
  }

  function removeClient(id, res) {
    const set = clients.get(id);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(id);
    }
  }

  // Connected SSE clients: per project and overall.
  function clientCounts() {
    const projects = {};
    let total = 0;
    for (const [id, set] of clients) {
      if (!set.size) continue;
      projects[id] = set.size;
      total += set.size;
    }
    return { total, projects };
  }

  function sendEvent(res, data) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (e) {
      return false;
    }
  }

  function broadcast(id) {
    const set = clients.get(id);
    if (!set || !set.size) return;
    const p = store.projectById(id);
    if (!p || !store.hasMap(p.path)) return;
    let payload;
    try {
      const full = fullPayload({ ...p, exists: true });
      payload = { type: 'map', map: full.map, log: full.log };
    } catch (e) {
      return; // a torn read; the next poll will retry
    }
    for (const res of [...set]) if (!sendEvent(res, payload)) removeClient(id, res);
  }

  function poll() {
    let projects = [];
    try {
      projects = store.listProjects();
    } catch (e) {
      return;
    }
    for (const p of projects) {
      if (!p.exists) {
        seen.delete(p.id);
        continue;
      }
      const st = store.statMap(p.path);
      if (!st) continue;
      const prev = seen.get(p.id);
      if (!prev) {
        seen.set(p.id, st);
        continue;
      }
      if (prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
        seen.set(p.id, st);
        broadcast(p.id);
      }
    }
  }

  function ping() {
    for (const [id, set] of clients) for (const res of [...set]) if (!sendEvent(res, { type: 'ping' })) removeClient(id, res);
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${host}`);
    if (!passesShareGuard(req, res, u)) return undefined;
    const p = u.pathname;
    const method = req.method;

    if (p === '/api/health') return sendJson(res, 200, { ok: true, app: 'taskmap', version: store.VERSION, pid: process.pid, port, host });

    if (p.startsWith('/api/')) {
      if (p === '/api/projects' && method === 'GET') {
        const sessions = store.liveSessionCounts();
        const counts = clientCounts();
        return sendJson(res, 200, { projects: store.listProjects().map((x) => projectSummary(x, { sessions, clients: counts.projects })) });
      }
      if (p === '/api/clients' && method === 'GET') {
        const counts = clientCounts();
        return sendJson(res, 200, {
          ok: true,
          total: counts.total,
          projects: counts.projects,
          sessions: store.liveSessionCounts(),
          session_ttl_ms: store.SESSION_TTL_MS,
        });
      }
      const m = p.match(/^\/api\/projects\/([^/]+)(?:\/(.+))?$/);
      if (!m) return sendJson(res, 404, { error: `no route ${method} ${p}` });
      const id = decodeURIComponent(m[1]);
      const rest = m[2] || '';
      const proj = store.projectById(id);
      if (!proj) return sendJson(res, 404, { error: `unknown project "${id}"` });
      if (!store.hasMap(proj.path)) return sendJson(res, 404, { error: `project directory missing: ${proj.path}` });

      if (method === 'GET') {
        if (rest === '') return sendJson(res, 200, fullPayload({ ...proj, exists: true }));
        if (rest === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 2000\n\n');
          const full = fullPayload({ ...proj, exists: true });
          sendEvent(res, { type: 'map', map: full.map, log: full.log });
          addClient(id, res);
          req.on('close', () => removeClient(id, res));
          return undefined;
        }
        return sendJson(res, 404, { error: `no route GET ${p}` });
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (rest === 'feedback') {
          const node = str(body.node, 'node', 32);
          const text = str(body.text, 'text', 4000);
          const r = store.mutate(proj.path, 'ui', (map, ctx) => store.addFeedback(map, ctx, node, text));
          log(`feedback ${id} ${node}`);
          return sendJson(res, 200, { ok: true, node: r.result });
        }
        if (rest === 'nodes') {
          const parent = str(body.parent, 'parent', 32);
          const title = str(body.title, 'title', 200);
          const what = optStr(body.what, 'what', 4000);
          const why = optStr(body.why, 'why', 4000);
          const r = store.mutate(proj.path, 'ui', (map, ctx) => store.newNode(map, ctx, { parent, title, what, why, source: 'user' }));
          log(`node added ${id} ${r.result.id} under ${parent}`);
          return sendJson(res, 201, { ok: true, id: r.result.id, node: r.result, warnings: r.warnings });
        }
        const nm = rest.match(/^nodes\/([^/]+)\/(status|read)$/);
        if (nm) {
          const nid = decodeURIComponent(nm[1]);
          if (nm[2] === 'status') {
            const status = str(body.status, 'status', 32);
            if (!store.STATUSES.includes(status)) throw new UserError(`unknown status "${status}". Use ${store.STATUSES.join('|')}.`);
            const reason = optStr(body.reason, 'reason', 1000).trim();
            if ((status === 'blocked' || status === 'skipped') && !reason) throw new UserError('reason is required for blocked and skipped');
            const r = store.mutate(proj.path, 'ui', (map, ctx) => store.setStatus(map, ctx, nid, status, { reason, override: true }));
            log(`status ${id} ${nid} -> ${status}`);
            return sendJson(res, 200, { ok: true, node: r.result, warnings: r.warnings });
          }
          const r = store.mutate(proj.path, 'ui', (map, ctx) => store.markRead(map, ctx, [nid]));
          return sendJson(res, 200, { ok: true, read: r.result });
        }
        return sendJson(res, 404, { error: `no route POST ${p}` });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    // The overview is the root. `/?p=<id>` is the pre-0.2 project link: redirect it.
    if (p === '/') {
      const want = u.searchParams.get('p');
      if (want) {
        res.writeHead(302, { Location: `/p/${encodeURIComponent(want)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendFile(res, path.join(UI_DIR, 'index.html'));
    }
    if (/^\/p\/[^/]+\/?$/.test(p)) return sendFile(res, path.join(UI_DIR, 'project.html'));

    let rel = p.replace(/^\/+/, '');
    const file = path.resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + path.sep) && file !== UI_DIR) return sendJson(res, 404, { error: 'not found' });
    return sendFile(res, file);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof UserError) {
        const status = /^unknown node|^unknown project/.test(e.message) ? 404 : 400;
        return sendJson(res, status, { error: e.message });
      }
      log('error', req.method, req.url, e && e.stack ? e.stack : e);
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
      else res.end();
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log(`port ${port} is in use; is another server running? (${store.baseUrl()})`);
    else log('server error', e);
    process.exit(1);
  });

  server.listen(port, host, () => {
    poll(); // prime `seen` before anyone connects
    log(`taskmap ${store.VERSION} listening on http://${host}:${port} (pid ${process.pid})`);
  });

  const pollTimer = setInterval(poll, POLL_MS);
  const pingTimer = setInterval(ping, PING_MS);

  function shutdown(signal) {
    log(`${signal}: shutting down`);
    clearInterval(pollTimer);
    clearInterval(pingTimer);
    for (const set of clients.values()) for (const res of set) {
      try {
        res.end();
      } catch (e) {
        // ignore
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
    try {
      const pidFile = path.join(store.home(), 'server.pid');
      if (parseInt(fs.readFileSync(pidFile, 'utf8'), 10) === process.pid) fs.unlinkSync(pidFile);
    } catch (e) {
      // ignore
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  start({ port: store.port() });
}

module.exports = { start };
