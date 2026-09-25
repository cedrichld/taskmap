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

  const PRIOR_WEIGHT = 2; // how many observed steps the prior is worth

  // Time per step at `now`. This prompt's own pace (time to its last finished step /
  // steps finished, counted from Claude's estimate when it gave one) is blended with the
  // prior: Claude's estimate spread over its steps, else the project's usual pace. When
  // nothing has finished for a while, the time elapsed stretches the pace, so a stall
  // pushes the ETA out instead of leaving it stuck at <1min. With no estimate from Claude
  // and nothing finished yet there is no pace: the history alone is too rough a guess.
  function paceAt(r, now) {
    const t0 = Date.parse(r.pace_from || r.started);
    const done = r.pace_done !== undefined ? r.pace_done : r.done;
    const prior = r.prior_ms || null;
    let own = null;
    if (done && r.run_pace_ms) own = r.state === 'running' ? Math.max(r.run_pace_ms, (now - t0) / (done + 1)) : r.run_pace_ms;
    else if (!r.estimate_ms) return null;
    else if (r.state === 'running' && prior && now - t0 > prior) own = now - t0; // the first step runs long
    const n = done || 1;
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

  const agentsText = (n) => `${n} agent${n > 1 ? 's' : ''} working`;

  // Whose ETA it is. 'chat': still Claude's own estimate counting down, because the steps
  // keep to its schedule. 'adjusted': taskmap has moved Claude's estimate (steps finishing
  // faster or slower, or none finishing while its time runs out). 'taskmap': Claude gave
  // none, so taskmap worked it out from finished steps alone.
  function etaSource(r, now, eta) {
    if (!r.estimate_ms) return 'taskmap';
    const countdown = r.estimate_ms - (now - Date.parse(r.estimate_at));
    return countdown > 0 && Math.abs(eta - countdown) <= Math.max(60000, 0.03 * r.estimate_ms) ? 'chat' : 'adjusted';
  }
  const MARK = { chat: '', adjusted: '~', taskmap: '~~' };
  // Claude's last estimate and how old it is: "Claude said 2h56, 20min ago" on the bar,
  // "Claude's last estimate: ETA 2h56, 20min ago" in full. '' when it gave none.
  function lastEstimate(r, now, full) {
    if (!r.estimate_ms) return '';
    const age = now - Date.parse(r.estimate_at);
    const when = age < 60000 ? 'just now' : `${fmtDur(age)} ago`;
    return full ? `Claude's last estimate: ETA ${fmtDur(r.estimate_ms)}, ${when}` : `Claude said ${fmtDur(r.estimate_ms)}, ${when}`;
  }
  function etaTip(r, src, now) {
    if (src === 'taskmap') return '~~ No ETA from the chat yet: taskmap\'s guess from finished steps until it sends one';
    if (src === 'adjusted') return `~ taskmap moved Claude's estimate to fit how the steps are going, until the chat sends a new one\n${lastEstimate(r, now, true)}`;
    return `${lastEstimate(r, now, true)}, on schedule`;
  }
  const etaText = (r, ms, now) => `${MARK[etaSource(r, now, ms)]}${fmtDur(ms)}`;

  const pctText = (p) => (p === null || p === undefined ? '' : `${Math.floor(p * 100)}%`);

  // What a prompt's line says: { cls, big (% or a word), eta (the pill), small (small print), pct }.
  function words(r, now) {
    const x = extrapolate(r, now);
    const took = fmtDur(r.state === 'running' ? Math.max(0, now - Date.parse(r.started)) : r.elapsed_ms);
    const pct = pctText(x.pct);
    const w = (cls, big, eta, small) => ({ cls, big, eta, small, pct: x.pct });
    if (r.state === 'running') {
      // The lead may be idle while background agents work for this prompt: still running.
      const inn = [r.agents ? agentsText(r.agents) : '', lastEstimate(r, now), `${took} in`].filter(Boolean).join(' · ');
      if (!r.total) return w('running', 'Working', '', r.agents ? inn : `${took} in · no steps on the map yet`);
      if (x.eta_ms === null) return w('running', pct, 'ETA after 1st step', inn);
      if (r.waiting && x.eta_ms === 0) return w('waiting', pct, 'Waiting on you', inn);
      return Object.assign(w('running', pct, `ETA ${etaText(r, x.eta_ms, now)}`, inn), { tip: etaTip(r, etaSource(r, now, x.eta_ms), now) });
    }
    if (r.state === 'done') return w('done', 'Done', '', `in ${took}`);
    if (r.state === 'paused') return w(r.waiting ? 'waiting' : 'paused', pct, '', r.waiting ? `waiting on you · ran ${took}` : `paused · ran ${took}`);
    return w('stopped', pct || '—', '', `session ended · ran ${took}`);
  }

  return { PARTIAL_MAX, paceAt, extrapolate, fmtDur, etaSource, etaText, lastEstimate, pctText, agentsText, words };
});
