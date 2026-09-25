'use strict';
/* taskmap dashboard — vanilla JS, vendored D3 v7 for the card map and the list, ui/constellation.js for the orbs.
   Contract: docs/SPEC.md sections 2, 6, 7. Design: docs/design/DESIGN.md. */

// ---------- helpers ----------
const $ = (sel, el) => (el || document).querySelector(sel);
const C = window.Constellation;
const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];
const LABEL = { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked', skipped: 'skipped' };
const ACTOR = { cli: 'Claude', ui: 'You' };
const VERB = { init: 'created', add: 'added', start: 'started', done: 'finished', block: 'blocked', skip: 'skipped', reopen: 'reopened', edit: 'edited', note: 'noted on', feedback: 'commented on', status: 'set', read: 'read' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ICON = {
  chevron: '<path d="M6 4l4 4-4 4"/>',
  back: '<path d="M10 4L6 8l4 4"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  plus: '<path d="M8 4v8M4 8h8"/>',
  reply: '<path d="M6.5 4L3 7.5 6.5 11"/><path d="M3 7.5h6a4 4 0 0 1 4 4V13"/>',
  fit: '<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>',
  message: '<path d="M13 9.5A1.5 1.5 0 0 1 11.5 11H6l-3 2.5V4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5z"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
};
const icon = (name, cls) =>
  `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NARROW_Q = window.matchMedia && window.matchMedia('(max-width: 767px)');
const narrow = () => Boolean(NARROW_Q && NARROW_Q.matches);
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtClock(iso) {
  const d = new Date(iso);
  return !iso || isNaN(d) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDay(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return 'Undated';
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${y}`;
}
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (isNaN(s)) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const ss = {
  get(k, dflt) {
    try { const v = sessionStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
  },
  set(k, v) {
    try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  },
};
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Could not reach the taskmap server. Is it running? (taskmap serve --ensure)');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

// ---------- state ----------
const state = {
  projects: [], pid: null, map: null, log: [], kids: new Map(),
  selected: null, hover: null, collapsed: new Set(), expanded: new Set(), view: 'map', scope: 'open',
  es: null, retryMs: 1000, retryTimer: null, everConnected: false,
  userMoved: false, drafts: {}, inlineMode: null, orbit: true,
  runs: [], skew: 0, pinnedRun: null,
};
const projPath = () => `/api/projects/${encodeURIComponent(state.pid)}`;
const projectPath = (id) => `/p/${encodeURIComponent(id)}`;
// `/p/<id>` is the project page; `/?p=<id>` still arrives from older links and bookmarks.
function wantedProject() {
  const m = location.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('p');
}
const rootId = () => (state.map ? state.map.root : 'n0');
const nodeOf = (id) => (state.map ? state.map.nodes[id] : undefined);

// ---------- derived values (SPEC section 2, "Derived values") ----------
function idNum(id) { return parseInt(String(id).slice(1), 10) || 0; }
function buildIndex() { state.kids = C.index(state.map); }
const kidsOf = (id) => state.kids.get(id) || [];
const hasKids = (id) => kidsOf(id).length > 0;
const isCollapsed = (id) => state.collapsed.has(id) && hasKids(id);
function depthOf(id) {
  let d = 0;
  for (let n = nodeOf(id); n && n.parent != null; n = nodeOf(n.parent)) d += 1;
  return d;
}
function skippedAt(id) {
  for (let n = nodeOf(id); n; n = nodeOf(n.parent)) if (n.status === 'skipped') return true;
  return false;
}
// done leaves / total leaves under `id`, total excluding effectively skipped leaves.
function progressOf(id) {
  let done = 0;
  let total = 0;
  const walk = (pid, sk) => {
    for (const k of kidsOf(pid)) {
      const s = sk || k.status === 'skipped';
      if (hasKids(k.id)) walk(k.id, s);
      else if (!s) { total += 1; if (k.status === 'done') done += 1; }
    }
  };
  walk(id, skippedAt(id));
  return { done, total };
}
function statusCounts() {
  const c = { pending: 0, in_progress: 0, done: 0, blocked: 0, skipped: 0 };
  for (const n of Object.values(state.map.nodes)) if (n.id !== rootId() && c[n.status] !== undefined) c[n.status] += 1;
  return c;
}
const unreadOf = (n) => (n.feedback || []).filter((f) => !f.read).length;
function unreadCount() { return Object.values(state.map.nodes).reduce((s, n) => s + unreadOf(n), 0); }
const byId = (a, b) => idNum(a.id) - idNum(b.id);
function blockedNodes() { return Object.values(state.map.nodes).filter((n) => n.status === 'blocked' && n.id !== rootId()).sort(byId); }
// Milestone › chunk titles above a node, root excluded: where on the map Claude is.
function focusPath(id) { return C.titlePath(state.map, id); }
function lastNote(n) {
  const notes = (n && n.notes) || [];
  return notes.length ? String(notes[notes.length - 1].text || '') : '';
}
function nowNode() {
  const ip = Object.values(state.map.nodes).filter((n) => n.status === 'in_progress' && n.id !== rootId()).sort(byId);
  return ip.find((n) => !hasKids(n.id)) || ip[0] || null;
}
// A subtree is closed when its node and every descendant is done or skipped (same rule as `taskmap tree --open`).
function isClosed(id) {
  const n = nodeOf(id);
  if (!n || (n.status !== 'done' && n.status !== 'skipped')) return false;
  const walk = (pid) => kidsOf(pid).every((k) => (k.status === 'done' || k.status === 'skipped') && walk(k.id));
  return walk(id);
}
function ancestorsOf(id) {
  const out = new Set();
  for (let n = nodeOf(id); n; n = n.parent != null ? nodeOf(n.parent) : null) out.add(n.id);
  return out;
}
const visibleTree = () => C.visibleTree(state.map, state.kids, { scope: state.scope === 'done' ? 'all' : state.scope, collapsed: state.collapsed, expanded: state.expanded });
const VIEWS = ['map', 'graph', 'orbs', 'outline'];

// ---------- cards (map and list) ----------
function kindOf(id) { return id === rootId() ? 'root' : hasKids(id) ? 'parent' : 'leaf'; }
// The card and the strip show the question itself; the panel keeps the full reason.
const question = (reason) => String(reason || '').replace(/^waiting on (you|the user|user)[:,]?\s*/i, '');
function badgeHtml(id, collapsed, hidden) {
  const p = progressOf(id);
  const more = hidden ? ` ${hidden} ${hidden === 1 ? 'task is' : 'tasks are'} hidden.` : '';
  return collapsed
    ? `<span class="badge fold" title="${p.done} of ${p.total} leaves done.${more} Click to show them.">${p.done}/${p.total}${icon('chevron')}</span>`
    : `<span class="badge" title="${p.done} of ${p.total} leaves done. Click to fold.">${p.done}/${p.total}</span>`;
}
function cardHtml(n, opts) {
  const badge = kindOf(n.id) !== 'leaf' ? badgeHtml(n.id, opts.collapsed, opts.hidden) : '';
  const reason = n.status === 'blocked' ? `<div class="reason">${esc(question(n.status_reason))}</div>` : '';
  const status = opts.status ? `<span class="status">${LABEL[n.status] || esc(n.status)}</span>` : '';
  const unread = unreadOf(n) ? `<i class="unread" title="${unreadOf(n)} unread feedback"></i>` : '';
  return `<i class="sdot" aria-hidden="true"></i><div class="body"><div class="title">${esc(n.title)}</div>${reason}</div>${badge}${status}${unread}`;
}
function cardTitle(n) {
  const bits = [n.title];
  if (n.status === 'blocked') bits.push(`Blocked: ${n.status_reason || ''}`);
  if (n.source === 'user') bits.push('Added from the dashboard');
  return bits.join('\n');
}
// Keeps the element and only rewrites the inner HTML when something changed.
function syncCard(el, n, opts) {
  el.className = `card k-${kindOf(n.id)} st-${n.status}${opts.collapsed ? ' collapsed' : ''}${n.source === 'user' ? ' user' : ''}${n.id === state.selected ? ' selected' : ''}`;
  el.dataset.id = n.id;
  el.title = cardTitle(n);
  const html = cardHtml(n, opts);
  if (el._sig !== html) { el.innerHTML = html; el._sig = html; }
}

// ---------- orbs: the Graph and 3D views ----------
// Orbs on a canvas; titles are HTML so they stay crisp at any zoom. Graph lays the tree
// flat as a radial tree and pans; 3D lays it out as a dandelion (ui/constellation.js),
// orbits the root and turns over a floor grid. Switching between the two morphs one
// layout into the other. The loop only runs while something moves.
const graphEl = $('#graph');
const canvas = $('#scene');
const ctx = canvas.getContext('2d');
const labelsEl = $('#labels');
const cssTok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const P = { text: cssTok('--text'), dim: cssTok('--dim'), accent: cssTok('--accent'), ok: cssTok('--ok'), warn: cssTok('--warn'), link: cssTok('--link'), hub: '#343a47', root: '#4d5568', hollow: '#12151a' };
function hexParts(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgba(hex, a) { const [r, g, b] = hexParts(hex); return `rgba(${r},${g},${b},${a})`; }
function mix(hex, toWhite, t) {
  const tgt = toWhite ? 255 : 0;
  return `rgb(${hexParts(hex).map((c) => Math.round(c + (tgt - c) * t)).join(',')})`;
}
const PITCH_3D = 0.38;
const scene = {
  entries: new Map(),
  cam: { yaw: 0.55, pitch: PITCH_3D, dist: 1400, focal: 900, panX: 0, panY: 0 },
  want: { dist: 1400, pitch: PITCH_3D, yaw: null, panX: 0, panY: 0 },
  flat: 0, wantFlat: 0, rings: [], floor: null, floorR: 0,
  R: 200, starR: 0, stars: [], nowId: null, nowPath: new Set(), frame: { cx: 0, cy: 0, w: 0, h: 0 },
  dpr: 1, w: 0, h: 0, raf: 0, on: false, last: 0, lastDraw: 0, quiet: 0, dirty: true, sig: null, sprites: new Map(),
};
const ptr = { active: new Map(), moved: false, x0: 0, y0: 0, yaw0: 0, pitch0: 0, panX0: 0, panY0: 0, hit: null, badge: false, pinch0: 0, dist0: 0 };
const orbView = () => state.view === 'graph' || state.view === 'orbs';
const flatView = () => state.view === 'graph';

// A pill after the title says how many tasks sit folded under it; clicking opens them.
function moreHtml(it) {
  if (!it.hidden) return '';
  return `<span class="badge more" title="${it.hidden} hidden ${it.hidden === 1 ? 'task' : 'tasks'} under this one. Click to show.">+${it.hidden}</span>`;
}
function labelHtml(it) {
  const n = it.n;
  const unread = unreadOf(n) ? `<i class="unread" title="${unreadOf(n)} unread feedback"></i>` : '';
  return `<span class="title">${esc(n.title)}</span>${moreHtml(it)}${unread}`;
}
function syncLabel(e) {
  const it = e.it;
  if (!e.el) {
    e.el = document.createElement('div');
    e.el.tabIndex = 0;
    e.el.dataset.id = it.id;
    e.el.style.pointerEvents = 'none';
    labelsEl.appendChild(e.el);
  }
  const cls = `label k-${it.kind} st-${it.n.status}${it.hidden ? ' folded' : ''}${it.n.source === 'user' ? ' user' : ''}${it.id === state.selected ? ' selected' : ''}`;
  if (e.el.className !== cls) { e.el.className = cls; e.lw = 0; }
  const html = labelHtml(it);
  if (e.sig !== html) { e.el.innerHTML = html; e.sig = html; e.el.title = cardTitle(it.n); e.lw = 0; }
}
function resetScene() {
  stopScene();
  scene.entries.clear();
  scene.sig = null;
  labelsEl.innerHTML = '';
  $('#allopen').hidden = true;
}
function renderGraph() {
  if (scene.w !== graphEl.clientWidth || scene.h !== graphEl.clientHeight) resizeCanvas();
  const flat = flatView();
  scene.wantFlat = flat ? 1 : 0;
  const tree = visibleTree();
  const items = flat ? C.layoutFlat(tree) : C.layout(tree);
  scene.rings = flat ? tree.rings || [] : scene.rings;
  const first = !scene.entries.size;
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    let e = scene.entries.get(it.id);
    if (!e) {
      // A new orb grows out of its parent's current position.
      const p = it.parent && scene.entries.get(it.parent.id);
      e = { id: it.id, x: p ? p.x : it.x, y: p ? p.y : it.y, z: p ? p.z : it.z, r: 0, a: 0, el: null, sig: null, shown: false, lw: 0, lh: 0 };
      if (first || REDUCED) { e.x = it.x; e.y = it.y; e.z = it.z; e.r = it.r; e.a = 1; }
      scene.entries.set(it.id, e);
    }
    e.it = it; e.tx = it.x; e.ty = it.y; e.tz = it.z; e.tr = it.r; e.ta = 1; e.gone = false;
    syncLabel(e);
  }
  for (const e of scene.entries.values()) if (!seen.has(e.id)) { e.ta = 0; e.gone = true; }
  if (first || REDUCED) scene.flat = scene.wantFlat;
  scene.R = C.cloudRadius(items);
  if (Math.abs(scene.R - scene.starR) > scene.starR * 0.25) { scene.starR = scene.R; scene.stars = C.stars(220, scene.R * 2.4); }
  const now = nowNode();
  scene.nowId = now ? now.id : null;
  scene.nowPath = now ? ancestorsOf(now.id) : new Set();
  const sig = `${state.view}|${items.map((it) => it.id).join(',')}`;
  const structural = sig !== scene.sig;
  scene.sig = sig;
  $('#allopen').hidden = !(state.scope === 'open' && !tree.children.length);
  if ((first || structural) && !state.userMoved) fit(!first);
  wake();
}
function wake() {
  scene.dirty = true;
  if (scene.on || document.hidden || !orbView()) return;
  scene.on = true;
  scene.last = performance.now();
  scene.raf = requestAnimationFrame(tick);
}
function stopScene() {
  scene.on = false;
  cancelAnimationFrame(scene.raf);
}
// Eases `cur[k]` toward `want[k]`; true while it still has a way to go.
function ease(cur, want, k, f, eps) {
  if (Math.abs(want[k] - cur[k]) > eps) { cur[k] += (want[k] - cur[k]) * f; return true; }
  cur[k] = want[k];
  return false;
}
function tick(t) {
  if (!scene.on) return;
  if (scene.w < 20 || scene.h < 20) { scene.on = false; return; }
  const dt = Math.min(64, t - scene.last);
  scene.last = t;
  const cam = scene.cam;
  const want = scene.want;
  let moving = false;
  const kc = REDUCED ? 1 : 1 - Math.exp(-dt / 150);
  if (ease(cam, want, 'dist', kc, 0.5)) moving = true;
  if (ease(cam, want, 'pitch', kc, 0.0005)) moving = true;
  if (ease(cam, want, 'panX', kc, 0.3)) moving = true;
  if (ease(cam, want, 'panY', kc, 0.3)) moving = true;
  if (want.yaw != null && ease(cam, want, 'yaw', kc, 0.0005)) moving = true;
  if (ease(scene, { flat: scene.wantFlat }, 'flat', kc, 0.002)) moving = true;
  // The slow orbit waits a few seconds after the last touch and never runs under a pointer.
  const idle = t - scene.quiet > 5000 && !state.hover && !ptr.active.size;
  if (state.orbit && idle && !REDUCED && !flatView()) { cam.yaw += dt * 0.00005; moving = true; }
  const kp = REDUCED ? 1 : 1 - Math.exp(-dt / 170);
  let pulses = false;
  for (const e of [...scene.entries.values()]) {
    const d = Math.abs(e.tx - e.x) + Math.abs(e.ty - e.y) + Math.abs(e.tz - e.z) + Math.abs(e.tr - e.r) + Math.abs(e.ta - e.a) * 20;
    if (d > 0.08) {
      e.x += (e.tx - e.x) * kp; e.y += (e.ty - e.y) * kp; e.z += (e.tz - e.z) * kp; e.r += (e.tr - e.r) * kp; e.a += (e.ta - e.a) * kp;
      moving = true;
    } else {
      e.x = e.tx; e.y = e.ty; e.z = e.tz; e.r = e.tr; e.a = e.ta;
      if (e.gone) { scene.entries.delete(e.id); if (e.el) e.el.remove(); continue; }
    }
    if (!REDUCED && e.it.kind === 'leaf' && (e.it.n.status === 'in_progress' || e.it.n.status === 'blocked')) pulses = true;
  }
  // Breathing alone does not need 60 frames a second.
  if (moving || scene.dirty || t - scene.lastDraw >= 40) { draw(t); scene.lastDraw = t; }
  scene.dirty = false;
  if ((moving || pulses) && !document.hidden) scene.raf = requestAnimationFrame(tick);
  else scene.on = false;
}
// Far orbs dim in 3D; a flat drawing has no far side.
function fog(depth) {
  const near = scene.cam.dist - scene.R;
  const t = clamp((depth - near) / (2 * scene.R || 1), 0, 1);
  return 1 - 0.5 * t * (1 - scene.flat);
}
// Strokes world-space segments in a few alpha buckets, so a grid costs a handful of paths.
function strokeSegments(segs, cam, cx, cy, color, alpha, width) {
  const buckets = [[], [], [], [], [], [], []];
  for (const s of segs) {
    const p = C.project(s.a, cam, cx, cy);
    const q = C.project(s.b, cam, cx, cy);
    if (p.depth <= 30 || q.depth <= 30) continue;
    const w = s.w * fog((p.depth + q.depth) / 2);
    const b = Math.min(6, Math.round(w * 4));
    if (b > 0) buckets[b].push(p.x, p.y, q.x, q.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  buckets.forEach((arr, b) => {
    if (!arr.length) return;
    ctx.globalAlpha = alpha * (b / 4);
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i], arr[i + 1]); ctx.lineTo(arr[i + 2], arr[i + 3]); }
    ctx.stroke();
  });
}
// The ground the orbs stand on. In 3D a grid floor under the cloud, with a stem down
// from the root, turns and tilts with the orbs; in Graph faint rings mark each level.
function drawBackdrop(cam, cx, cy) {
  const a3 = 1 - scene.flat;
  if (a3 > 0.02) {
    if (!scene.floor || Math.abs(scene.floorR - scene.R) > scene.floorR * 0.08) { scene.floor = C.floorGrid(scene.R); scene.floorR = scene.R; }
    strokeSegments(scene.floor.segs, cam, cx, cy, P.text, 0.15 * a3, 1);
    const top = C.project({ x: 0, y: 0, z: 0 }, cam, cx, cy);
    const foot = C.project({ x: 0, y: scene.floor.y, z: 0 }, cam, cx, cy);
    if (top.depth > 30 && foot.depth > 30) {
      ctx.setLineDash([2, 5]);
      ctx.globalAlpha = 0.22 * a3;
      ctx.strokeStyle = P.text;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.35 * a3;
      ctx.fillStyle = P.text;
      ctx.beginPath(); ctx.ellipse(foot.x, foot.y, 3, 3 * Math.abs(Math.sin(cam.pitch)) + 0.5, 0, 0, TAU); ctx.fill();
    }
  }
  const af = scene.flat;
  if (af > 0.02 && scene.rings.length > 1) {
    const segs = [];
    for (let d = 1; d < scene.rings.length; d++) {
      const r = scene.rings[d];
      for (let i = 0; i < 120; i++) {
        const t0 = (i / 120) * TAU; const t1 = ((i + 1) / 120) * TAU;
        segs.push({ a: { x: r * Math.cos(t0), y: r * Math.sin(t0), z: 0 }, b: { x: r * Math.cos(t1), y: r * Math.sin(t1), z: 0 }, w: 1 });
      }
    }
    strokeSegments(segs, cam, cx, cy, P.text, 0.075 * af, 1);
  }
}
function draw(t) {
  const cam = scene.cam;
  const cx = scene.frame.cx + cam.panX;
  const cy = scene.frame.cy + cam.panY;
  ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
  ctx.clearRect(0, 0, scene.w, scene.h);
  // Faint stars far behind the cloud: they turn with it in 3D and fade in the flat graph.
  const starA = 1 - 0.75 * scene.flat;
  ctx.fillStyle = P.text;
  for (const st of scene.stars) {
    const q = C.project(st, cam, cx, cy);
    if (q.depth <= 40) continue;
    ctx.globalAlpha = st.a * 0.55 * fog(q.depth) * starA;
    ctx.beginPath(); ctx.arc(q.x, q.y, st.r * clamp(q.s * 1.4, 0.5, 1.4), 0, TAU); ctx.fill();
  }
  drawBackdrop(cam, cx, cy);
  // A faint pool of light around the root, so the cloud sits in space rather than on flat black.
  const root = scene.entries.get(rootId());
  if (root && root.a > 0.2) {
    const q = C.project(root, cam, cx, cy);
    const rad = Math.max(160, scene.R * q.s * 1.25);
    const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, rad);
    g.addColorStop(0, rgba(P.accent, 0.06));
    g.addColorStop(0.35, rgba(P.accent, 0.022));
    g.addColorStop(0.7, rgba(P.accent, 0.006));
    g.addColorStop(1, rgba(P.accent, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(q.x - rad, q.y - rad, rad * 2, rad * 2);
  }
  const list = [];
  for (const e of scene.entries.values()) {
    const q = C.project(e, cam, cx, cy);
    e.sx = q.x; e.sy = q.y; e.s = q.s; e.depth = q.depth; e.px = Math.max(1.2, e.r * q.s); e.fog = fog(q.depth);
    if (q.depth > 30) list.push(e);
  }
  list.sort((a, b) => b.depth - a.depth);
  const focusId = state.hover || state.selected;
  const focusPath = focusId ? ancestorsOf(focusId) : null;
  ctx.lineCap = 'round';
  for (const e of list) {
    const p = e.it.parent && scene.entries.get(e.it.parent.id);
    if (!p || p.depth <= 30) continue;
    const onNow = scene.nowPath.has(e.id) && scene.nowPath.has(p.id);
    const onFocus = focusPath && focusPath.has(e.id) && focusPath.has(p.id);
    ctx.strokeStyle = onNow ? P.accent : onFocus ? P.text : P.link;
    ctx.globalAlpha = Math.min(e.a, p.a) * Math.min(e.fog, p.fog) * (onNow ? 0.6 : onFocus ? 0.45 : 0.8);
    ctx.lineWidth = onNow || onFocus ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(e.sx, e.sy); ctx.stroke();
  }
  // Cross-links ("after"): dashed, only for the orb under the pointer or selected.
  const fe = focusId && scene.entries.get(focusId);
  if (fe && fe.depth > 30) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 1.2;
    for (const target of fe.it.n.links || []) {
      let tn = nodeOf(target);
      while (tn && !scene.entries.has(tn.id)) tn = tn.parent != null ? nodeOf(tn.parent) : null;
      const te = tn && scene.entries.get(tn.id);
      if (!te || te === fe || te.depth <= 30) continue;
      ctx.globalAlpha = 0.85 * Math.min(fe.fog, te.fog);
      ctx.beginPath(); ctx.moveTo(fe.sx, fe.sy); ctx.lineTo(te.sx, te.sy); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  for (const e of list) drawOrb(e, t);
  ctx.globalAlpha = 1;
  layoutLabels(list, root);
}
function orbStyle(e) {
  const st = e.it.n.status;
  const kind = e.it.kind;
  if (kind === 'leaf') {
    if (st === 'in_progress') return { fill: P.accent, glow: 0.5, pulse: 3200 };
    if (st === 'blocked') return { fill: P.warn, glow: 0.38, pulse: 4600 };
    if (st === 'done') return { fill: P.ok, alpha: 0.78 };
    if (st === 'skipped') return { fill: P.dim, alpha: 0.38 };
    return { hollow: P.dim };
  }
  const rim = st === 'in_progress' ? rgba(P.accent, 0.7) : st === 'blocked' ? P.warn : st === 'done' ? rgba(P.ok, 0.7) : st === 'skipped' ? P.dim : null;
  if (kind === 'root') return { fill: P.root, rim, glow: 0.16, glowColor: '#aab4cc', alpha: 1 };
  return { fill: P.hub, rim, glow: st === 'blocked' ? 0.28 : st === 'in_progress' ? 0.2 : 0, glowColor: st === 'blocked' ? P.warn : P.accent, alpha: st === 'skipped' ? 0.5 : 1 };
}
function spriteCache(key, make) {
  let sp = scene.sprites.get(key);
  if (sp) return sp;
  if (scene.sprites.size > 800) scene.sprites.clear();
  sp = make();
  scene.sprites.set(key, sp);
  return sp;
}
function newSprite(half) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(half * 2 * scene.dpr);
  const g = c.getContext('2d');
  g.scale(scene.dpr, scene.dpr);
  return { c, g, half };
}
function orbSprite(st, px) {
  const r = Math.max(1.2, Math.round(px * 2) / 2);
  return spriteCache(`o:${st.fill || ''}:${st.hollow || ''}:${st.rim || ''}:${r}`, () => {
    const sp = newSprite(r + 3);
    const { g, half } = sp;
    if (st.hollow) {
      g.fillStyle = P.hollow;
      g.beginPath(); g.arc(half, half, r, 0, TAU); g.fill();
      g.lineWidth = Math.max(1, r * 0.24);
      g.strokeStyle = st.hollow;
      g.globalAlpha = 0.9;
      g.beginPath(); g.arc(half, half, r - g.lineWidth / 2, 0, TAU); g.stroke();
    } else {
      const grad = g.createRadialGradient(half - r * 0.38, half - r * 0.38, r * 0.05, half, half, r * 1.12);
      grad.addColorStop(0, mix(st.fill, true, 0.55));
      grad.addColorStop(0.5, st.fill);
      grad.addColorStop(1, mix(st.fill, false, 0.45));
      g.fillStyle = grad;
      g.beginPath(); g.arc(half, half, r, 0, TAU); g.fill();
      g.lineWidth = st.rim ? Math.max(1, r * 0.14) : 1;
      g.strokeStyle = st.rim || 'rgba(255,255,255,0.14)';
      g.globalAlpha = st.rim ? 0.9 : 1;
      g.beginPath(); g.arc(half, half, r - g.lineWidth / 2, 0, TAU); g.stroke();
    }
    return sp;
  });
}
function glowSprite(color, px, strength) {
  const r = Math.max(1.5, Math.round(px));
  return spriteCache(`g:${color}:${strength}:${r}`, () => {
    const R = r * 3.6;
    const sp = newSprite(R + 2);
    const { g, half } = sp;
    const grad = g.createRadialGradient(half, half, r * 0.5, half, half, R);
    grad.addColorStop(0, rgba(color, strength));
    grad.addColorStop(0.35, rgba(color, strength * 0.32));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(half, half, R, 0, TAU); g.fill();
    return sp;
  });
}
function ring(x, y, r, color, w, a) {
  ctx.globalAlpha = a; ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
}
function drawOrb(e, t) {
  const st = orbStyle(e);
  const px = e.px;
  const a = e.a * e.fog * (st.alpha == null ? 1 : st.alpha);
  if (a <= 0.01) return;
  if (st.glow) {
    let g = 1;
    if (st.pulse && !REDUCED) g = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin((t / st.pulse) * TAU));
    const gs = glowSprite(st.glowColor || st.fill, px, st.glow);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a * g;
    ctx.drawImage(gs.c, e.sx - gs.half, e.sy - gs.half, gs.half * 2, gs.half * 2);
    ctx.globalCompositeOperation = 'source-over';
  }
  // Something folded inside: a second, dotted ring says there is more to open.
  if (e.it.hidden) { ctx.setLineDash([2, 3]); ring(e.sx, e.sy, px + 4.5, P.text, 1, a * 0.45); ctx.setLineDash([]); }
  const sp = orbSprite(st, px);
  ctx.globalAlpha = a;
  ctx.drawImage(sp.c, e.sx - sp.half, e.sy - sp.half, sp.half * 2, sp.half * 2);
  if (e.id === state.selected) ring(e.sx, e.sy, px + 4, P.text, 1.5, a);
  else if (e.id === state.hover) ring(e.sx, e.sy, px + 3, P.text, 1, a * 0.6);
  if (e.it.n.source === 'user') { ctx.setLineDash([3, 3]); ring(e.sx, e.sy, px + 6, P.text, 1, a * 0.4); ctx.setLineDash([]); }
  if (unreadOf(e.it.n)) {
    ctx.globalAlpha = a; ctx.fillStyle = P.accent;
    ctx.beginPath(); ctx.arc(e.sx + px * 0.8, e.sy - px * 0.8, Math.max(2.5, px * 0.3), 0, TAU); ctx.fill();
  }
}
function hideLabel(e) {
  if (!e.shown) return;
  e.shown = false;
  e.el.style.opacity = '0';
  e.el.style.pointerEvents = 'none';
}
// Few titles by default: the root, the open milestones, what Claude is on, what waits
// on you, and whatever is under the pointer or selected. The flat graph also names
// finished milestones where there is room; zooming in brings the leaves back.
function labelWish(e) {
  const it = e.it;
  const st = it.n.status;
  const shut = C.closed(st);
  const bump = st === 'in_progress' ? 25 : st === 'blocked' ? 22 : 0;
  const z = e.s; // how far in the view is zoomed at this orb: 1 is life size
  if (it.kind === 'root') return { want: true, p: 60 };
  if (scene.nowId === e.id) return { want: true, p: 90 };
  if (st === 'blocked') return { want: true, p: 70 };
  if (it.depth === 1) return shut ? { want: flatView() || z >= 2.4, p: 30 } : { want: true, p: 50 + bump };
  if (it.kind === 'parent') return { want: bump > 0 || z >= (shut ? 1.6 : 1.1), p: 35 + bump };
  if (st === 'in_progress') return { want: true, p: 80 };
  return { want: z >= (shut ? 1.7 : 1.3), p: shut ? 5 : 20 };
}
function layoutLabels(list, root) {
  const rects = [];
  const es = [];
  const far = scene.cam.dist + scene.R;
  for (const e of list) {
    const it = e.it;
    let { want, p } = labelWish(e);
    if (e.id === state.selected) { want = true; p += 50; }
    if (e.id === state.hover) { want = true; p += 40; }
    if (e.shown) p += 6;
    p += (1 - clamp(e.depth / far, 0, 1)) * 2;
    if (!want || e.a < 0.35 || e.gone) { hideLabel(e); continue; }
    if (!e.lw) { e.lw = e.el.offsetWidth || 1; e.lh = e.el.offsetHeight || 16; }
    const w = e.lw; const h = e.lh; const gap = e.px + 7;
    const right = { x: e.sx + gap, y: e.sy - h / 2, w, h };
    const left = { x: e.sx - gap - w, y: e.sy - h / 2, w, h };
    const below = { x: e.sx - w / 2, y: e.sy + gap, w, h };
    const above = { x: e.sx - w / 2, y: e.sy - gap - h, w, h };
    // Titles hang on the side away from the root, so they point outward like the branches.
    const dx = root ? e.sx - root.sx : 1;
    const dy = root ? e.sy - root.sy : 0;
    let first = dx >= 0 ? right : left;
    if (it.kind !== 'root' && Math.abs(dx) < 0.4 * Math.hypot(dx, dy)) first = dy < 0 ? above : below;
    rects.push({ p, soft: p >= 50, cands: [first, right, left, below, above].filter((r, i, a) => a.indexOf(r) === i) });
    es.push(e);
  }
  for (const e of scene.entries.values()) if (!list.includes(e)) hideLabel(e);
  // The orbs themselves are obstacles: a title may not sit on top of someone else's orb.
  const orbs = list.filter((e) => e.a > 0.35 && !e.gone).map((e) => ({ x: e.sx - e.px, y: e.sy - e.px, w: e.px * 2, h: e.px * 2 }));
  const chosen = C.placeLabels(rects, orbs);
  es.forEach((e, i) => {
    if (chosen[i] < 0) { hideLabel(e); return; }
    const r = rects[i].cands[chosen[i]];
    e.el.style.transform = `translate3d(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px,0)`;
    e.el.style.opacity = (Math.min(1, e.a) * (0.55 + 0.45 * e.fog)).toFixed(2);
    if (!e.shown) { e.shown = true; e.el.style.pointerEvents = 'auto'; }
  });
}
function hitTest(clientX, clientY) {
  const r = graphEl.getBoundingClientRect();
  const x = clientX - r.left;
  const y = clientY - r.top;
  let best = null;
  let bd = Infinity;
  for (const e of scene.entries.values()) {
    if (e.gone || e.a < 0.5 || !(e.depth > 30)) continue;
    const d = Math.hypot(e.sx - x, e.sy - y) - e.px;
    if (d <= Math.max(5, 11 - e.px) && d < bd) { bd = d; best = e; }
  }
  return best ? best.id : null;
}
function resizeCanvas() {
  const r = graphEl.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  scene.dpr = Math.min(2, window.devicePixelRatio || 1);
  scene.w = r.width;
  scene.h = r.height;
  canvas.width = Math.round(r.width * scene.dpr);
  canvas.height = Math.round(r.height * scene.dpr);
  scene.sprites.clear();
  frame();
  wake();
}
// The header and the side panel are translucent layers over the canvas, so the free
// area is the window minus whatever they currently cover.
function chromeInsets() {
  const head = $('#header').getBoundingClientRect().height;
  const strip = $('#waiting').hidden ? 0 : $('#waiting').getBoundingClientRect().height;
  const side = narrow() ? 0 : $('#side').getBoundingClientRect().width;
  document.documentElement.style.setProperty('--chrome-top', `${Math.round(head + strip)}px`);
  return { top: head + strip + 24, right: side + 24, bottom: 24, left: 24 };
}
function frame() {
  const ins = chromeInsets();
  const w = Math.max(120, scene.w - ins.left - ins.right);
  const h = Math.max(120, scene.h - ins.top - ins.bottom);
  scene.frame = { cx: ins.left + w / 2, cy: ins.top + h / 2, w, h };
  return scene.frame;
}
const distRange = () => [Math.max(60, scene.R * 0.15), scene.R * 8 + 400];
// Fit the orbs in the free area (load, structural change, Fit button, f). Titles hang
// beside their orbs, so the frame keeps room for them.
function fitOrbs(animate) {
  if (!orbView() || state.scope === 'done' || !scene.entries.size) return;
  const f = frame();
  const want = scene.want;
  const pts = [];
  for (const e of scene.entries.values()) if (!e.gone) pts.push({ x: e.tx, y: e.ty, z: e.tz, m: e.tr * 2.2 });
  // Titles hang outward on both sides of the flat graph, on the right in 3D.
  const room = flatView() ? Math.min(480, f.w * 0.44) : Math.min(300, f.w * 0.36);
  const [lo, hi] = distRange();
  if (flatView()) {
    // Square to the screen: yaw back to the nearest whole turn, no tilt, centred by panning.
    const r = C.fitFlat(pts, scene.cam.focal, Math.max(120, f.w - room), Math.max(120, f.h - 40));
    want.dist = clamp(Math.max(r.dist, scene.cam.focal / 1.5), lo, hi);
    const k = scene.cam.focal / want.dist;
    want.pitch = 0;
    want.yaw = Math.round(scene.cam.yaw / TAU) * TAU;
    want.panX = -r.x * k;
    want.panY = r.y * k;
  } else {
    want.pitch = PITCH_3D;
    want.yaw = null;
    want.panX = 0;
    want.panY = 0;
    const d = C.fitDistanceFor(pts, { yaw: scene.cam.yaw, pitch: want.pitch, focal: scene.cam.focal }, Math.max(120, f.w - room), Math.max(120, f.h - 50));
    // A near-empty map is not an excuse to fill the screen with one orb: 1.5x is the closest a fit goes.
    want.dist = clamp(Math.max(d, scene.cam.focal / 1.5), lo, hi);
  }
  if (!animate || REDUCED) {
    const cam = scene.cam;
    cam.dist = want.dist; cam.pitch = want.pitch; cam.panX = want.panX; cam.panY = want.panY;
    if (want.yaw != null) cam.yaw = want.yaw;
  }
  state.userMoved = false;
  wake();
}
function interact() {
  scene.quiet = performance.now();
  wake();
}
function setHover(id) {
  if (id === state.hover) return;
  state.hover = id;
  graphEl.classList.toggle('over', Boolean(id));
  wake();
}
// Zoom to `dist`; in the flat graph the point under (x, y) stays where it is.
function zoomTo(dist, x, y) {
  const cam = scene.cam;
  const [lo, hi] = distRange();
  const d = clamp(dist, lo, hi);
  if (flatView() && x != null) {
    const r = graphEl.getBoundingClientRect();
    const ox = x - r.left - scene.frame.cx;
    const oy = y - r.top - scene.frame.cy;
    const f = cam.dist / d;
    cam.panX = scene.want.panX = ox - (ox - cam.panX) * f;
    cam.panY = scene.want.panY = oy - (oy - cam.panY) * f;
  }
  cam.dist = scene.want.dist = d;
  state.userMoved = true;
}
function bindGraph() {
  graphEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    graphEl.setPointerCapture(e.pointerId);
    ptr.active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptr.active.size === 1) {
      ptr.moved = false;
      ptr.x0 = e.clientX; ptr.y0 = e.clientY; ptr.yaw0 = scene.cam.yaw; ptr.pitch0 = scene.cam.pitch;
      ptr.panX0 = scene.cam.panX; ptr.panY0 = scene.cam.panY;
      const lab = e.target.closest('.label');
      ptr.hit = lab ? lab.dataset.id : hitTest(e.clientX, e.clientY);
      ptr.badge = Boolean(e.target.closest('.badge'));
    } else if (ptr.active.size === 2) {
      const [a, b] = [...ptr.active.values()];
      ptr.pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      ptr.dist0 = scene.cam.dist;
      ptr.moved = true;
    }
    interact();
  });
  graphEl.addEventListener('pointermove', (e) => {
    const p = ptr.active.get(e.pointerId);
    if (!p) {
      const lab = e.target.closest('.label');
      setHover(lab ? lab.dataset.id : hitTest(e.clientX, e.clientY));
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (ptr.active.size === 1) {
      const dx = e.clientX - ptr.x0;
      const dy = e.clientY - ptr.y0;
      if (!ptr.moved && Math.hypot(dx, dy) > 4) { ptr.moved = true; graphEl.classList.add('dragging'); setHover(null); }
      if (ptr.moved) {
        if (flatView()) {
          scene.cam.panX = scene.want.panX = ptr.panX0 + dx;
          scene.cam.panY = scene.want.panY = ptr.panY0 + dy;
        } else {
          scene.cam.yaw = ptr.yaw0 + dx * 0.006;
          scene.cam.pitch = scene.want.pitch = clamp(ptr.pitch0 + dy * 0.006, -1.3, 1.3);
        }
        state.userMoved = true;
      }
    } else if (ptr.active.size === 2) {
      const [a, b] = [...ptr.active.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomTo(ptr.dist0 * ptr.pinch0 / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    interact();
  });
  const end = (e) => {
    if (!ptr.active.has(e.pointerId)) return;
    ptr.active.delete(e.pointerId);
    if (!ptr.active.size) {
      graphEl.classList.remove('dragging');
      if (!ptr.moved && e.type === 'pointerup') {
        if (!ptr.hit) select(null); // a tap on empty space puts the panel back to the key
        else if (ptr.badge) toggleCollapse(ptr.hit); else clickNode(ptr.hit);
      }
      ptr.moved = false;
      ptr.hit = null;
    }
    interact();
  };
  graphEl.addEventListener('pointerup', end);
  graphEl.addEventListener('pointercancel', end);
  graphEl.addEventListener('pointerleave', () => setHover(null));
  graphEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    zoomTo(scene.want.dist * f, e.clientX, e.clientY);
    interact();
  }, { passive: false });
  if (window.ResizeObserver) new ResizeObserver(() => { if (graphEl.clientWidth) { resizeCanvas(); if (!state.userMoved) fit(false); } }).observe(graphEl);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
}

// ---------- map: the tree as cards ----------
// Children that have visible children sit side by side; the others stack in one column
// on the left, under a spine. Plain SVG with HTML cards, panned and zoomed by d3.zoom.
const DUR = REDUCED ? 0 : 280;
const SIZE = { root: { w: 208, h: 54 }, parent: { w: 188, h: 46 }, leaf: { w: 176, h: 34 } };
const BLOCK_EXTRA = 32; // two lines of reason under the title
function sizeOf(n) {
  const k = kindOf(n.id);
  const s = SIZE[k];
  return { w: s.w, h: s.h + (n.status === 'blocked' ? BLOCK_EXTRA : 0), kind: k };
}
const COL_GAP = 14;
const ROW_GAP = 42;
const STACK_GAP = 10;
const STACK_INDENT = 14;
const cmSvg = d3.select('#cardmap');
const gView = d3.select('#viewport');
const gEdges = d3.select('#edges');
const gX = d3.select('#xlinks');
const gNodes = d3.select('#nodes');
// The dot grid is ground, not wallpaper: it tracks pan and zoom, and fades out at
// both ends of the range so a zoomed-out map is not sitting on moire.
const gridPattern = document.getElementById('dots');
const gridRect = document.getElementById('grid');
function gridOpacity(k) {
  if (k <= 0.5 || k >= 2.4) return 0;
  if (k < 0.85) return (k - 0.5) / 0.35;
  if (k > 1.6) return (2.4 - k) / 0.8;
  return 1;
}
function syncGrid(t) {
  if (!gridPattern || !gridRect) return;
  gridPattern.setAttribute('patternTransform', `translate(${t.x},${t.y}) scale(${t.k})`);
  gridRect.style.opacity = gridOpacity(t.k);
}
const zoom = d3.zoom().scaleExtent([0.08, 3]).on('zoom', (e) => {
  gView.attr('transform', e.transform);
  syncGrid(e.transform);
  if (e.sourceEvent) state.userMoved = true;
});
cmSvg.call(zoom).on('dblclick.zoom', null);
const cm = { nodes: [], links: [], sig: null };

// How many columns a stack of `n` leaves breaks into. One column keeps a small
// group readable; a long one turns the whole drawing into a tall thin ribbon in an
// empty canvas, which is the single worst thing this view can do.
function stackColumns(n, maxCols) {
  if (n < 5 || maxCols < 2) return 1;
  return Math.min(maxCols, Math.ceil(n / 4));
}
function cmLayout(tree, maxCols = 1) {
  const build = (v, parent) => {
    const s = sizeOf(v.n);
    const item = { id: v.id, n: v.n, v, w: s.w, h: s.h, kind: s.kind, depth: v.depth, parent, children: [], stacked: false, x: 0, y: 0 };
    for (const c of v.children) item.children.push(build(c, item));
    return item;
  };
  const root = build(tree, null);
  const all = [];
  const measure = (it) => {
    all.push(it);
    it.stack = it.children.filter((c) => c.children.length === 0);
    it.branches = it.children.filter((c) => c.children.length > 0);
    for (const c of it.stack) { c.stacked = true; all.push(c); }
    for (const c of it.branches) measure(c);
    it.cols = [];
    if (it.stack.length) {
      const n = stackColumns(it.stack.length, maxCols);
      const per = Math.ceil(it.stack.length / n);
      for (let i = 0; i < it.stack.length; i += per) it.cols.push(it.stack.slice(i, i + per));
    }
    it.colW = it.stack.length ? Math.max(...it.stack.map((c) => c.w)) + STACK_INDENT : 0;
    it.stackW = it.cols.length ? it.colW * it.cols.length + COL_GAP * (it.cols.length - 1) : 0;
    it.branchW = it.branches.reduce((s, c) => s + c.width, 0) + Math.max(0, it.branches.length - 1) * COL_GAP;
    it.inner = it.stackW + (it.stackW && it.branchW ? COL_GAP : 0) + it.branchW;
    it.width = Math.max(it.w, it.inner);
  };
  measure(root);
  const rowH = [];
  for (const it of all) if (!it.stacked) rowH[it.depth] = Math.max(rowH[it.depth] || 0, it.h);
  const rowY = [0];
  for (let d = 1; d <= rowH.length; d++) rowY[d] = rowY[d - 1] + (rowH[d - 1] || 0) + ROW_GAP;
  const place = (it, left) => {
    it.x = left + it.width / 2;
    it.y = rowY[it.depth];
    let cursor = left + (it.width - it.inner) / 2;
    if (it.cols.length) {
      it.spineX = [];
      for (const col of it.cols) {
        let y = rowY[it.depth + 1];
        for (const c of col) {
          c.x = cursor + STACK_INDENT + c.w / 2;
          c.y = y;
          y += c.h + STACK_GAP;
        }
        it.spineX.push(cursor + 1);
        cursor += it.colW + COL_GAP;
      }
    }
    for (const c of it.branches) { place(c, cursor); cursor += c.width + COL_GAP; }
  };
  place(root, 0);
  cm.nodes = all;
  const links = [];
  for (const it of all) {
    for (const c of it.branches || []) links.push({ key: c.id, kind: 'branch', s: it, t: c });
    for (let i = 0; i < (it.cols || []).length; i++) {
      const col = it.cols[i];
      const x = it.spineX[i];
      links.push({ key: `${it.id}:spine:${i}`, kind: 'spine', s: it, items: col, x });
      for (const c of col) links.push({ key: c.id, kind: 'elbow', s: it, t: c, x });
    }
  }
  cm.links = links;
}
// Tapered ribbon from the parent's bottom to the child's top: 6 px at the parent, 2 px at the child.
function ribbonPath(l) {
  const x0 = l.s.x; const y0 = l.s.y + l.s.h; const x1 = l.t.x; const y1 = l.t.y;
  const m = (y0 + y1) / 2;
  const a = 3; const b = 1;
  return `M${x0 - a},${y0} C${x0 - a},${m} ${x1 - b},${m} ${x1 - b},${y1} L${x1 + b},${y1} C${x1 + b},${m} ${x0 + a},${m} ${x0 + a},${y0} Z`;
}
function spinePath(l) {
  // Leaves the parent's own edge, wherever this column sits.
  const lo = l.s.x - l.s.w / 2 + 22;
  const hi = l.s.x + l.s.w / 2 - 22;
  const x0 = Math.min(hi, Math.max(lo, l.x)); const y0 = l.s.y + l.s.h - 2;
  const first = l.items[0]; const last = l.items[l.items.length - 1];
  const yTop = first.y + first.h / 2;
  const yEnd = last.y + last.h / 2;
  const c = Math.min(18, Math.max(8, (yTop - y0) / 2));
  return `M${x0},${y0} C${x0},${y0 + c} ${l.x},${yTop - c - 4} ${l.x},${yTop - 4} L${l.x},${yEnd}`;
}
function elbowPath(l) {
  const y = l.t.y + l.t.h / 2;
  const x1 = l.t.x - l.t.w / 2;
  return `M${l.x},${y - 6} Q${l.x},${y} ${l.x + 6},${y} L${x1},${y}`;
}
function linkPath(l) {
  return l.kind === 'branch' ? ribbonPath(l) : l.kind === 'spine' ? spinePath(l) : elbowPath(l);
}
function xlinkPath(s, t) {
  if (Math.abs(s.x - t.x) < (s.w + t.w) / 2) {
    const down = s.y < t.y;
    const y0 = down ? s.y + s.h : s.y;
    const y1 = down ? t.y : t.y + t.h;
    return `M${s.x},${y0} C${s.x},${(y0 + y1) / 2} ${t.x},${(y0 + y1) / 2} ${t.x},${y1}`;
  }
  const dir = t.x > s.x ? 1 : -1;
  const x0 = s.x + (dir * s.w) / 2;
  const x1 = t.x - (dir * t.w) / 2;
  const sy = s.y + s.h / 2;
  const ty = t.y + t.h / 2;
  const mx = (x0 + x1) / 2;
  return `M${x0},${sy} C${mx},${sy} ${mx},${ty} ${x1},${ty}`;
}
// Cross-links ("depends on"); a hidden endpoint is represented by its nearest visible ancestor.
function xlinkData(items) {
  const pos = new Map(items.map((d) => [d.id, d]));
  const seen = new Set();
  const out = [];
  for (const d of items) {
    for (const target of d.n.links || []) {
      let t = nodeOf(target);
      while (t && !pos.has(t.id)) t = nodeOf(t.parent);
      if (!t || t.id === d.id) continue;
      const key = `${d.id}|${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, from: d.id, to: t.id, s: d, t: pos.get(t.id) });
    }
  }
  return out;
}
const tf = (d, k) => `translate(${d.x},${d.y}) scale(${k == null ? 1 : k})`;
function renderCardMap() {
  const first = !cm.nodes.length;
  const tree = visibleTree();
  $('#allopen').hidden = !(state.scope === 'open' && !tree.children.length);
  cmBestLayout(tree);
  const sig = cm.nodes.map((d) => `${d.id}:${d.h}`).join(',');
  const structural = sig !== cm.sig;
  cm.sig = sig;
  const dur = first ? 0 : DUR;

  gEdges.selectAll('path').data(cm.links, (l) => l.key)
    .join(
      (enter) => enter.append('path').attr('d', linkPath).style('opacity', first ? 1 : 0),
      (update) => update,
      (exit) => exit.transition('out').duration(dur).style('opacity', 0).remove(),
    )
    .attr('class', (l) => `link ${l.kind}`)
    .transition('pos').duration(dur).attr('d', linkPath).style('opacity', 1);

  gX.selectAll('path').data(xlinkData(cm.nodes), (d) => d.key)
    .join('path')
    .attr('data-from', (d) => d.from).attr('data-to', (d) => d.to)
    .transition('pos').duration(dur).attr('d', (d) => xlinkPath(d.s, d.t));

  const g = gNodes.selectAll('g.node').data(cm.nodes, (d) => d.id)
    .join(
      (enter) => {
        // New cards grow out of their parent's position.
        const e = enter.append('g').attr('class', 'node')
          .attr('transform', (d) => (first || !d.parent ? tf(d) : tf(d.parent, 0.6)))
          .style('opacity', first ? 1 : 0);
        e.append('foreignObject').append('xhtml:div').attr('class', 'card').attr('tabindex', '0');
        return e;
      },
      (update) => update,
      (exit) => exit.transition('out').duration(dur).style('opacity', 0).attr('transform', (d) => (d.parent ? tf(d.parent, 0.6) : tf(d, 0.6))).remove(),
    );
  g.select('foreignObject').attr('width', (d) => d.w).attr('height', (d) => d.h).attr('x', (d) => -d.w / 2).attr('y', 0);
  g.transition('pos').duration(dur).ease(d3.easeCubicOut).attr('transform', (d) => tf(d)).style('opacity', 1);
  g.each(function (d) { syncCard(this.firstChild.firstChild, d.n, { collapsed: d.v.hidden > 0, hidden: d.v.hidden }); });

  applyXlinks();
  if ((first || structural) && !state.userMoved) fit(!first);
}
function applyXlinks() {
  const ids = new Set([state.hover, state.selected].filter(Boolean));
  gX.selectAll('path').classed('show', (d) => ids.has(d.from) || ids.has(d.to));
}
// Halos sit 8 px outside the box, dashed rings 5, count badges 9 below, unread dots
// 3 above-right, and spines 14 px to the left. Measure what is drawn, not the boxes.
const DECOR = 14;
function cmBounds() {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const d of cm.nodes) {
    x0 = Math.min(x0, d.x - d.w / 2); x1 = Math.max(x1, d.x + d.w / 2);
    y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y + d.h);
  }
  return { x0: x0 - DECOR, x1: x1 + DECOR, y0: y0 - DECOR, y1: y1 + DECOR };
}
function cmFrame() {
  const r = $('#cardmap').getBoundingClientRect();
  const ins = chromeInsets();
  return {
    r,
    ins,
    w: Math.max(120, r.width - ins.left - ins.right),
    h: Math.max(120, r.height - ins.top - ins.bottom),
    cap: r.width >= 1900 ? 1.7 : 1.25,
  };
}
// Fit and centre the whole visible tree in the free area. Scale is capped at 1.25.
function fitCardMap(animate) {
  const f = cmFrame();
  if (!cm.nodes.length || f.r.width < 20 || f.r.height < 20 || state.view !== 'map') { cm.sig = null; return; }
  const b = cmBounds();
  const k = Math.max(0.08, Math.min(f.cap, f.w / (b.x1 - b.x0), f.h / (b.y1 - b.y0)));
  const t = d3.zoomIdentity
    .translate(f.ins.left + (f.w - (b.x0 + b.x1) * k) / 2, f.ins.top + (f.h - (b.y0 + b.y1) * k) / 2)
    .scale(k);
  (animate && DUR ? cmSvg.transition().duration(DUR) : cmSvg).call(zoom.transform, t);
  state.userMoved = false;
}
// Lay the tree out at 1 to 4 stack columns and keep whichever fills the canvas best.
// An extra column has to buy at least 3 % more scale to be worth the extra width.
function cmBestLayout(tree) {
  const f = cmFrame();
  let best = { cols: 1, k: -1 };
  for (const cols of [1, 2, 3, 4]) {
    cmLayout(tree, cols);
    const b = cmBounds();
    const k = Math.min(f.cap, f.w / (b.x1 - b.x0), f.h / (b.y1 - b.y0));
    if (k > best.k * 1.03) best = { cols, k };
  }
  if (best.cols !== 4) cmLayout(tree, best.cols);
}
function bindCardMap() {
  // Click opens what is folded or selects; the count pill folds and unfolds; hover shows cross-links.
  // A click on empty space (never the end of a pan: d3-zoom swallows that one) clears the selection.
  const el = $('#cardmap');
  el.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c) { select(null); return; }
    if (e.target.closest('.badge')) { toggleCollapse(c.dataset.id); return; }
    clickNode(c.dataset.id);
  });
  el.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.card');
    const id = c ? c.dataset.id : null;
    if (id !== state.hover) { state.hover = id; applyXlinks(); }
  });
  el.addEventListener('mouseleave', () => { if (state.hover) { state.hover = null; applyXlinks(); } });
}
function fit(animate) {
  if (state.view === 'map') fitCardMap(animate);
  else fitOrbs(animate);
}

// ---------- outline ----------
function renderOutline() {
  const tree = visibleTree();
  $('#allopen').hidden = !(state.scope === 'open' && !tree.children.length);
  const rows = C.flatten(tree).map((it) => ({ id: it.id, n: it.n, depth: it.depth, kids: it.children.length > 0 || it.hidden > 0, collapsed: it.hidden > 0, hidden: it.hidden }));
  const row = d3.select('#outline').selectAll('div.row').data(rows, (d) => d.id)
    .join((enter) => {
      const r = enter.append('div').attr('class', 'row');
      r.append('button').attr('type', 'button').attr('class', 'chev').attr('aria-label', 'collapse or expand');
      r.append('div').attr('class', 'card').attr('tabindex', '0');
      return r;
    });
  row.order();
  row.attr('data-id', (d) => d.id).style('padding-left', (d) => `${d.depth * 24}px`);
  row.classed('open', (d) => Boolean(d.kids) && !d.collapsed);
  row.select('button.chev').html(icon('chevron')).attr('disabled', (d) => (d.kids ? null : true))
    .attr('aria-expanded', (d) => (d.kids ? String(!d.collapsed) : null));
  row.select('div.card').each(function (d) { syncCard(this, d.n, { collapsed: d.collapsed, hidden: d.hidden, status: true }); });
}

// ---------- done: the archive ----------
function renderDone() {
  const rows = C.doneList(state.map, state.kids);
  const el = $('#donelist');
  let html = `<div class="dl-head"><h2>Finished</h2><span class="muted">${rows.length ? `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}, newest first` : ''}</span></div>`;
  if (!rows.length) {
    html += '<div class="dl-empty">Nothing finished yet.</div>';
  } else {
    let day = null;
    html += '<ul>';
    for (const r of rows) {
      const d = fmtDay(r.when);
      if (d !== day) { day = d; html += `<li class="dl-day">${esc(d)}</li>`; }
      html += `<li class="dl-row st-${esc(r.n.status)}${r.n.id === state.selected ? ' selected' : ''}" data-id="${esc(r.n.id)}" data-sel="${esc(r.n.id)}" title="${esc(cardTitle(r.n))}">
        <i class="sdot" aria-hidden="true"></i>
        <span class="dl-when mono" title="${esc(r.when)}">${esc(fmtClock(r.when))}</span>
        <span class="dl-main">${r.path.length ? `<span class="dl-path">${r.path.map(esc).join(' › ')}</span>` : ''}<span class="dl-title">${esc(r.n.title)}</span>${r.note ? `<span class="dl-note">${esc(r.note)}</span>` : ''}</span>
      </li>`;
    }
    html += '</ul>';
  }
  if (el._sig !== html) { el.innerHTML = html; el._sig = html; }
}

// ---------- header ----------
function renderProjects() {
  const sel = $('#project-select');
  sel.innerHTML = state.projects.map((p) =>
    `<option value="${esc(p.id)}"${p.exists ? '' : ' disabled'}>${esc(p.name)}${p.exists ? '' : ' (missing)'}</option>`).join('');
  if (state.pid) sel.value = state.pid;
}
function renderHeader() {
  const m = state.map;
  $('#project-goal').textContent = m.goal || '';
  $('#project-goal').title = m.goal || '';
  renderRuns();
  const p = progressOf(rootId());
  $('#progress-bar').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
  $('#progress-label').textContent = `${p.done}/${p.total}`;
  const c = statusCounts();
  const unread = unreadCount();
  const cnt = (cls, n, label, title) => (n ? `<span class="cnt ${cls}" title="${title}"><i></i>${n} ${label}</span>` : '');
  const ipLeaves = Object.values(state.map.nodes).filter((x) => x.status === 'in_progress' && !hasKids(x.id)).length;
  $('#counts').innerHTML =
    cnt('st-in_progress', ipLeaves, 'in progress', 'tasks Claude is working on right now')
    + cnt('st-blocked', c.blocked, 'waiting on you', 'blocked, waiting for an answer')
    + cnt('unread', unread, unread === 1 ? 'message unread' : 'messages unread', 'messages Claude has not read yet');
  const sc = C.scopeCounts(state.map, state.kids);
  $('#n-open').textContent = sc.open ? String(sc.open) : '';
  $('#n-done').textContent = sc.done ? String(sc.done) : '';
  const now = nowNode();
  const nowEl = $('#now');
  nowEl.hidden = !now;
  if (now) {
    nowEl.dataset.sel = now.id;
    const path = focusPath(now.id);
    const note = lastNote(now);
    nowEl.title = `${path.concat(now.title).join(' › ')}${note ? '\n' + note : ''}`;
    nowEl.innerHTML = `<span class="k">Now</span>`
      + (path.length ? `<span class="path">${path.map(esc).join(' › ')} ›</span>` : '')
      + `<span class="t">${esc(now.title)}</span>`
      + (now.started_at ? `<span class="ago">for <span class="mono">${esc(ago(now.started_at))}</span></span>` : '')
      + (note ? `<span class="note">${esc(note)}</span>` : '');
  }
  renderWaiting();
  tickUpdated();
}
function renderWaiting() {
  const blocked = blockedNodes();
  const strip = $('#waiting');
  strip.hidden = !blocked.length;
  strip.style.top = `${Math.round($('#header').getBoundingClientRect().height)}px`;
  if (!blocked.length) { $('#waiting-list').innerHTML = ''; return; }
  $('#waiting-list').innerHTML = blocked.map((n) => `<li>
      <a href="#" class="w-title" data-sel="${esc(n.id)}">${esc(n.title)}</a>
      <span class="w-q" title="${esc(n.status_reason || '')}">${esc(question(n.status_reason))}</span>
      <button type="button" class="w-reply" data-reply="${esc(n.id)}">Reply</button>
    </li>`).join('');
}
function tickUpdated() {
  $('#updated').textContent = state.map && state.map.updated ? `updated ${ago(state.map.updated)} ago` : '';
  const now = state.map && nowNode();
  const agoEl = $('#now .ago .mono');
  if (now && agoEl && now.started_at) agoEl.textContent = ago(now.started_at);
}
function setLive(mode) {
  const el = $('#live');
  el.className = `live ${mode}`;
  $('#live-text').textContent = mode === 'on' ? 'live' : mode === 'off' ? 'disconnected' : 'connecting';
}
function notice(msg) {
  const el = $('#notice');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- prompts: how far each prompt has got, and when it should be done ----------
// The server sends a summary per prompt (src/runs.js) whenever the map or runs.json
// changes; in between, a 30 s tick moves the numbers with the same formula, and stops
// while the tab is hidden. No polling.
const RUN_TICK_MS = 30000;
const PR = window.Prompts;
const serverNow = () => Date.now() + state.skew;
function shownRuns() {
  const list = state.runs;
  if (state.pinnedRun) {
    const r = list.find((x) => x.id === state.pinnedRun);
    if (r) return [r];
    state.pinnedRun = null;
  }
  const live = list.filter((r) => r.state === 'running');
  return live.length ? live.slice(0, 3) : list.slice(0, 1);
}
function runRowHtml(r, now, label) {
  const { cls, big, eta, small, pct } = PR.words(r, now);
  const fill = r.state === 'done' ? 1 : pct || 0;
  const tip = `${r.prompt}\n${r.done} of ${r.steps} steps done${r.total > r.steps ? '; milestones not broken down yet count as several' : ''} · started ${fmtClock(r.started)}${r.follow_ups ? ` · ${r.follow_ups} more message${r.follow_ups > 1 ? 's' : ''} while it ran` : ''}${r.agents ? ` · Claude is waiting on ${r.agents} background agent${r.agents > 1 ? 's' : ''}` : ''}${r.estimate_ms ? `\nClaude estimated ${PR.fmtDur(r.estimate_ms)} at ${fmtClock(r.estimate_at)}` : r.state === 'running' ? '\nNo estimate from Claude: the ETA comes from finished steps' : ''}`;
  // Six cells per prompt, laid out by the grid on #run-rows so stacked prompts line up.
  return `<div class="run st-${cls}" data-run-row="${esc(r.id)}">`
    + `<span class="k">${esc(label)}</span>`
    + `<span class="run-p" title="${esc(tip)}">${esc(r.prompt || '(no text)')}</span>`
    + `<span class="run-bar" title="${esc(tip)}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fill * 100)}"><i style="transform:scaleX(${fill.toFixed(4)})"></i></span>`
    + `<span class="run-big mono">${esc(big)}</span>`
    + `<span class="run-eta"${eta && eta.startsWith('ETA ~') ? ' title="~ taskmap\'s estimate from finished steps; Claude gave none"' : ''}>${esc(eta || '')}</span>`
    + `<span class="run-small">${esc(small)}${state.pinnedRun ? ' <button type="button" class="linkish" data-run-live>Back to live</button>' : ''}</span>`
    + '</div>';
}
function renderRuns() {
  const box = $('#prompts');
  const list = state.runs;
  box.hidden = !list.length;
  $('#run-count').textContent = list.length > 1 ? String(list.length) : '';
  const now = serverNow();
  const shown = shownRuns();
  const latest = list[0];
  const html = shown.map((r) => runRowHtml(r, now, state.pinnedRun && r !== latest ? 'Earlier prompt' : shown.length > 1 ? 'Prompt' : r.state === 'running' ? 'This prompt' : 'Last prompt')).join('');
  const rows = $('#run-rows');
  if (rows._sig !== html) { rows.innerHTML = html; rows._sig = html; }
  if (!$('#run-menu').hidden) renderRunMenu();
  // A glance at the tab strip answers "is it done yet?".
  const live = shown.filter((r) => r.state === 'running' && r.total);
  const name = state.map ? state.map.name || state.pid : state.pid;
  if (live.length) {
    const x = PR.extrapolate(live[0], now);
    document.title = `${PR.pctText(x.pct)}${x.eta_ms !== null ? ` · ${PR.etaText(live[0], x.eta_ms)}` : ''} · ${name}`;
  } else document.title = `${name} · taskmap`;
}
function renderRunMenu() {
  const now = serverNow();
  $('#run-menu').innerHTML = state.runs.map((r) => {
    const { cls, big, eta, small } = PR.words(r, now);
    const on = shownRuns().includes(r);
    return `<button type="button" role="menuitem" class="run-item st-${cls}${on ? ' on' : ''}" data-run="${esc(r.id)}" title="${esc(r.prompt)}">`
      + `<i class="dot"></i><span class="p">${esc(r.prompt || '(no text)')}</span>`
      + `<span class="r mono">${esc(r.state === 'done' ? `done · ${PR.fmtDur(r.elapsed_ms)}` : r.state === 'running' ? [big, eta].filter(Boolean).join(' · ') : `${big} · ${small.split(' · ')[0]}`)}</span>`
      + `<span class="w mono">${esc(fmtDay(r.started) === fmtDay(new Date(now).toISOString()) ? fmtClock(r.started) : fmtDay(r.started))}</span>`
      + '</button>';
  }).join('');
}
function openRunMenu(open) {
  const menu = $('#run-menu');
  menu.hidden = !open;
  $('#run-pick').setAttribute('aria-expanded', String(open));
  if (open) renderRunMenu();
}
function setRuns(runs, now) {
  if (!Array.isArray(runs)) return;
  state.runs = runs;
  if (Number.isFinite(now)) state.skew = now - Date.now();
  renderRuns();
}
function tickRuns() {
  if (!document.hidden && state.runs.length) renderRuns();
}

// ---------- side panel ----------
function titleLink(id) {
  const t = nodeOf(id);
  return `<a href="#" data-sel="${esc(id)}" title="${esc(id)}">${esc(t ? t.title : id)}</a>`;
}
function panelHtml(n) {
  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v${v ? '' : ' empty'}">${v ? esc(v) : 'Not written yet.'}</div></div>`;
  const tsRow = (ts, extra) => `<div class="ts-row"><span class="mono ts" title="${esc(ts)}">${esc(fmtTime(ts))}</span>${extra || ''}</div>`;
  const notes = (n.notes || []).map((x) => `<li>${tsRow(x.ts)}<span class="t">${esc(x.text)}</span></li>`).join('');
  const fb = (n.feedback || []).map((f) => {
    const sys = (f.kind || 'feedback') !== 'feedback';
    const tag = f.read ? '' : '<span class="unread-tag" title="Claude reads it on its next inbox check"><i></i>not read by Claude yet</span>';
    return `<li class="${sys ? 'sys' : 'fb'}${f.read ? '' : ' unread'}">${tsRow(f.ts, tag)}<span class="t">${esc(f.text)}</span></li>`;
  }).join('');
  const prog = hasKids(n.id) ? progressOf(n.id) : null;
  const foot = [];
  if (n.parent) foot.push(`<span class="fk">in</span> ${titleLink(n.parent)}`);
  if ((n.links || []).length) foot.push(`<span class="fk">after</span> ${n.links.map(titleLink).join(', ')}`);
  foot.push(`<span class="fk">added by</span> ${n.source === 'user' ? 'you' : 'Claude'}`);
  if (n.created) foot.push(`<span class="fk">created</span> <span class="mono">${esc(fmtTime(n.created))}</span>`);
  if (n.started_at) foot.push(`<span class="fk">started</span> <span class="mono">${esc(fmtTime(n.started_at))}</span>`);
  if (n.finished_at) foot.push(`<span class="fk">finished</span> <span class="mono">${esc(fmtTime(n.finished_at))}</span>`);
  return `
    <div class="p-head">
      <span class="chip st-${esc(n.status)}"><i></i>${LABEL[n.status] || esc(n.status)}</span>
      ${prog ? `<span class="p-prog"><span class="mono">${prog.done}/${prog.total}</span> leaves done</span>` : ''}
      ${n.source === 'user' ? '<span class="chip user">added by you</span>' : ''}
      <span class="mono id">${esc(n.id)}</span>
    </div>
    <h2 class="p-title">${esc(n.title)}</h2>
    ${n.status_reason ? `<div class="p-reason st-${esc(n.status)}"><span class="k">${n.status === 'blocked' ? 'Waiting on you' : 'Skipped because'}</span>${esc(n.status === 'blocked' ? question(n.status_reason) : n.status_reason)}</div>` : ''}
    ${kv('What', n.what)}${kv('Why', n.why)}${kv('Done when', n.done_when)}
    <div class="p-sec"><div class="k">Notes${notes ? ` · ${n.notes.length}` : ''}</div>${notes ? `<ul class="timeline">${notes}</ul>` : '<div class="empty">No notes yet.</div>'}</div>
    <div class="p-sec"><div class="k">Feedback${fb ? ` · ${n.feedback.length}` : ''}</div>${fb ? `<ul class="timeline">${fb}</ul>` : '<div class="empty">No feedback yet.</div>'}</div>
    <div class="p-foot">${foot.join('<span class="sep">·</span>')}</div>`;
}
const LEGEND = [
  ['pending', 'Not started yet'],
  ['in_progress', 'Claude is on this one'],
  ['done', 'Finished and checked'],
  ['blocked', 'Waiting on your answer'],
  ['skipped', 'Dropped, with a reason'],
];
function emptyPanelHtml() {
  if (!state.map) return '<div class="placeholder">Loading the map…</div>';
  const blocked = blockedNodes();
  const now = nowNode();
  const p = progressOf(rootId());
  let head;
  if (blocked.length) {
    const b = blocked[0];
    head = `<div class="ask">
      <span class="k">Waiting on you</span>
      <span class="q">${esc(question(b.status_reason))}</span>
      <button type="button" class="primary w-reply" data-reply="${esc(b.id)}">${icon('reply')} Answer this</button>
    </div>`;
  } else if (now) {
    const path = focusPath(now.id);
    const note = lastNote(now);
    head = `<div><h2>Claude is working</h2><p class="lead">On <strong>${esc(now.title)}</strong>${path.length ? ` (${esc(path.join(' › '))})` : ''}${now.started_at ? `, for ${esc(ago(now.started_at))}` : ''}.${note ? ` Last note: <em>${esc(note)}</em>.` : ''}</p></div>`;
  } else if (p.total && p.done === p.total) {
    head = `<div><h2>All done</h2><p class="lead">Every task on this map is finished. The Done tab lists them; pick one to read what was decided.</p></div>`;
  } else {
    head = `<div><h2>Nothing in progress</h2><p class="lead">Pick a task to read it or message Claude about it.</p></div>`;
  }
  return `<div class="p-empty">
    ${head}
    <div>
      <span class="k">What the colours mean</span>
      <ul class="legend">
        ${LEGEND.map(([st, text]) => `<li><span class="swatch st-${st}"><i class="sdot"></i></span>${esc(text)}</li>`).join('')}
        <li><span class="swatch dashed"><i class="sdot"></i></span>You added it from here</li>
        <li><span class="swatch unread"><i class="sdot"></i></span>A message Claude has not read</li>
      </ul>
    </div>
    <div>
      <span class="k">Shortcuts</span>
      <ul class="keys">
        <li><kbd>click</kbd>Open a task and its branch; again to fold it</li>
        <li><kbd>click</kbd>Empty space: back to this key</li>
        <li><kbd>right-click</kbd>A task's actions, and Copy id</li>
        <li><kbd>drag</kbd>${state.view === 'orbs' ? 'Turn' : 'Move'} the map; scroll or pinch to zoom</li>
        <li><kbd>f</kbd>Fit to the window${state.view === 'orbs' ? '; <kbd>o</kbd> pauses the turning' : ''}</li>
        <li><kbd>1</kbd>–<kbd>4</kbd>Map, Graph, 3D, List</li>
      </ul>
    </div>
  </div>`;
}
function renderPanel() {
  const n = state.selected ? nodeOf(state.selected) : null;
  const content = $('#panel-content');
  const actions = $('#panel-actions');
  if (!n) {
    const html = emptyPanelHtml();
    if (content._sig !== html) { content.innerHTML = html; content._sig = html; }
    actions.hidden = true;
    return;
  }
  const html = panelHtml(n);
  if (content._sig !== html) { content.innerHTML = html; content._sig = html; }
  actions.hidden = false;
  const rules = actionRules(n);
  for (const [act, r] of Object.entries(rules)) {
    const b = $(`#panel-actions [data-act="${act}"]`);
    b.disabled = r.disabled;
    b.title = r.title;
  }
  $('#fb-text').placeholder = n.status === 'blocked' ? 'Answer the question above…' : 'Tell Claude something about this task…';
  syncSend();
}
// Which of a node's actions apply: shared by the panel buttons and the right-click menu.
function actionRules(n) {
  const deep = depthOf(n.id) >= 3;
  const prog = hasKids(n.id) ? progressOf(n.id) : null;
  const open = prog && prog.done < prog.total;
  return {
    subtask: { disabled: deep, title: deep ? 'Steps cannot have subtasks (the map is three levels deep at most).' : 'Add a child node under this one' },
    reopen: { disabled: n.status === 'pending', title: 'Put it back to not started' },
    block: { disabled: n.status === 'blocked', title: 'Claude waits for your answer on it' },
    skip: { disabled: n.status === 'skipped', title: 'Drop it, with a reason' },
    done: { disabled: n.status === 'done' || Boolean(open), title: open ? `${prog.total - prog.done} leaves underneath are not done yet` : 'Mark this node done' },
  };
}

// ---------- right-click menu: the panel's actions where the pointer is ----------
const CTX_ITEMS = [
  ['reply', 'message', 'Message Claude'],
  ['subtask', 'plus', 'Add subtask…'],
  null,
  ['done', 'check', 'Mark done'],
  ['reopen', 'back', 'Reopen'],
  ['block', null, 'Mark blocked…'],
  ['skip', 'close', 'Not needed…'],
  null,
  ['copy', null, 'Copy id'],
];
function nodeAtEvent(e) {
  const t = e.target;
  if (!t || !t.closest) return null;
  const el = t.closest('#cardmap .card, #outline .row, #labels .label, #donelist .dl-row');
  if (el) return nodeOf(el.dataset.id) ? el.dataset.id : null;
  if (t.closest('#graph') && (state.view === 'graph' || state.view === 'orbs')) {
    const id = hitTest(e.clientX, e.clientY);
    return id && nodeOf(id) ? id : null;
  }
  return null;
}
function openCtx(id, x, y) {
  const n = nodeOf(id);
  if (!n) return;
  const rules = actionRules(n);
  const menu = $('#ctx');
  menu.dataset.id = id;
  menu.innerHTML = `<div class="ctx-head"><i class="ctx-dot st-${esc(n.status)}"></i><span>${esc(n.title)}</span></div>`
    + CTX_ITEMS.map((it) => {
      if (!it) return '<hr>';
      const [act, ic, label] = it;
      const r = rules[act] || { disabled: false, title: act === 'copy' ? `Copy "${id}" to reference it in a chat (taskmap show ${id})` : 'Write to Claude about this task' };
      const tail = act === 'copy' ? ` <span class="mono ctx-id">${esc(id)}</span>` : '';
      return `<button type="button" role="menuitem" data-ctx="${act}"${r.disabled ? ' disabled' : ''} title="${esc(r.title)}">${ic ? icon(ic) : '<span class="ic-blank"></span>'}${esc(label)}${tail}</button>`;
    }).join('');
  menu.hidden = false;
  // Keep it on screen: flip left or up when the pointer is near an edge.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, x + w > innerWidth - 8 ? x - w : x)}px`;
  menu.style.top = `${Math.max(8, y + h > innerHeight - 8 ? y - h : y)}px`;
  const first = menu.querySelector('button:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}
function closeCtx() {
  const menu = $('#ctx');
  if (menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // no clipboard API (plain http on a LAN address): the old way
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}
function ctxAct(act, id) {
  if (act === 'copy') {
    const b = $('#ctx [data-ctx="copy"]');
    copyText(id).then((ok) => {
      if (b) b.innerHTML = `${icon('check')}${ok ? 'Copied' : 'Could not copy'} <span class="mono ctx-id">${esc(id)}</span>`;
      setTimeout(closeCtx, ok ? 450 : 1200);
    });
    return;
  }
  closeCtx();
  if (!nodeOf(id)) return;
  if (state.selected !== id) select(id, { sheet: false });
  if (act === 'reply') { replyTo(id); if (narrow()) setSheet(true); return; }
  if (act === 'done') { setStatus(id, 'done'); return; }
  if (act === 'reopen') { setStatus(id, 'pending'); return; }
  // Subtask, blocked and skipped need a line of text: the panel's inline form asks for it.
  if (narrow()) setSheet(true);
  openInline(act);
  $('#inline-form').scrollIntoView({ block: 'nearest' });
}
function bindCtx() {
  document.addEventListener('contextmenu', (e) => {
    const id = nodeAtEvent(e);
    if (!id) { closeCtx(); return; } // anywhere else keeps the browser's own menu
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    if (!x && !y) { const r = e.target.getBoundingClientRect(); x = r.left + 12; y = r.bottom + 4; } // the menu key on a focused card
    openCtx(id, x, y);
  });
  const menu = $('#ctx');
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctx]');
    if (b && !b.disabled) ctxAct(b.dataset.ctx, menu.dataset.id);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeCtx();
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) closeCtx(); }, true);
  window.addEventListener('wheel', closeCtx, { passive: true });
  window.addEventListener('resize', closeCtx);
  window.addEventListener('blur', closeCtx);
}

function syncSend() { $('#fb-send').disabled = !$('#fb-text').value.trim() || $('#fb-send').classList.contains('busy'); }
function panelError(msg) {
  const el = $('#panel-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}
function openInline(mode) {
  state.inlineMode = mode;
  const form = $('#inline-form');
  $('#inline-label').textContent = mode === 'subtask' ? 'Subtask title' : mode === 'skip' ? 'Why is it not needed?' : 'What does Claude need from you?';
  $('#inline-ok').textContent = mode === 'subtask' ? 'Add' : mode === 'skip' ? 'Skip it' : 'Mark blocked';
  $('#inline-input').value = '';
  $('#inline-input').maxLength = mode === 'subtask' ? 200 : 1000;
  form.hidden = false;
  $('#inline-input').focus();
}
function closeInline() {
  state.inlineMode = null;
  $('#inline-form').hidden = true;
}
function sentFlash() {
  const btn = $('#fb-send');
  btn.textContent = 'Sent';
  btn.classList.add('sent');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = 'Send'; btn.classList.remove('sent'); }, 1500);
}

// ---------- activity feed ----------
function activityDetail(e) {
  const d = e.detail || {};
  const lbl = (s) => LABEL[s] || s || '?';
  switch (e.type) {
    case 'init': return d.goal || '';
    case 'add': { const p = nodeOf(d.parent); return `under ${p ? p.title : d.parent || '?'}`; }
    case 'start': case 'done': case 'block': case 'skip': case 'reopen': case 'status':
      return `${lbl(d.from)} → ${lbl(d.to)}${d.reason ? `: ${d.reason}` : ''}${d.note ? ` — ${d.note}` : ''}`;
    case 'edit': return `changed ${(d.fields || []).join(', ')}`;
    case 'note': case 'feedback': return d.text || '';
    case 'read': return `${d.count == null ? '' : d.count} marked read`;
    default: return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}
function renderActivity() {
  const list = state.log.slice().reverse();
  $('#activity-count').textContent = list.length ? String(list.length) : '';
  $('#activity-list').innerHTML = list.map((e) => {
    const n = nodeOf(e.node);
    const title = n ? n.title : e.node;
    const verb = e.type === 'status' ? ({ done: 'finished', blocked: 'blocked', pending: 'reopened', skipped: 'skipped', in_progress: 'started' }[(e.detail || {}).to] || 'set') : (VERB[e.type] || e.type);
    return `<div class="act actor-${esc(e.actor)}" data-sel="${esc(e.node)}">
      <span class="mono ts" title="${esc(e.ts)}">${esc(fmtTime(e.ts))}</span>
      <span class="who">${esc(ACTOR[e.actor] || e.actor)}</span>
      <span class="what" title="${esc(verb)} ${esc(title)}"><span class="verb">${esc(verb)}</span> <span class="ntitle" title="${esc(title)}">${esc(title)}</span></span>
      <span class="detail" title="${esc(activityDetail(e))}">${esc(activityDetail(e))}</span>
    </div>`;
  }).join('') || '<div class="placeholder">No activity yet.</div>';
}

// ---------- rendering ----------
function applyView() {
  const main = $('#main');
  const done = state.scope === 'done';
  for (const v of VIEWS) main.classList.toggle(`view-${v}`, !done && state.view === v);
  main.classList.toggle('view-done', done);
  for (const b of document.querySelectorAll('.seg button[data-view]')) { b.setAttribute('aria-pressed', String(b.dataset.view === state.view)); b.disabled = done; }
  for (const b of document.querySelectorAll('.seg button[data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === state.scope));
  $('#fit-btn').disabled = done || state.view === 'outline';
}
function renderMain() {
  const empty = !hasKids(rootId());
  $('#main').classList.toggle('is-empty', empty);
  if (empty) { stopScene(); $('#allopen').hidden = true; return; }
  if (state.scope === 'done') { stopScene(); $('#allopen').hidden = true; renderDone(); return; }
  if (orbView()) renderGraph();
  else if (state.view === 'map') { stopScene(); renderCardMap(); }
  else { stopScene(); renderOutline(); }
}
function applySelection() {
  for (const el of document.querySelectorAll('.card, .label, .dl-row')) el.classList.toggle('selected', el.dataset.id === state.selected);
  if (state.view === 'map') applyXlinks();
  wake();
}
function render() {
  if (!state.map) return;
  renderHeader();
  renderMain();
  renderPanel();
  renderActivity();
}
function setMap(map, log) {
  if (!map || !map.nodes) return;
  if (state.map && map.version === state.map.version && (log || []).length === state.log.length) return;
  state.map = map;
  state.log = log || [];
  buildIndex();
  if (state.autoCollapse) {
    // First visit in this browser session: start with finished milestones folded, like `taskmap tree --open`.
    state.autoCollapse = false;
    for (const k of kidsOf(rootId())) if (hasKids(k.id) && isClosed(k.id)) state.collapsed.add(k.id);
    ss.set(`taskmap:collapsed:${state.pid}`, [...state.collapsed]);
  }
  if (state.selected && !nodeOf(state.selected)) select(null);
  render();
}

// ---------- selection, collapse, scope, view ----------
function select(id, { sheet = true } = {}) {
  if (id === state.selected) return;
  if (state.selected) {
    const draft = $('#fb-text').value;
    if (draft.trim()) state.drafts[state.selected] = draft; else delete state.drafts[state.selected];
  }
  state.selected = id && nodeOf(id) ? id : null;
  ss.set(`taskmap:selected:${state.pid}`, state.selected);
  $('#fb-text').value = (state.selected && state.drafts[state.selected]) || '';
  closeInline();
  panelError('');
  applySelection();
  renderPanel();
  if (narrow() && (sheet || !state.selected)) setSheet(Boolean(state.selected));
}
const visibleItem = (id) => C.flatten(visibleTree()).find((it) => it.id === id);
function saveFolds() {
  ss.set(`taskmap:collapsed:${state.pid}`, [...state.collapsed]);
  ss.set(`taskmap:expanded:${state.pid}`, [...state.expanded]);
}
// Shows every child of `id`, finished ones included; fold() hides them all again.
function reveal(id) {
  state.collapsed.delete(id);
  state.expanded.add(id);
  saveFolds();
  renderMain();
}
function fold(id) {
  if (id !== rootId()) state.collapsed.add(id);
  state.expanded.delete(id);
  saveFolds();
  renderMain();
}
// The count pill, the chevron: open what is hidden, else fold.
function toggleCollapse(id) {
  const it = visibleItem(id);
  if (!it || it.kind === 'leaf') return;
  if (it.hidden > 0) reveal(id); else fold(id);
}
// One click on a task, in any view: see C.clickAction. Opening a branch on a phone
// leaves the sheet shut so the new tasks are in view.
function clickNode(id) {
  const act = C.clickAction(visibleItem(id), state.selected);
  if (act === 'reveal') reveal(id);
  else if (act === 'fold') fold(id);
  select(id, { sheet: act !== 'reveal' });
}
// On a phone the side panel is a sheet over the map rather than a column beside it.
function setSheet(open) {
  document.body.classList.toggle('sheet-open', Boolean(open));
  if (open) $('#side').scrollTop = 0;
}
function replyToSelected() {
  if (!state.selected) return;
  if (narrow()) setSheet(true);
  $('#panel').scrollTop = $('#panel').scrollHeight;
  $('#fb-text').focus();
}
function setView(v) {
  if (!VIEWS.includes(v) || v === state.view) return;
  state.view = v;
  ss.set(`taskmap:view:${state.pid}`, v);
  state.userMoved = false; // a new view is a new picture: refit it
  graphEl.classList.remove('over');
  applyView();
  renderMain();
  renderPanel();
}
function setScope(sc) {
  if (!['open', 'done', 'all'].includes(sc) || sc === state.scope) return;
  state.scope = sc;
  ss.set(`taskmap:scope:${state.pid}`, sc);
  state.userMoved = false; // a new scope is a new picture: refit it
  applyView();
  renderMain();
}
function replyTo(id) {
  select(id);
  $('#panel').scrollTop = 0;
  $('#fb-text').focus();
}

// ---------- actions (POST) ----------
async function sendFeedback() {
  const ta = $('#fb-text');
  const text = ta.value.trim();
  if (!text || !state.selected) return;
  const btn = $('#fb-send');
  btn.classList.add('busy');
  syncSend();
  try {
    await api('POST', `${projPath()}/feedback`, { node: state.selected, text });
    ta.value = '';
    delete state.drafts[state.selected];
    panelError('');
    sentFlash();
    loadProject();
  } catch (e) {
    panelError(e.message);
  } finally {
    btn.classList.remove('busy');
    syncSend();
  }
}
let undoTimer = null;
function showUndo(msg, fn) {
  const el = $('#undo');
  if (!el) return;
  clearTimeout(undoTimer);
  $('#undo-msg').textContent = msg;
  el.hidden = false;
  el._fn = fn;
  undoTimer = setTimeout(hideUndo, 12000);
}
function hideUndo() {
  const el = $('#undo');
  if (!el) return;
  clearTimeout(undoTimer);
  el.hidden = true;
  el._fn = null;
}
async function setStatus(nid, status, reason, { undoable = true } = {}) {
  const btns = document.querySelectorAll('[data-act]');
  const was = nodeOf(nid);
  const from = was ? was.status : null;
  const fromReason = was ? was.status_reason : null;
  for (const b of btns) b.disabled = true;
  try {
    await api('POST', `${projPath()}/nodes/${encodeURIComponent(nid)}/status`, reason ? { status, reason } : { status });
    panelError('');
    closeInline();
    await loadProject();
    if (undoable && from && from !== status) {
      showUndo(`Set to ${LABEL[status] || status}.`, () => setStatus(nid, from, fromReason || undefined, { undoable: false }));
    }
  } catch (e) {
    panelError(e.message);
  } finally {
    renderPanel();
  }
}
async function addNode(parent, title, what, why) {
  const body = { parent, title };
  if (what) body.what = what;
  if (why) body.why = why;
  const r = await api('POST', `${projPath()}/nodes`, body);
  if (parent !== rootId() && state.collapsed.has(parent)) toggleCollapse(parent);
  await loadProject();
  if (r.id) select(r.id);
  return r;
}
async function submitInline(ev) {
  ev.preventDefault();
  const value = $('#inline-input').value.trim();
  if (!value || !state.selected) return;
  if (state.inlineMode === 'subtask') {
    try { await addNode(state.selected, value); closeInline(); panelError(''); } catch (e) { panelError(e.message); }
  } else if (state.inlineMode === 'block') {
    await setStatus(state.selected, 'blocked', value);
  } else if (state.inlineMode === 'skip') {
    await setStatus(state.selected, 'skipped', value);
  }
}
async function submitAddTop(ev) {
  ev.preventDefault();
  const title = $('#add-title').value.trim();
  if (!title) return;
  const err = $('#add-error');
  err.textContent = '';
  try {
    await addNode(rootId(), title, $('#add-what').value.trim(), $('#add-why').value.trim());
    toggleAddForm(false);
  } catch (e) {
    err.textContent = e.message;
  }
}
function toggleAddForm(open) {
  const form = $('#add-form');
  form.hidden = !open;
  $('#add-top-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#add-title').focus();
  } else {
    for (const id of ['add-title', 'add-what', 'add-why']) $(`#${id}`).value = '';
    $('#add-error').textContent = '';
  }
}

// ---------- loading and live feed ----------
async function refreshProjects() {
  try {
    const r = await api('GET', '/api/projects');
    state.projects = r.projects || [];
    renderProjects();
  } catch (e) { /* keep the old list */ }
}
async function loadProject() {
  try {
    const r = await api('GET', projPath());
    notice('');
    setRuns(r.runs, r.now);
    setMap(r.map, r.log);
  } catch (e) {
    notice(`Could not load the project: ${e.message}`);
  }
}
function disconnect() {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.es) { state.es.close(); state.es = null; }
}
function connect() {
  disconnect();
  setLive(state.everConnected ? 'off' : 'connecting');
  const es = new EventSource(`${projPath()}/events`);
  state.es = es;
  es.onopen = () => {
    if (state.es !== es) return;
    const reconnect = state.everConnected;
    state.everConnected = true;
    state.retryMs = 1000;
    setLive('on');
    if (reconnect) { loadProject(); refreshProjects(); }
  };
  es.onmessage = (ev) => {
    if (state.es !== es) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg && msg.type === 'map') { setRuns(msg.runs, msg.now); setMap(msg.map, msg.log); }
  };
  es.onerror = () => {
    es.close();
    if (state.es !== es) return;
    state.es = null;
    setLive('off');
    const wait = state.retryMs;
    state.retryMs = Math.min(15000, wait * 2);
    state.retryTimer = setTimeout(connect, wait);
  };
}
function switchProject(id) {
  disconnect();
  state.pid = id;
  state.map = null;
  state.log = [];
  state.kids = new Map();
  state.hover = null;
  state.everConnected = false;
  state.retryMs = 1000;
  state.userMoved = false;
  state.drafts = {};
  state.runs = [];
  state.pinnedRun = null;
  openRunMenu(false);
  $('#prompts').hidden = true;
  state.selected = ss.get(`taskmap:selected:${id}`, null);
  const storedCollapsed = ss.get(`taskmap:collapsed:${id}`, null);
  state.autoCollapse = storedCollapsed === null;
  state.collapsed = new Set(storedCollapsed || []);
  state.expanded = new Set(ss.get(`taskmap:expanded:${id}`, []));
  const view = ss.get(`taskmap:view:${id}`, null);
  state.view = VIEWS.includes(view) ? view : narrow() ? 'outline' : 'map';
  state.scope = ss.get(`taskmap:scope:${id}`, 'open');
  $('#fb-text').value = '';
  closeInline();
  panelError('');
  toggleAddForm(false);
  resetScene();
  gEdges.selectAll('*').remove(); gX.selectAll('*').remove(); gNodes.selectAll('*').remove();
  cm.nodes = []; cm.links = []; cm.sig = null;
  $('#outline').innerHTML = '';
  $('#donelist').innerHTML = '';
  $('#donelist')._sig = null;
  $('#panel-content')._sig = null;
  renderProjects();
  applyView();
  renderPanel();
  history.replaceState(null, '', projectPath(id));
  loadProject().then(connect);
}

// ---------- events ----------
function bindEvents() {
  $('#project-select').addEventListener('change', (e) => { if (e.target.value && e.target.value !== state.pid) switchProject(e.target.value); });
  for (const b of document.querySelectorAll('.seg button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const b of document.querySelectorAll('[data-scope]')) b.addEventListener('click', () => setScope(b.dataset.scope));
  $('#fit-btn').addEventListener('click', () => fit(true));
  $('#add-top-btn').addEventListener('click', () => toggleAddForm($('#add-form').hidden));
  $('#add-cancel').addEventListener('click', () => toggleAddForm(false));
  $('#add-form').addEventListener('submit', submitAddTop);
  $('#sheet-close').addEventListener('click', () => setSheet(false));
  $('#sheet-backdrop').addEventListener('click', () => setSheet(false));
  $('#sheet-reply').addEventListener('click', replyToSelected);
  if (NARROW_Q && NARROW_Q.addEventListener) NARROW_Q.addEventListener('change', () => { setSheet(false); if (!state.userMoved) fit(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) setSheet(false); });
  $('#activity-toggle').addEventListener('click', () => {
    const collapsed = $('#side').classList.toggle('act-collapsed');
    $('#activity-toggle').setAttribute('aria-expanded', String(!collapsed));
    ss.set('taskmap:activity-collapsed', collapsed);
  });
  if (ss.get('taskmap:activity-collapsed', false)) { $('#side').classList.add('act-collapsed'); $('#activity-toggle').setAttribute('aria-expanded', 'false'); }
  state.orbit = ss.get('taskmap:orbit', true);

  bindGraph();
  bindCardMap();
  bindCtx();

  // List: the chevron or the count pill folds, a click opens what is folded or selects.
  const outline = $('#outline');
  outline.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row && (e.target.closest('.chev') || e.target.closest('.badge'))) toggleCollapse(row.dataset.id);
    else if (row && e.target.closest('.card')) clickNode(row.dataset.id);
    else select(null);
  });
  $('#donelist').addEventListener('click', (e) => { if (!e.target.closest('[data-sel], a, button')) select(null); });

  // Side panel, strip and activity feed.
  $('#fb-send').addEventListener('click', sendFeedback);
  $('#fb-text').addEventListener('input', syncSend);
  $('#fb-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFeedback(); } });
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => {
      if (!state.selected) return;
      const act = b.dataset.act;
      if (act === 'subtask') openInline('subtask');
      else if (act === 'block') openInline('block');
      else if (act === 'skip') openInline('skip');
      else if (act === 'done') setStatus(state.selected, 'done');
      else if (act === 'reopen') setStatus(state.selected, 'pending');
    });
  }
  $('#undo-btn').addEventListener('click', () => {
    const fn = $('#undo')._fn;
    hideUndo();
    if (fn) fn();
  });
  $('#inline-form').addEventListener('submit', submitInline);
  $('#inline-cancel').addEventListener('click', closeInline);
  $('#run-pick').addEventListener('click', () => openRunMenu($('#run-menu').hidden));
  $('#prompts').addEventListener('click', (e) => {
    const item = e.target.closest('[data-run]');
    if (item) {
      const r = state.runs.find((x) => x.id === item.dataset.run);
      // Picking a running prompt goes back to following whatever is live.
      state.pinnedRun = r && r.state !== 'running' && r !== state.runs[0] ? r.id : null;
      openRunMenu(false);
      renderRuns();
      return;
    }
    if (e.target.closest('[data-run-live]')) { state.pinnedRun = null; renderRuns(); }
  });
  document.addEventListener('click', (e) => {
    if (!$('#run-menu').hidden && !e.target.closest('.run-side')) openRunMenu(false);
    const r = e.target.closest('[data-reply]');
    if (r && nodeOf(r.dataset.reply)) { replyTo(r.dataset.reply); return; }
    const a = e.target.closest('[data-sel]');
    if (!a || !nodeOf(a.dataset.sel)) return;
    e.preventDefault();
    select(a.dataset.sel);
  });

  // Keyboard: f fits, o pauses the orbit, Escape closes forms or clears the selection, Enter/Space on a focused card or label selects it.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.key === 'Escape') {
      if (!$('#run-menu').hidden) openRunMenu(false);
      else if (!$('#add-form').hidden) toggleAddForm(false);
      else if (!$('#inline-form').hidden) closeInline();
      else if (!typing) select(null);
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f') { e.preventDefault(); fit(true); }
    if (e.key === 'o' && state.view === 'orbs') { e.preventDefault(); state.orbit = !state.orbit; ss.set('taskmap:orbit', state.orbit); scene.quiet = 0; wake(); }
    const k = { 1: 'map', 2: 'graph', 3: 'orbs', 4: 'outline' }[e.key];
    if (k && state.scope !== 'done') { e.preventDefault(); setView(k); }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && (t.classList.contains('card') || t.classList.contains('label'))) { e.preventDefault(); clickNode(t.dataset.id || (t.closest('[data-id]') || {}).dataset.id); }
  });
  // Both chrome layers float, and both change height as the header wraps or the strip
  // appears. Measure them directly instead of only when the graph refits.
  const syncChromeTop = () => {
    const head = $('#header').getBoundingClientRect().height;
    const strip = $('#waiting').hidden ? 0 : $('#waiting').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--chrome-top', `${Math.round(head + strip)}px`);
    $('#waiting').style.top = `${Math.round(head)}px`;
    if (scene.w) frame();
    if (!state.userMoved) fit(false); else wake();
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncChromeTop);
    ro.observe($('#header'));
    ro.observe($('#waiting'));
  }
  window.addEventListener('resize', () => { syncChromeTop(); resizeCanvas(); if (!state.userMoved) fit(false); });
  syncChromeTop();
  setInterval(tickUpdated, 1000);
  setInterval(tickRuns, RUN_TICK_MS);
  document.addEventListener('visibilitychange', tickRuns);
}

// ---------- boot ----------
async function init() {
  bindEvents();
  resizeCanvas();
  setLive('connecting');
  try {
    const r = await api('GET', '/api/projects');
    state.projects = r.projects || [];
  } catch (e) {
    notice(e.message);
    setLive('off');
    return;
  }
  const want = wantedProject();
  const exists = state.projects.filter((p) => p.exists);
  const pick = exists.find((p) => p.id === want) || exists[0];
  renderProjects();
  if (!pick) {
    $('#main').classList.add('is-empty');
    $('#empty').innerHTML = want
      ? `Project <code>${esc(want)}</code> is not registered or its directory is missing.`
      : 'No projects yet. Run <code>taskmap init "&lt;name&gt;" --goal "&lt;one sentence&gt;"</code> in a project.';
    setLive('off');
    return;
  }
  if (want && want !== pick.id) notice(`Project "${want}" is not available; showing ${pick.name}.`);
  switchProject(pick.id);
}

// For headless renders and debugging (tests/shots.js).
window.taskmapUI = { state, scene, cm, select, clickNode, setScope, setView, fit };
init();
