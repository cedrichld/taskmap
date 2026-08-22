'use strict';
/* taskmap dashboard — vanilla JS + vendored D3 v7. Contract: docs/SPEC.md sections 2, 6, 7. */

// ---------- helpers ----------
const $ = (sel, el) => (el || document).querySelector(sel);
const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];
const LABEL = { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked', skipped: 'skipped' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    throw new Error(`network error: ${e.message}`);
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- state ----------
const state = {
  projects: [], pid: null, map: null, log: [], kids: new Map(),
  selected: null, hover: null, collapsed: new Set(), view: 'graph',
  es: null, retryMs: 1000, retryTimer: null, everConnected: false,
  needsFit: true, drafts: {}, inlineMode: null,
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

// ---------- cards (shared by graph and outline) ----------
function cardHtml(n, opts) {
  const parts = [];
  if (opts.collapsed) {
    const p = progressOf(n.id);
    parts.push(`<span class="b-count" title="collapsed: done / total leaves underneath">(${p.done}/${p.total})</span>`);
  }
  if (n.source === 'user') parts.push('<span class="b-user" title="added from the dashboard">*</span>');
  if (unreadOf(n)) parts.push(`<span class="b-unread" title="${unreadOf(n)} unread feedback"></span>`);
  if (n.status === 'blocked') parts.push(`<span class="b-blocked" title="${esc(n.status_reason)}">blocked: ${esc(n.status_reason || '')}</span>`);
  if (opts.status) parts.push(`<span class="b-status">${LABEL[n.status] || esc(n.status)}</span>`);
  return `<div class="strip"></div><div class="body"><div class="title">${esc(n.title)}</div><div class="meta">${parts.join('')}</div></div>`;
}
// Keeps the element (and its pulse animation) and only rewrites the inner HTML when something changed.
function syncCard(el, n, opts) {
  el.className = `card st-${n.status}${opts.collapsed ? ' collapsed' : ''}${n.id === rootId() ? ' root' : ''}${n.id === state.selected ? ' selected' : ''}`;
  el.dataset.id = n.id;
  el.title = n.title;
  const html = cardHtml(n, opts);
  if (el._sig !== html) { el.innerHTML = html; el._sig = html; }
}

// ---------- graph ----------
const W = 176;
const H = 66;
const GX = 14;
const GY = 48;
const svg = d3.select('#graph');
const gView = d3.select('#viewport');
const gEdges = d3.select('#edges');
const gX = d3.select('#xlinks');
const gNodes = d3.select('#nodes');
const zoom = d3.zoom().scaleExtent([0.08, 3]).on('zoom', (e) => gView.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const linkGen = d3.linkVertical().x((d) => d[0]).y((d) => d[1]);
let layoutNodes = [];

function edgePath(l) {
  return linkGen({ source: [l.source.x, l.source.y + H], target: [l.target.x, l.target.y] });
}
function xlinkPath(s, t) {
  if (Math.abs(s.x - t.x) < W) {
    const down = s.y < t.y;
    const y0 = down ? s.y + H : s.y;
    const y1 = down ? t.y : t.y + H;
    return `M${s.x},${y0} C${s.x},${(y0 + y1) / 2} ${t.x},${(y0 + y1) / 2} ${t.x},${y1}`;
  }
  const dir = t.x > s.x ? 1 : -1;
  const x0 = s.x + (dir * W) / 2;
  const x1 = t.x - (dir * W) / 2;
  const sy = s.y + H / 2;
  const ty = t.y + H / 2;
  const mx = (x0 + x1) / 2;
  return `M${x0},${sy} C${mx},${sy} ${mx},${ty} ${x1},${ty}`;
}
// Cross-links ("depends on"); a hidden endpoint is represented by its nearest visible (collapsed) ancestor.
function xlinkData(hnodes) {
  const pos = new Map(hnodes.map((d) => [d.data.id, d]));
  const seen = new Set();
  const out = [];
  for (const d of hnodes) {
    for (const target of d.data.links || []) {
      let t = nodeOf(target);
      while (t && !pos.has(t.id)) t = nodeOf(t.parent);
      if (!t || t.id === d.data.id) continue;
      const key = `${d.data.id}|${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, from: d.data.id, to: t.id, s: d, t: pos.get(t.id) });
    }
  }
  return out;
}
function renderGraph() {
  const root = d3.hierarchy(nodeOf(rootId()), (n) => (isCollapsed(n.id) ? null : kidsOf(n.id)));
  d3.tree().nodeSize([W + GX, H + GY]).separation((a, b) => (a.parent === b.parent ? 1 : 1.2))(root);
  layoutNodes = root.descendants();

  gEdges.selectAll('path').data(root.links(), (l) => l.target.data.id)
    .join('path')
    .attr('d', edgePath);

  gX.selectAll('path').data(xlinkData(layoutNodes), (d) => d.key)
    .join('path')
    .attr('data-from', (d) => d.from).attr('data-to', (d) => d.to)
    .attr('d', (d) => xlinkPath(d.s, d.t));

  const fo = gNodes.selectAll('foreignObject').data(layoutNodes, (d) => d.data.id)
    .join((enter) => {
      const f = enter.append('foreignObject').attr('class', 'node').attr('width', W).attr('height', H)
        .attr('x', (d) => d.x - W / 2).attr('y', (d) => d.y);
      f.append('xhtml:div').attr('class', 'card').attr('tabindex', '0');
      return f;
    });
  fo.transition('pos').duration(160).attr('x', (d) => d.x - W / 2).attr('y', (d) => d.y);
  fo.each(function (d) { syncCard(this.firstChild, d.data, { collapsed: isCollapsed(d.data.id) }); });

  applyXlinks();
  if (state.needsFit) initialFit();
}
function applyXlinks() {
  const ids = new Set([state.hover, state.selected].filter(Boolean));
  gX.selectAll('path').classed('show', (d) => ids.has(d.from) || ids.has(d.to));
}
const FIT_PAD = 28;
const READABLE = 0.8; // below this scale card titles stop being legible
function bounds() {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const d of layoutNodes) {
    x0 = Math.min(x0, d.x - W / 2); x1 = Math.max(x1, d.x + W / 2);
    y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y + H);
  }
  return { x0, x1, y0, y1 };
}
function fitScale(r, b) {
  return Math.max(0.08, Math.min(1, (r.width - 2 * FIT_PAD) / (b.x1 - b.x0), (r.height - 2 * FIT_PAD) / (b.y1 - b.y0)));
}
// True fit: the whole visible tree in the window (Fit button, f key).
function fit(animate) {
  const r = $('#graph').getBoundingClientRect();
  if (!layoutNodes.length || r.width < 20 || r.height < 20 || state.view !== 'graph') { state.needsFit = true; return; }
  const b = bounds();
  const k = fitScale(r, b);
  const t = d3.zoomIdentity.translate((r.width - (b.x0 + b.x1) * k) / 2, (r.height - (b.y0 + b.y1) * k) / 2).scale(k);
  (animate ? svg.transition().duration(250) : svg).call(zoom.transform, t);
  state.needsFit = false;
}
// The node the user most likely wants to see first: the in-progress leaf, else any in-progress node, else the first pending leaf, else the root.
function focusNode() {
  const pick = (pred) => layoutNodes.find((d) => pred(d.data));
  return pick((n) => n.status === 'in_progress' && !hasKids(n.id))
    || pick((n) => n.status === 'in_progress' && n.id !== rootId())
    || pick((n) => n.status === 'pending' && !hasKids(n.id))
    || layoutNodes[0];
}
// First view of a project: fit when that is readable, otherwise open at a readable scale around the active node.
function initialFit() {
  const r = $('#graph').getBoundingClientRect();
  if (!layoutNodes.length || r.width < 20 || r.height < 20 || state.view !== 'graph') { state.needsFit = true; return; }
  const b = bounds();
  if (fitScale(r, b) >= READABLE) { fit(false); return; }
  const k = 0.85;
  const f = focusNode();
  const tx = r.width / 2 - f.x * k;
  const wholeHeightFits = (b.y1 - b.y0) * k <= r.height - 2 * FIT_PAD;
  const ty = wholeHeightFits ? FIT_PAD - b.y0 * k : r.height / 2 - (f.y + H / 2) * k;
  svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  state.needsFit = false;
}
// A subtree is closed when its node and every descendant is done or skipped (same rule as `taskmap tree --open`).
function isClosed(id) {
  const n = nodeOf(id);
  if (!n || (n.status !== 'done' && n.status !== 'skipped')) return false;
  const walk = (pid) => kidsOf(pid).every((k) => (k.status === 'done' || k.status === 'skipped') && walk(k.id));
  return walk(id);
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
      const r = enter.append('div').attr('class', 'row').attr('role', 'treeitem');
      r.append('button').attr('type', 'button').attr('class', 'chev').attr('aria-label', 'collapse or expand');
      r.append('div').attr('class', 'card').attr('tabindex', '0');
      return r;
    });
  row.attr('data-id', (d) => d.id).style('padding-left', (d) => `${d.depth * 22}px`)
    .attr('aria-expanded', (d) => (d.kids ? String(!d.collapsed) : null));
  row.select('button.chev').text((d) => (d.collapsed ? '▸' : '▾')).attr('disabled', (d) => (d.kids ? null : true));
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
  $('#progress-bar').style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
  $('#progress-label').textContent = `${p.done}/${p.total}`;
  const c = statusCounts();
  const unread = unreadCount();
  $('#counts').innerHTML = STATUSES.map((s) => `<span class="cnt st-${s}${c[s] ? '' : ' zero'}"><i></i>${c[s]} ${LABEL[s]}</span>`).join('')
    + (unread ? `<span class="cnt unread" title="feedback Claude has not read yet"><i></i>${unread} unread</span>` : '');
  tickUpdated();
}
function tickUpdated() {
  $('#updated').textContent = state.map && state.map.updated ? `updated ${ago(state.map.updated)} ago` : '';
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
function panelHtml(n) {
  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v${v ? '' : ' empty'}">${v ? esc(v) : '—'}</div></div>`;
  const tsRow = (ts, extra) => `<div class="ts-row"><span class="mono ts" title="${esc(ts)}">${esc(fmtTime(ts))}</span>${extra || ''}</div>`;
  const notes = (n.notes || []).map((x) => `<li>${tsRow(x.ts)}<span class="t">${esc(x.text)}</span></li>`).join('');
  const fb = (n.feedback || []).map((f) => {
    const sys = (f.kind || 'feedback') !== 'feedback';
    const tag = f.read ? '' : '<span class="unread-tag"><i></i>unread</span>';
    return `<li class="${sys ? 'sys' : 'fb'}${f.read ? '' : ' unread'}">${tsRow(f.ts, tag)}<span class="t">${esc(f.text)}</span></li>`;
  }).join('');
  const link = (id) => { const t = nodeOf(id); return `<a href="#" data-sel="${esc(id)}" title="${esc(t ? t.title : '')}">${esc(id)}</a>`; };
  const prog = hasKids(n.id) ? progressOf(n.id) : null;
  const foot = [];
  if (n.parent) foot.push(`parent ${link(n.parent)}`);
  if ((n.links || []).length) foot.push(`depends on ${n.links.map(link).join(', ')}`);
  foot.push(`source ${esc(n.source || 'claude')}`);
  if (n.created) foot.push(`created ${esc(fmtTime(n.created))}`);
  if (n.started_at) foot.push(`started ${esc(fmtTime(n.started_at))}`);
  if (n.finished_at) foot.push(`finished ${esc(fmtTime(n.finished_at))}`);
  return `
    <div class="p-head">
      <span class="mono id">${esc(n.id)}</span>
      <span class="pill st-${esc(n.status)}"><i></i>${LABEL[n.status] || esc(n.status)}</span>
      ${prog ? `<span class="mono">${prog.done}/${prog.total} leaves</span>` : ''}
      ${n.source === 'user' ? '<span title="added from the dashboard">* user-added</span>' : ''}
    </div>
    <h2 class="p-title">${esc(n.title)}</h2>
    ${n.status_reason ? `<div class="p-reason st-${esc(n.status)}">${esc(n.status)}: ${esc(n.status_reason)}</div>` : ''}
    ${kv('what', n.what)}${kv('why', n.why)}${kv('done when', n.done_when)}
    <div class="p-sec"><div class="k">notes${notes ? ` · ${n.notes.length}` : ''}</div>${notes ? `<ul class="timeline">${notes}</ul>` : '<div class="empty">No notes yet.</div>'}</div>
    <div class="p-sec"><div class="k">feedback${fb ? ` · ${n.feedback.length}` : ''}</div>${fb ? `<ul class="timeline">${fb}</ul>` : '<div class="empty">No feedback yet.</div>'}</div>
    <div class="p-foot">${foot.join(' · ')}</div>`;
}
function renderPanel() {
  const n = state.selected ? nodeOf(state.selected) : null;
  const content = $('#panel-content');
  const actions = $('#panel-actions');
  if (!n) {
    content.innerHTML = '<div class="placeholder">Select a node to see its details.</div>';
    actions.hidden = true;
    return;
  }
  const html = panelHtml(n);
  if (content._sig !== html) { content.innerHTML = html; content._sig = html; }
  actions.hidden = false;
  const depth = depthOf(n.id);
  const sub = $('[data-act="subtask"]');
  sub.disabled = depth >= 3;
  sub.title = depth >= 3 ? 'steps cannot have subtasks (the limit is 3 levels below the root)' : 'add a child node under this one';
  $('[data-act="done"]').disabled = n.status === 'done';
  $('[data-act="reopen"]').disabled = n.status === 'pending';
  $('[data-act="block"]').disabled = n.status === 'blocked';
}
function panelError(msg) {
  const el = $('#panel-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}
function openInline(mode) {
  state.inlineMode = mode;
  const form = $('#inline-form');
  $('#inline-label').textContent = mode === 'subtask' ? 'Subtask title' : 'Why is it blocked?';
  $('#inline-ok').textContent = mode === 'subtask' ? 'Add' : 'Mark blocked';
  $('#inline-input').value = '';
  $('#inline-input').maxLength = mode === 'subtask' ? 200 : 1000;
  form.hidden = false;
  $('#inline-input').focus();
}
function closeInline() {
  state.inlineMode = null;
  $('#inline-form').hidden = true;
}

// ---------- activity feed ----------
function activityDetail(e) {
  const d = e.detail || {};
  switch (e.type) {
    case 'init': return d.goal || '';
    case 'add': return `under ${d.parent || '?'}${d.source === 'user' ? ', by user' : ''}`;
    case 'start': case 'done': case 'block': case 'skip': case 'reopen': case 'status':
      return `${d.from || '?'} → ${d.to || '?'}${d.reason ? `: ${d.reason}` : ''}${d.note ? ` — ${d.note}` : ''}`;
    case 'edit': return `fields: ${(d.fields || []).join(', ')}`;
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
    return `<div class="act" data-sel="${esc(e.node)}">
      <span class="mono ts" title="${esc(e.ts)}">${esc(fmtTime(e.ts))}</span>
      <span class="actor actor-${esc(e.actor)}">${esc(e.actor)}</span>
      <span class="type">${esc(e.type)}</span>
      <span class="ntitle" title="${esc(n ? n.title : e.node)}">${esc(n ? n.title : e.node)}</span>
      <span class="detail">${esc(activityDetail(e))}</span>
    </div>`;
  }).join('') || '<div class="placeholder" style="padding:8px 16px">No activity yet.</div>';
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

// ---------- actions (POST) ----------
async function sendFeedback() {
  const ta = $('#fb-text');
  const text = ta.value.trim();
  if (!text || !state.selected) return;
  const btn = $('#fb-send');
  btn.disabled = true;
  try {
    await api('POST', `${projPath()}/feedback`, { node: state.selected, text });
    ta.value = '';
    delete state.drafts[state.selected];
    panelError('');
    loadProject();
  } catch (e) {
    panelError(e.message);
  } finally {
    btn.disabled = false;
  }
}
async function setStatus(nid, status, reason) {
  try {
    await api('POST', `${projPath()}/nodes/${encodeURIComponent(nid)}/status`, reason ? { status, reason } : { status });
    panelError('');
    closeInline();
    loadProject();
  } catch (e) {
    panelError(e.message);
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
    notice(`Could not load project: ${e.message}`);
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
  state.needsFit = true;
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
  });

  // Graph: click selects, double-click collapses, hover reveals cross-links, drag pans (d3.zoom).
  const svgEl = $('#graph');
  svgEl.addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) select(c.dataset.id); });
  svgEl.addEventListener('dblclick', (e) => { const c = e.target.closest('.card'); if (c) toggleCollapse(c.dataset.id); });
  svgEl.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.card');
    const id = c ? c.dataset.id : null;
    if (id !== state.hover) { state.hover = id; applyXlinks(); }
  });
  svgEl.addEventListener('mouseleave', () => { if (state.hover) { state.hover = null; applyXlinks(); } });

  // Outline: chevron or double-click collapses, click selects.
  const outline = $('#outline');
  outline.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.chev')) toggleCollapse(row.dataset.id);
    else if (e.target.closest('.card')) select(row.dataset.id);
  });
  outline.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row && e.target.closest('.card')) toggleCollapse(row.dataset.id);
  });

  // Side panel and activity feed.
  $('#fb-send').addEventListener('click', sendFeedback);
  $('#fb-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFeedback(); } });
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => {
      if (!state.selected) return;
      const act = b.dataset.act;
      if (act === 'subtask') openInline('subtask');
      else if (act === 'block') openInline('block');
      else if (act === 'done') setStatus(state.selected, 'done');
      else if (act === 'reopen') setStatus(state.selected, 'pending');
    });
  }
  $('#inline-form').addEventListener('submit', submitInline);
  $('#inline-cancel').addEventListener('click', closeInline);
  document.addEventListener('click', (e) => {
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
  window.addEventListener('resize', () => { if (state.needsFit) initialFit(); });
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
    notice(`Could not reach the taskmap server: ${e.message}`);
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
