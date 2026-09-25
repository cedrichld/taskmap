'use strict';
/* taskmap prompts — how far a prompt has got and when it should be done, at any moment.
   One formula for everyone: src/runs.js requires it on the server, ui/app.js and
   ui/overview.js load it in the browser to move the numbers between updates. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Prompts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PARTIAL_MAX = 0.8; // credit given to the step under way, at most
  const pad2 = (n) => String(n).padStart(2, '0');

  const PRIOR_WEIGHT = 2; // how many observed steps the project's usual pace is worth

  // Time per step at `now`. This prompt's own pace (time to its last finished step /
  // steps finished) is blended with the project's usual pace (prior_ms). When nothing
  // has finished for a while, the time since the start stretches the pace, so a stall
  // pushes the ETA out instead of leaving it stuck at <1min.
  function paceAt(r, now) {
    const t0 = Date.parse(r.started);
    const prior = r.prior_ms || null;
    let own = null;
    if (r.done && r.run_pace_ms) own = r.state === 'running' ? Math.max(r.run_pace_ms, (now - t0) / (r.done + 1)) : r.run_pace_ms;
    else if (r.state === 'running' && prior && now - t0 > prior) own = now - t0; // the first step runs long
    const n = r.done || 1;
    if (own && prior) return (n * own + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
    return own || prior;
  }

  // r is a run summary from src/runs.js; now is a server-clock timestamp in ms.
  function extrapolate(r, now) {
    if (r.state !== 'running' || !r.total) return { pct: r.total ? r.done / r.total : null, eta_ms: null, pace_ms: null };
    const left = r.total - r.done - r.waiting;
    const pace = paceAt(r, now);
    if (!pace) return { pct: r.done / r.total, eta_ms: null, pace_ms: null };
    const f = left > 0 ? Math.min(PARTIAL_MAX, Math.max(0, (now - Date.parse(r.base)) / pace)) : 0;
    return { pct: Math.min(1, (r.done + f) / r.total), eta_ms: left > 0 ? Math.round((left - f) * pace) : 0, pace_ms: Math.round(pace) };
  }

  // 1h23, 14min, <1min
  function fmtDur(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '<1min';
    if (m < 60) return `${m}min`;
    return `${Math.floor(m / 60)}h${pad2(m % 60)}`;
  }

  const pctText = (p) => (p === null || p === undefined ? '' : `${Math.floor(p * 100)}%`);

  // What a prompt's line says: { cls, big (% or a word), eta (the pill), small (small print), pct }.
  function words(r, now) {
    const x = extrapolate(r, now);
    const took = fmtDur(r.state === 'running' ? Math.max(0, now - Date.parse(r.started)) : r.elapsed_ms);
    const pct = pctText(x.pct);
    const w = (cls, big, eta, small) => ({ cls, big, eta, small, pct: x.pct });
    if (r.state === 'running') {
      if (!r.total) return w('running', 'Working', '', `${took} in · no steps on the map yet`);
      if (x.eta_ms === null) return w('running', pct, 'ETA after 1st step', `${took} in`);
      if (r.waiting && x.eta_ms === 0) return w('waiting', pct, 'Waiting on you', `${took} in`);
      return w('running', pct, `ETA ${fmtDur(x.eta_ms)}`, `${took} in`);
    }
    if (r.state === 'done') return w('done', 'Done', '', `in ${took}`);
    if (r.state === 'paused') return w(r.waiting ? 'waiting' : 'paused', pct, '', r.waiting ? `waiting on you · ran ${took}` : `paused · ran ${took}`);
    return w('stopped', pct || '—', '', `session ended · ran ${took}`);
  }

  return { PARTIAL_MAX, paceAt, extrapolate, fmtDur, pctText, words };
});
