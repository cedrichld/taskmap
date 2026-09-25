'use strict';
/* taskmap overview — one card per registered project. Contract: docs/SPEC.md sections 6, 7. */

const $ = (sel, el) => (el || document).querySelector(sel);
const P = window.Prompts;
const POLL_MS = 2000;
const RECENT_MS = 2 * 3600 * 1000; // a finished prompt stays on its card this long

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (!iso || isNaN(s)) return '';
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toISOString().slice(0, 10);
}

const state = { projects: [], failures: 0, skew: 0 };

// The card's prompt: running, or finished within the last two hours ("is it done yet?").
function runHtml(p) {
  const r = p.run;
  if (!r || !p.exists) return '';
  const now = Date.now() + state.skew;
  if (r.state !== 'running' && now - Date.parse(r.ended || r.started) > RECENT_MS) return '';
  const w = P.words(r, now);
  const fill = r.state === 'done' ? 1 : w.pct || 0;
  const more = p.running > 1 ? `<span class="muted ov-run-more">+${p.running - 1} more running</span>` : '';
  const label = r.state === 'running' ? 'This prompt' : 'Last prompt';
  return `<div class="ov-run st-${w.cls}" title="${esc(r.prompt)}">
      <p class="ov-run-p"><span class="k">${label}</span> ${esc(r.prompt || '(no text)')}</p>
      <div class="ov-run-row">
        <span class="ov-bar"><i style="transform:scaleX(${fill.toFixed(4)})"></i></span>
        <span class="ov-run-big mono">${esc(w.big)}</span>
        ${w.eta ? `<span class="ov-run-eta">${esc(w.eta)}</span>${r.agents ? `<span class="muted ov-run-more">${esc(P.agentsText(r.agents))}</span>` : ''}` : `<span class="muted">${esc(w.small)}</span>`}${more}
      </div>
    </div>`;
}

function setLive(kind, text) {
  const el = $('#ov-live');
  el.className = `live ${kind}`;
  $('#ov-live-text').textContent = text;
}

function notice(msg) {
  const el = $('#ov-notice');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// Live sessions first, then whatever is waiting on you, then most recently changed.
const needs = (p) => (p.blocked || 0) + (p.unread || 0);
function sortProjects(list) {
  return list.slice().sort((a, b) => {
    if (Boolean(b.live) !== Boolean(a.live)) return b.live ? 1 : -1;
    if (needs(b) !== needs(a)) return needs(b) - needs(a);
    return String(b.updated || '').localeCompare(String(a.updated || ''));
  });
}

function cardHtml(p) {
  const pr = p.progress || { done: 0, total: 0 };
  const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
  const chips = [];
  if (p.blocked) chips.push(`<span class="chip warn">${p.blocked} blocked</span>`);
  if (p.unread) chips.push(`<span class="chip accent">${p.unread} unread</span>`);
  const now = (p.in_progress_titles || []).slice(0, 3);
  const more = (p.in_progress_titles || []).length - now.length;
  const check = '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
  let nowHtml;
  if (p.exists && now.length) {
    // In progress with nobody working on it is a stalled run, not a healthy one.
    const stalled = !p.live ? '<p class="ov-stalled">no session running</p>' : '';
    const f = p.focus;
    const focusHtml = f
      ? `<p class="ov-focus"><i class="rundot"></i>${f.path && f.path.length ? `<span class="ov-path">${f.path.map(esc).join(' › ')} ›</span> ` : ''}<strong>${esc(f.title)}</strong>${f.since ? ` <span class="muted">for ${esc(ago(f.since).replace(/ ago$/, ""))}</span>` : ''}${f.note ? `<br><em class="ov-note">${esc(f.note)}</em>` : ''}</p>`
      : '';
    const rest = f ? now.filter((t) => t !== f.title && !(f.path || []).includes(t)) : now;
    nowHtml = `${focusHtml}${rest.length ? `<ul class="ov-now">${rest.map((t) => `<li>${esc(t)}</li>`).join('')}${more > 0 ? `<li class="muted">and ${more} more</li>` : ''}</ul>` : ''}${stalled}`;
  } else if (!p.exists) {
    nowHtml = '<p class="ov-idle">Directory missing.</p>';
  } else if (pr.total && pr.done === pr.total) {
    nowHtml = `<p class="ov-idle done">${check}All done.</p>`;
  } else {
    nowHtml = '<p class="ov-idle">Nothing in progress.</p>';
  }

  return `<li class="ov-card${p.live ? ' is-live' : ''}${needs(p) ? ' needs-you' : ''}${p.exists ? '' : ' is-gone'}" data-id="${esc(p.id)}">
    <a class="ov-hit" href="/p/${encodeURIComponent(p.id)}">
      <div class="ov-top">
        <h2 class="ov-name">${esc(p.name)}</h2>
        ${p.live ? '<span class="ov-livedot" title="A Claude Code session is running here"><i></i>live</span>' : ''}
      </div>
      <p class="ov-goal" title="${esc(p.goal || '')}">${esc(p.goal || '')}</p>
      ${nowHtml}
      ${runHtml(p)}
      <span class="ov-spacer"></span>
      <div class="ov-bar" role="img" aria-label="${pr.done} of ${pr.total} leaves done"><i style="transform:scaleX(${pr.total ? pr.done / pr.total : 0})"></i></div>
      <div class="ov-foot">
        <span class="ov-count mono">${pr.done}/${pr.total}</span>
        <span class="muted">${pct}%</span>
        ${chips.join('')}
        <span class="spacer"></span>
        <span class="muted ov-when">${esc(ago(p.updated))}</span>
      </div>
    </a>
  </li>`;
}

function render() {
  const list = sortProjects(state.projects);
  const grid = $('#ov-grid');
  const html = list.map(cardHtml).join('');
  if (grid._sig !== html) {
    grid.innerHTML = html;
    grid._sig = html;
  }
  $('#ov-empty').hidden = list.length > 0;
  const live = list.filter((p) => p.live).length;
  // The soonest running prompt goes in the tab title.
  const now = Date.now() + state.skew;
  const etas = list.filter((p) => p.run && p.run.state === 'running').map((p) => ({ r: p.run, ms: P.extrapolate(p.run, now).eta_ms })).filter((e) => e.ms !== null);
  const next = etas.reduce((a, e) => (!a || e.ms < a.ms ? e : a), null);
  const soonest = next ? ` · next done ${P.etaText(next.r, next.ms)}` : '';
  document.title = live ? `(${live}) taskmap${soonest} — all projects` : 'taskmap — all projects';
}

async function poll() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    const data = await res.json();
    state.projects = data.projects || [];
    if (Number.isFinite(data.now)) state.skew = data.now - Date.now();
    state.failures = 0;
    notice('');
    const live = state.projects.filter((p) => p.live).length;
    setLive('on', live ? `${live} session${live > 1 ? 's' : ''} running` : 'no sessions running');
    render();
  } catch (e) {
    state.failures += 1;
    if (state.failures > 1) {
      setLive('off', 'disconnected');
      notice('Could not reach the taskmap server. Start it with: taskmap serve --ensure');
    }
  }
}

poll();
setInterval(poll, POLL_MS);
setInterval(render, 30000); // keep the "3m ago" labels honest while nothing changes
