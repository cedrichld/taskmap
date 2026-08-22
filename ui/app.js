'use strict';
/* taskmap dashboard — vanilla JS + vendored D3 v7. Contract: docs/SPEC.md sections 2, 6, 7. Design: docs/design/DESIGN.md. */

// ---------- helpers ----------
const $ = (sel, el) => (el || document).querySelector(sel);
const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];
const LABEL = { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked', skipped: 'skipped' };
const ACTOR = { cli: 'Claude', ui: 'You' };
const VERB = { init: 'created', add: 'added', start: 'started', done: 'finished', block: 'blocked', skip: 'skipped', reopen: 'reopened', edit: 'edited', note: 'noted on', feedback: 'commented on', status: 'set', read: 'read' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR = REDUCED ? 0 : 320;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  selected: null, hover: null, collapsed: new Set(), view: 'graph',
  es: null, retryMs: 1000, retryTimer: null, everConnected: false,
  userMoved: false, layoutSig: null, drafts: {}, inlineMode: null,
};
const projPath = () => `/api/projects/${encodeURIComponent(state.pid)}`;
const rootId = () => (state.map ? state.map.root : 'n0');
const nodeOf = (id) => (state.map ? state.map.nodes[id] : undefined);

// ---------- derived values (SPEC section 2, "Derived values") ----------
function idNum(id) { return parseInt(String(id).slice(1), 10) || 0; }
function buildIndex() {
  const kids = new Map();
  for (const n of Object.values(state.map.nodes)) {
    if (!kids.has(n.id)) kids.set(n.id, []);
    if (n.parent != null) {
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n);
    }
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.order - b.order || idNum(a.id) - idNum(b.id));
  state.kids = kids;
}
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

// ---------- bubbles (shared by graph and outline) ----------
const SIZE = { root: { w: 200, h: 58 }, parent: { w: 176, h: 50 }, leaf: { w: 156, h: 48 } };
const BLOCK_EXTRA = 30; // two lines of reason under the title
function kindOf(id) { return id === rootId() ? 'root' : hasKids(id) ? 'parent' : 'leaf'; }
function sizeOf(n) {
  const k = kindOf(n.id);
  const s = SIZE[k];
  return { w: s.w, h: s.h + (n.status === 'blocked' ? BLOCK_EXTRA : 0), kind: k };
}
// The card and the strip show the question itself; the panel keeps the full reason.
const question = (reason) => String(reason || '').replace(/^waiting on (you|the user|user)[:,]?\s*/i, '');
function cardHtml(n, opts) {
  const kind = kindOf(n.id);
  let badge = '';
  if (kind !== 'leaf') {
    const p = progressOf(n.id);
    badge = opts.collapsed
      ? `<span class="badge fold" title="${p.done} of ${p.total} leaves done. Click to unfold.">${p.done}/${p.total}<i>▸</i></span>`
      : `<span class="badge" title="${p.done} of ${p.total} leaves done. Click to fold.">${p.done}/${p.total}</span>`;
  }
  const reason = n.status === 'blocked' ? `<div class="reason">${esc(question(n.status_reason))}</div>` : '';
  const status = opts.status ? `<span class="status">${LABEL[n.status] || esc(n.status)}</span>` : '';
  const unread = unreadOf(n) ? `<i class="unread" title="${unreadOf(n)} unread feedback"></i>` : '';
  return `<div class="body"><div class="title">${esc(n.title)}</div>${reason}</div>${badge}${status}${unread}`;
}
function cardTitle(n) {
  const bits = [n.title];
  if (n.status === 'blocked') bits.push(`Blocked: ${n.status_reason || ''}`);
  if (n.source === 'user') bits.push('Added from the dashboard');
  return bits.join('\n');
}
// Keeps the element (and its halo animation) and only rewrites the inner HTML when something changed.
function syncCard(el, n, opts) {
  el.className = `card k-${kindOf(n.id)} st-${n.status}${opts.collapsed ? ' collapsed' : ''}${n.source === 'user' ? ' user' : ''}${n.id === state.selected ? ' selected' : ''}`;
  el.dataset.id = n.id;
  el.title = cardTitle(n);
  const html = cardHtml(n, opts);
  if (el._sig !== html) { el.innerHTML = html; el._sig = html; }
}

// ---------- graph: compact layout ----------
// Children that have visible children sit side by side; the others stack in one column on the left, under a spine.
const COL_GAP = 14;
const ROW_GAP = 42;
const STACK_GAP = 10;
const STACK_INDENT = 14;
const svg = d3.select('#graph');
const gView = d3.select('#viewport');
const gEdges = d3.select('#edges');
const gX = d3.select('#xlinks');
const gNodes = d3.select('#nodes');
const zoom = d3.zoom().scaleExtent([0.08, 3]).on('zoom', (e) => {
  gView.attr('transform', e.transform);
  if (e.sourceEvent) state.userMoved = true;
});
svg.call(zoom).on('dblclick.zoom', null);
let layoutNodes = [];
let layoutLinks = [];

function layout() {
  const build = (id, depth, parent) => {
    const n = nodeOf(id);
    const s = sizeOf(n);
    const item = { id, n, w: s.w, h: s.h, kind: s.kind, depth, parent, children: [], stacked: false, x: 0, y: 0 };
    if (!isCollapsed(id)) for (const k of kidsOf(id)) item.children.push(build(k.id, depth + 1, item));
    return item;
  };
  const root = build(rootId(), 0, null);
  const all = [];
  const measure = (it) => {
    all.push(it);
    it.stack = it.children.filter((c) => c.children.length === 0);
    it.branches = it.children.filter((c) => c.children.length > 0);
    for (const c of it.stack) { c.stacked = true; all.push(c); }
    for (const c of it.branches) measure(c);
    it.stackW = it.stack.length ? Math.max(...it.stack.map((c) => c.w)) + STACK_INDENT : 0;
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
    if (it.stack.length) {
      let y = rowY[it.depth + 1];
      for (const c of it.stack) {
        c.x = cursor + STACK_INDENT + c.w / 2;
        c.y = y;
        y += c.h + STACK_GAP;
      }
      it.spineX = cursor + 1;
      cursor += it.stackW + COL_GAP;
    }
    for (const c of it.branches) { place(c, cursor); cursor += c.width + COL_GAP; }
  };
  place(root, 0);
  layoutNodes = all;
  const links = [];
  for (const it of all) {
    for (const c of it.branches || []) links.push({ key: c.id, kind: 'branch', s: it, t: c });
    if (it.stack && it.stack.length) {
      links.push({ key: `${it.id}:spine`, kind: 'spine', s: it, items: it.stack, x: it.spineX });
      for (const c of it.stack) links.push({ key: c.id, kind: 'elbow', s: it, t: c, x: it.spineX });
    }
  }
  layoutLinks = links;
}
// Tapered ribbon from the parent's bottom to the child's top: 6 px at the parent, 2 px at the child.
function ribbonPath(l) {
  const x0 = l.s.x; const y0 = l.s.y + l.s.h; const x1 = l.t.x; const y1 = l.t.y;
  const m = (y0 + y1) / 2;
  const a = 3; const b = 1;
  return `M${x0 - a},${y0} C${x0 - a},${m} ${x1 - b},${m} ${x1 - b},${y1} L${x1 + b},${y1} C${x1 + b},${m} ${x0 + a},${m} ${x0 + a},${y0} Z`;
}
function spinePath(l) {
  // Leaves the parent near its left corner when the stack column sits far to the left.
  const x0 = Math.max(l.x, l.s.x - l.s.w / 2 + 22); const y0 = l.s.y + l.s.h - 2;
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
// Cross-links ("depends on"); a hidden endpoint is represented by its nearest visible (collapsed) ancestor.
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
function renderGraph() {
  const first = !layoutNodes.length;
  layout();
  const sig = layoutNodes.map((d) => `${d.id}:${d.h}`).join(',');
  const structural = sig !== state.layoutSig;
  state.layoutSig = sig;
  const dur = first ? 0 : DUR;

  gEdges.selectAll('path').data(layoutLinks, (l) => l.key)
    .join(
      (enter) => enter.append('path').attr('d', linkPath).style('opacity', first ? 1 : 0),
      (update) => update,
      (exit) => exit.transition('out').duration(dur).style('opacity', 0).remove(),
    )
    .attr('class', (l) => `link ${l.kind}`)
    .transition('pos').duration(dur).attr('d', linkPath).style('opacity', 1);

  gX.selectAll('path').data(xlinkData(layoutNodes), (d) => d.key)
    .join('path')
    .attr('data-from', (d) => d.from).attr('data-to', (d) => d.to)
    .transition('pos').duration(dur).attr('d', (d) => xlinkPath(d.s, d.t));

  const g = gNodes.selectAll('g.node').data(layoutNodes, (d) => d.id)
    .join(
      (enter) => {
        // New bubbles grow out of their parent's position.
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
  g.each(function (d) { syncCard(this.firstChild.firstChild, d.n, { collapsed: isCollapsed(d.id) }); });

  applyXlinks();
  if ((first || structural) && !state.userMoved) fit(!first);
}
function applyXlinks() {
  const ids = new Set([state.hover, state.selected].filter(Boolean));
  gX.selectAll('path').classed('show', (d) => ids.has(d.from) || ids.has(d.to));
}
const FIT_PAD = 24;
function bounds() {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const d of layoutNodes) {
    x0 = Math.min(x0, d.x - d.w / 2); x1 = Math.max(x1, d.x + d.w / 2);
    y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y + d.h);
  }
  return { x0, x1, y0, y1 };
}
// Fit and center the whole visible tree in the window (load, structural change, Fit button, f key). Scale is capped at 1.25.
function fit(animate) {
  const r = $('#graph').getBoundingClientRect();
  if (!layoutNodes.length || r.width < 20 || r.height < 20 || state.view !== 'graph') { state.layoutSig = null; return; }
  const b = bounds();
  const cap = r.width >= 1900 ? 1.45 : 1.25;
  const k = Math.max(0.08, Math.min(cap, (r.width - 2 * FIT_PAD) / (b.x1 - b.x0), (r.height - 2 * FIT_PAD) / (b.y1 - b.y0)));
  const t = d3.zoomIdentity.translate((r.width - (b.x0 + b.x1) * k) / 2, (r.height - (b.y0 + b.y1) * k) / 2).scale(k);
  (animate && DUR ? svg.transition().duration(DUR) : svg).call(zoom.transform, t);
  state.userMoved = false;
}

// ---------- outline ----------
function renderOutline() {
  const rows = [];
  const walk = (id, depth) => {
    const n = nodeOf(id);
    rows.push({ id, n, depth, kids: hasKids(id), collapsed: isCollapsed(id) });
    if (!isCollapsed(id)) for (const k of kidsOf(id)) walk(k.id, depth + 1);
  };
  walk(rootId(), 0);
  const row = d3.select('#outline').selectAll('div.row').data(rows, (d) => d.id)
    .join((enter) => {
      const r = enter.append('div').attr('class', 'row');
      r.append('button').attr('type', 'button').attr('class', 'chev').attr('aria-label', 'collapse or expand');
      r.append('div').attr('class', 'card').attr('tabindex', '0');
      return r;
    });
  row.attr('data-id', (d) => d.id).style('padding-left', (d) => `${d.depth * 24}px`);
  row.select('button.chev').text((d) => (d.collapsed ? '▸' : '▾')).attr('disabled', (d) => (d.kids ? null : true))
    .attr('aria-expanded', (d) => (d.kids ? String(!d.collapsed) : null));
  row.select('div.card').each(function (d) { syncCard(this, d.n, { collapsed: d.collapsed, status: true }); });
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
  $('#project-name').textContent = m.name || state.pid;
  $('#project-goal').textContent = m.goal || '';
  $('#project-goal').title = m.goal || '';
  document.title = `${m.name || state.pid} · taskmap`;
  const p = progressOf(rootId());
  $('#progress-bar').style.transform = `scaleX(${p.total ? p.done / p.total : 0})`;
  $('#progress-label').textContent = `${p.done}/${p.total}`;
  const c = statusCounts();
  const unread = unreadCount();
  $('#counts').innerHTML = STATUSES.map((s) => `<span class="cnt st-${s}${c[s] ? '' : ' zero'}"><i></i>${c[s]} ${LABEL[s]}</span>`).join('')
    + (unread ? `<span class="cnt unread" title="messages Claude has not read yet"><i></i>${unread} for Claude</span>` : '');
  const now = nowNode();
  const nowEl = $('#now');
  nowEl.hidden = !now;
  if (now) {
    nowEl.dataset.sel = now.id;
    nowEl.innerHTML = `<span class="k">Now</span><span class="t">${esc(now.title)}</span>${now.started_at ? `<span class="ago">for <span class="mono">${esc(ago(now.started_at))}</span></span>` : ''}`;
  }
  renderWaiting();
  tickUpdated();
}
function renderWaiting() {
  const blocked = blockedNodes();
  const strip = $('#waiting');
  strip.hidden = !blocked.length;
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
    ${n.status_reason ? `<div class="p-reason st-${esc(n.status)}"><span class="k">${n.status === 'blocked' ? 'Waiting on you' : 'Skipped because'}</span>${esc(n.status_reason)}</div>` : ''}
    ${kv('What', n.what)}${kv('Why', n.why)}${kv('Done when', n.done_when)}
    <div class="p-sec"><div class="k">Notes${notes ? ` · ${n.notes.length}` : ''}</div>${notes ? `<ul class="timeline">${notes}</ul>` : '<div class="empty">No notes yet.</div>'}</div>
    <div class="p-sec"><div class="k">Feedback${fb ? ` · ${n.feedback.length}` : ''}</div>${fb ? `<ul class="timeline">${fb}</ul>` : '<div class="empty">No feedback yet.</div>'}</div>
    <div class="p-foot">${foot.join('<span class="sep">·</span>')}</div>`;
}
function renderPanel() {
  const n = state.selected ? nodeOf(state.selected) : null;
  const content = $('#panel-content');
  const actions = $('#panel-actions');
  if (!n) {
    content.innerHTML = '<div class="placeholder"><strong>Pick a bubble</strong> to read what it is, why it exists and how Claude will know it is done.<br><span class="muted">Click a count pill to fold a branch. <span class="mono">f</span> fits the map.</span></div>';
    content._sig = null;
    actions.hidden = true;
    return;
  }
  const html = panelHtml(n);
  if (content._sig !== html) { content.innerHTML = html; content._sig = html; }
  actions.hidden = false;
  const depth = depthOf(n.id);
  const sub = $('[data-act="subtask"]');
  sub.disabled = depth >= 3;
  sub.title = depth >= 3 ? 'Steps cannot have subtasks (the map is three levels deep at most).' : 'Add a child node under this one';
  const prog = hasKids(n.id) ? progressOf(n.id) : null;
  const open = prog && prog.done < prog.total;
  const done = $('[data-act="done"]');
  done.disabled = n.status === 'done' || open;
  done.title = open ? `${prog.total - prog.done} leaves underneath are not done yet` : 'Mark this node done';
  $('[data-act="reopen"]').disabled = n.status === 'pending';
  $('[data-act="block"]').disabled = n.status === 'blocked';
  $('[data-act="skip"]').disabled = n.status === 'skipped';
  $('#fb-text').placeholder = n.status === 'blocked' ? 'Answer the question above…' : 'Tell Claude something about this task…';
  syncSend();
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
      <span class="what"><span class="verb">${esc(verb)}</span> <span class="ntitle" title="${esc(title)}">${esc(title)}</span></span>
      <span class="detail">${esc(activityDetail(e))}</span>
    </div>`;
  }).join('') || '<div class="placeholder">No activity yet.</div>';
}

// ---------- rendering ----------
function applyView() {
  $('#main').classList.toggle('view-graph', state.view === 'graph');
  $('#main').classList.toggle('view-outline', state.view === 'outline');
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  $('#fit-btn').disabled = state.view !== 'graph';
}
function renderMain() {
  const empty = !hasKids(rootId());
  $('#main').classList.toggle('is-empty', empty);
  if (empty) return;
  if (state.view === 'graph') renderGraph();
  else renderOutline();
}
function applySelection() {
  for (const el of document.querySelectorAll('.card')) el.classList.toggle('selected', el.dataset.id === state.selected);
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

// ---------- selection and collapse ----------
function select(id) {
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
  applyXlinks();
}
function toggleCollapse(id) {
  if (!hasKids(id)) return;
  if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
  ss.set(`taskmap:collapsed:${state.pid}`, [...state.collapsed]);
  renderMain();
}
function setView(v) {
  if (v !== 'graph' && v !== 'outline') return;
  state.view = v;
  ss.set(`taskmap:view:${state.pid}`, v);
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
async function setStatus(nid, status, reason) {
  const btns = document.querySelectorAll('[data-act]');
  for (const b of btns) b.disabled = true;
  try {
    await api('POST', `${projPath()}/nodes/${encodeURIComponent(nid)}/status`, reason ? { status, reason } : { status });
    panelError('');
    closeInline();
    await loadProject();
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
    if (msg && msg.type === 'map') setMap(msg.map, msg.log);
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
  state.layoutSig = null;
  state.drafts = {};
  state.selected = ss.get(`taskmap:selected:${id}`, null);
  const storedCollapsed = ss.get(`taskmap:collapsed:${id}`, null);
  state.autoCollapse = storedCollapsed === null;
  state.collapsed = new Set(storedCollapsed || []);
  state.view = ss.get(`taskmap:view:${id}`, 'graph');
  $('#fb-text').value = '';
  closeInline();
  panelError('');
  toggleAddForm(false);
  gNodes.selectAll('*').remove();
  gEdges.selectAll('*').remove();
  gX.selectAll('*').remove();
  $('#outline').innerHTML = '';
  $('#panel-content')._sig = null;
  layoutNodes = [];
  layoutLinks = [];
  renderProjects();
  applyView();
  renderPanel();
  history.replaceState(null, '', `/?p=${encodeURIComponent(id)}`);
  loadProject().then(connect);
}

// ---------- events ----------
function bindEvents() {
  $('#project-select').addEventListener('change', (e) => { if (e.target.value && e.target.value !== state.pid) switchProject(e.target.value); });
  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#fit-btn').addEventListener('click', () => fit(true));
  $('#add-top-btn').addEventListener('click', () => toggleAddForm($('#add-form').hidden));
  $('#add-cancel').addEventListener('click', () => toggleAddForm(false));
  $('#add-form').addEventListener('submit', submitAddTop);
  $('#activity-toggle').addEventListener('click', () => {
    const collapsed = $('#side').classList.toggle('act-collapsed');
    $('#activity-toggle').setAttribute('aria-expanded', String(!collapsed));
    ss.set('taskmap:activity-collapsed', collapsed);
  });
  if (ss.get('taskmap:activity-collapsed', false)) { $('#side').classList.add('act-collapsed'); $('#activity-toggle').setAttribute('aria-expanded', 'false'); }

  // Graph: click selects, the count pill or a double-click folds, hover reveals cross-links, drag pans (d3.zoom).
  const svgEl = $('#graph');
  svgEl.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    if (e.target.closest('.badge')) { toggleCollapse(c.dataset.id); return; }
    select(c.dataset.id);
  });
  svgEl.addEventListener('dblclick', (e) => { const c = e.target.closest('.card'); if (c && !e.target.closest('.badge')) toggleCollapse(c.dataset.id); });
  svgEl.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.card');
    const id = c ? c.dataset.id : null;
    if (id !== state.hover) { state.hover = id; applyXlinks(); }
  });
  svgEl.addEventListener('mouseleave', () => { if (state.hover) { state.hover = null; applyXlinks(); } });

  // Outline: chevron, count pill or double-click folds, click selects.
  const outline = $('#outline');
  outline.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.chev') || e.target.closest('.badge')) toggleCollapse(row.dataset.id);
    else if (e.target.closest('.card')) select(row.dataset.id);
  });
  outline.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row && e.target.closest('.card') && !e.target.closest('.badge')) toggleCollapse(row.dataset.id);
  });

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
  $('#inline-form').addEventListener('submit', submitInline);
  $('#inline-cancel').addEventListener('click', closeInline);
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reply]');
    if (r && nodeOf(r.dataset.reply)) { replyTo(r.dataset.reply); return; }
    const a = e.target.closest('[data-sel]');
    if (!a || !nodeOf(a.dataset.sel)) return;
    e.preventDefault();
    select(a.dataset.sel);
  });

  // Keyboard: f fits, Escape closes forms or clears the selection, Enter/Space on a focused card selects it.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.key === 'Escape') {
      if (!$('#add-form').hidden) toggleAddForm(false);
      else if (!$('#inline-form').hidden) closeInline();
      else if (!typing) select(null);
      return;
    }
    if (typing) return;
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fit(true); }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('card')) { e.preventDefault(); select(t.dataset.id); }
  });
  window.addEventListener('resize', () => { if (!state.userMoved) fit(false); });
  setInterval(tickUpdated, 1000);
}

// ---------- boot ----------
async function init() {
  bindEvents();
  setLive('connecting');
  try {
    const r = await api('GET', '/api/projects');
    state.projects = r.projects || [];
  } catch (e) {
    notice(e.message);
    setLive('off');
    return;
  }
  const want = new URLSearchParams(location.search).get('p');
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

init();
