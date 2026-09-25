'use strict';
// runs.js — one run per user prompt, so the dashboard can show how far the
// current prompt has got and when it should be done. Written by the prompt and
// stop hooks and by the CLI, read by the server. Prints nothing, so it costs no tokens.
//
// ~/.taskmap/prompts/<sid>.json  { sid, prompt, started, ended, dirs }  the session's latest prompt
// <project>/.taskmap/runs.json   { runs: [{ id, sid, prompt, started, ended, open, agents }] }  oldest first
//
// sid is a short hash of the Claude Code session id: the hooks get it on stdin, the
// CLI from CLAUDE_CODE_SESSION_ID. Nodes carry it as `sid` (added by) and `by` (last
// status change by), so two sessions on one map each see only their own prompt's work.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { extrapolate } = require('../ui/prompts');

const MAX_RUNS = 30;
const PROMPT_CHARS = 160;
const PROMPT_TTL_MS = 3 * 24 * 3600 * 1000; // prompt records of sessions gone this long are pruned
const JOIN_MS = 12 * 3600 * 1000; // a message this long after the turn's last one starts a new run anyway
const TAIL_BYTES = 256 * 1024; // how much of the transcript to scan for an interruption
const STALE_MS = 2 * 3600 * 1000; // an unended run with no heartbeat and no activity for this long has stopped
const GAP_MAX_MS = 45 * 60 * 1000; // a longer gap between two finished steps is a break, not a pace sample
const GAP_MIN_MS = 5000;
const DEFAULT_CHUNKS = 3; // an unplanned milestone is worth this many steps until the map says otherwise
const ESTIMATE_GRACE_MS = 5000; // a step closed this soon after an estimate (`taskmap eta 2h && taskmap done n5`) was part of it

function sidOf(sessionId) {
  return sessionId ? crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 10) : null;
}

function envSid() {
  return sidOf(process.env.CLAUDE_CODE_SESSION_ID);
}

function excerpt(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t.length > PROMPT_CHARS ? t.slice(0, PROMPT_CHARS - 1) + '…' : t;
}

// ---------- files ----------

function promptsDir() {
  return path.join(store.home(), 'prompts');
}

function promptFile(sid) {
  return path.join(promptsDir(), `${sid}.json`);
}

function readPrompt(sid) {
  if (!sid) return null;
  try {
    const r = store.readJson(promptFile(sid), null);
    return r && typeof r === 'object' ? { ...r, dirs: Array.isArray(r.dirs) ? r.dirs : [] } : null;
  } catch (e) {
    return null;
  }
}

function writePrompt(rec) {
  fs.mkdirSync(promptsDir(), { recursive: true });
  store.writeJsonAtomic(promptFile(rec.sid), rec);
}

function prunePrompts(nowMs) {
  let names = [];
  try {
    names = fs.readdirSync(promptsDir());
  } catch (e) {
    return;
  }
  for (const name of names) {
    const file = path.join(promptsDir(), name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > PROMPT_TTL_MS) fs.unlinkSync(file);
    } catch (e) {
      // another hook got there first
    }
  }
}

function runsFile(dir) {
  return path.join(store.dataDir(dir), 'runs.json');
}

function readRuns(dir) {
  try {
    const d = store.readJson(runsFile(dir), null);
    return d && Array.isArray(d.runs) ? d : { runs: [] };
  } catch (e) {
    return { runs: [] };
  }
}

function statRuns(dir) {
  try {
    const st = fs.statSync(runsFile(dir));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return null;
  }
}

// fn(doc) returns true when it changed something; only then is the file rewritten,
// so a stop with nothing to end does not wake every open dashboard.
function updateRuns(dir, fn) {
  return store.withLock(path.join(store.dataDir(dir), 'runs.lock'), () => {
    const doc = readRuns(dir);
    if (!fn(doc)) return false;
    // Drop the oldest finished runs; an unended one stays however old it is.
    while (doc.runs.length > MAX_RUNS) {
      const i = doc.runs.findIndex((r) => r.ended);
      if (i < 0) break;
      doc.runs.splice(i, 1);
    }
    store.writeJsonAtomic(runsFile(dir), doc);
    return true;
  });
}

// Leaves still open when the prompt arrived: the work a follow-up prompt may pick up.
function openLeaves(map) {
  const kids = index(map);
  return Object.values(map.nodes)
    .filter((n) => n.id !== map.root && !kids.has(n.id) && ['pending', 'in_progress', 'blocked'].includes(n.status) && !skippedAbove(map, n))
    .map((n) => n.id);
}

function startRun(dir, rec) {
  let map;
  try {
    map = store.readMap(dir);
  } catch (e) {
    return false;
  }
  const open = openLeaves(map);
  return updateRuns(dir, (doc) => {
    for (const r of doc.runs) if (r.sid === rec.sid && !r.ended) r.ended = rec.started;
    const last = doc.runs.reduce((m, r) => Math.max(m, parseInt(String(r.id).slice(1), 10) || 0), 0);
    doc.runs.push({ id: `r${last + 1}`, sid: rec.sid, prompt: rec.prompt, started: rec.started, ended: null, open });
    return true;
  });
}

function endRuns(dir, sid, ts) {
  if (!fs.existsSync(runsFile(dir))) return false;
  return updateRuns(dir, (doc) => {
    let changed = false;
    for (const r of doc.runs) {
      if (r.sid === sid && !r.ended) {
        r.ended = ts;
        changed = true;
      }
    }
    return changed;
  });
}

// ---------- hook and CLI entry points (never throw) ----------

// Did the user interrupt the turn (Esc) after `sinceMs`? Claude Code writes a
// "[Request interrupted by user]" entry into the transcript; Stop never fires then.
function interruptedSince(transcriptPath, sinceMs) {
  if (!transcriptPath) return false;
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('Request interrupted by user')) continue;
      try {
        const t = Date.parse(JSON.parse(line).timestamp);
        if (t > sinceMs) return true;
      } catch (e) {
        // the first line of the tail is usually cut in half
      }
    }
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return false;
}

// Background agents finishing, monitors firing, another session or a teammate writing
// in: Claude Code delivers these as prompts, but none of them is the user's.
function isNotification(prompt) {
  return /^\s*<(task-notification|system-reminder|bash-notification|cross-session-message|teammate-message|agent-message)\b/.test(String(prompt || ''));
}

// UserPromptSubmit. dir is the project the session's cwd resolves to, or null.
function onPrompt({ sessionId, prompt, dir, transcriptPath = null, ts = store.now() }) {
  const sid = sidOf(sessionId);
  const prev = readPrompt(sid);
  const tsMs = Date.parse(ts);
  const last = prev ? Date.parse(prev.last || prev.ended || prev.started) : NaN;
  // A notification is never a prompt of its own: it wakes the session to carry on
  // with the user's last prompt (merging what its agents did), so that run resumes.
  if (isNotification(prompt)) {
    if (!prev || !(tsMs - last < JOIN_MS)) return;
    for (const d of prev.dirs) safe(() => updateRuns(d, (doc) => {
      const r = doc.runs.filter((x) => x.sid === sid).pop();
      if (!r) return false;
      r.ended = null;
      delete r.agents; // the lead is back at work; the next Stop counts what is still out
      r.follow_ups = (r.follow_ups || 0) + 1;
      return true;
    }));
    safe(() => writePrompt({ ...prev, ended: null, last: ts }));
    return;
  }
  // A message typed while the turn is still running arrives here too. It belongs to the
  // prompt that started the turn, which keeps the bar: one turn, one run.
  if (prev && !prev.ended && tsMs - last < JOIN_MS && !interruptedSince(transcriptPath, last)) {
    const dirs = prev.dirs.slice();
    if (dir && !dirs.includes(dir)) {
      dirs.push(dir);
      safe(() => startRun(dir, prev));
    }
    for (const d of prev.dirs) safe(() => updateRuns(d, (doc) => {
      const r = doc.runs.find((x) => x.sid === sid && !x.ended);
      if (!r) return false;
      delete r.agents;
      r.follow_ups = (r.follow_ups || 0) + 1;
      return true;
    }));
    safe(() => writePrompt({ ...prev, last: ts, dirs }));
    return;
  }
  // A turn the user interrupted never reached Stop: its run ends where this one starts.
  if (prev && !prev.ended) for (const d of prev.dirs) safe(() => endRuns(d, sid, ts));
  const rec = { sid, prompt: excerpt(prompt), started: ts, ended: null, dirs: dir ? [dir] : [] };
  if (dir) safe(() => startRun(dir, rec));
  if (sid) {
    safe(() => writePrompt(rec));
    safe(() => prunePrompts(tsMs));
  }
}

// Stop, once the turn is really over. With background agents still out (agents > 0) the
// turn is over but the prompt is not: the run stays open, so its bar and ETA keep going,
// and records how many agents it waits on. Their notifications resume it (onPrompt), and
// a message typed meanwhile joins it, as it would mid-turn.
function onStop({ sessionId, dir, agents = 0, ts = store.now() }) {
  const sid = sidOf(sessionId);
  const rec = readPrompt(sid);
  const dirs = new Set(rec ? rec.dirs : []);
  if (dir) dirs.add(dir);
  if (agents > 0) {
    for (const d of dirs) safe(() => updateRuns(d, (doc) => {
      const r = doc.runs.filter((x) => x.sid === sid && !x.ended).pop();
      if (!r || r.agents === agents) return false;
      r.agents = agents;
      return true;
    }));
    if (rec) safe(() => writePrompt({ ...rec, ended: null, last: ts }));
    return;
  }
  for (const d of dirs) safe(() => endRuns(d, sid, ts));
  if (rec && !rec.ended) safe(() => writePrompt({ ...rec, ended: ts }));
}

// Claude's own estimate for the prompt (`taskmap eta 15m`): `ms` from `at`, for the work
// left then (`left`, in step weight). It sets the run's pace until real steps take over.
// The session's open run gets it; without a session id, the newest open run.
function setEstimate(dir, sid, estimateMs, ts = store.now()) {
  const map = store.readMap(dir);
  let set = null;
  updateRuns(dir, (doc) => {
    const open = doc.runs.filter((r) => !r.ended && (!sid || r.sid === sid));
    const r = open[open.length - 1];
    if (!r) return false;
    const s = summarize(map, doc, { now: Date.parse(ts), limit: doc.runs.length }).find((x) => x.id === r.id);
    const left = s ? Math.round((s.total - s.done - s.waiting) * 10) / 10 : 0;
    r.estimate = { ms: estimateMs, at: ts, left: left > 0 ? left : null };
    set = r;
    return true;
  });
  return set;
}

// A map that did not exist when the prompt arrived (taskmap init mid-prompt, or a
// project in a subdirectory) joins the prompt the first time the CLI touches it.
function ensureRun(dir, sid = envSid()) {
  if (!sid || !dir) return;
  const rec = readPrompt(sid);
  if (!rec || rec.ended || rec.dirs.includes(dir)) return;
  safe(() => {
    startRun(dir, rec);
    writePrompt({ ...rec, dirs: rec.dirs.concat(dir) });
  });
}

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return undefined; // progress tracking is never worth failing a hook or a command over
  }
}

// ---------- summaries (pure) ----------

function index(map) {
  const kids = new Map();
  for (const n of Object.values(map.nodes)) {
    if (n.parent === null || n.parent === undefined) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  return kids;
}

function skippedAbove(map, n) {
  const seen = new Set();
  for (let x = n; x && !seen.has(x.id); x = map.nodes[x.parent]) {
    seen.add(x.id);
    if (x.status === 'skipped') return true;
  }
  return false;
}

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Median gap between consecutive finished steps: the project's usual pace, breaks left out.
function gapSamples(map) {
  const kids = index(map);
  const times = Object.values(map.nodes)
    .filter((n) => n.status === 'done' && n.id !== map.root && !kids.has(n.id))
    .map((n) => ms(n.finished_at))
    .filter((t) => t !== null)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g >= GAP_MIN_MS && g <= GAP_MAX_MS) gaps.push(g);
  }
  return gaps;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function priorPace(map, fallback = null) {
  const gaps = gapSamples(map);
  return gaps.length >= 3 ? median(gaps) : fallback;
}

// How many steps a milestone the plan has not broken down yet is likely worth. Milestones
// finished without ever being broken down count as the one step they turned out to be.
function chunksPerMilestone(map, kids) {
  const counts = [];
  for (const m of kids.get(map.root) || []) {
    if (!kids.has(m.id)) {
      if (m.status === 'done') counts.push(1);
      continue;
    }
    let leaves = 0;
    const walk = (id) => {
      for (const k of kids.get(id) || []) {
        if (kids.has(k.id)) walk(k.id);
        else leaves += 1;
      }
    };
    walk(m.id);
    counts.push(leaves);
  }
  if (!counts.length) return DEFAULT_CHUNKS;
  return Math.min(8, Math.max(1, counts.reduce((a, b) => a + b, 0) / counts.length));
}

function summarizeRun(map, kids, run, all, { now, live, prior, chunks }) {
  const t0 = ms(run.started) || now;
  const t1 = run.ended ? ms(run.ended) || now : Infinity;
  const within = (iso) => {
    const t = ms(iso);
    return t !== null && t >= t0 && t <= t1;
  };
  const sid = run.sid || null;
  // Sessions with their own prompt running at the same time: what they touch is theirs.
  const rivals = new Set(
    all
      .filter((o) => o !== run && o.sid && o.sid !== sid && (ms(o.started) || 0) <= (t1 === Infinity ? now : t1) && (!o.ended || ms(o.ended) >= t0))
      .map((o) => o.sid)
  );
  // A session with no prompt of its own on this map (a subagent, a workflow agent) works
  // for whichever prompt is running: its steps count here. Rival prompts' steps do not.
  const mine = (x) => !sid || !x || x === sid || !rivals.has(x);
  const nodes = Object.values(map.nodes).filter((n) => n.id !== map.root);
  // Work left open by an earlier prompt is this prompt's only once it picks some of it
  // up (a status change on one of those nodes): "go ahead" carries the old plan, a new
  // request or a quick question does not.
  const leftover = (run.open || []).map((id) => map.nodes[id]).filter(Boolean);
  const engaged = leftover.some((n) => within(n.updated) && (sid ? Boolean(n.by) && mine(n.by) : n.status !== 'pending'));
  const open = new Set(engaged ? run.open : []);

  // With an estimate from Claude, the pace is measured from when it was given: the time
  // spent looking around before the plan is already in it.
  const est = run.estimate && run.estimate.ms > 0 ? run.estimate : null;
  const origin = est ? Math.max(t0, ms(est.at) || t0) : t0;

  let done = 0;
  let paceDone = 0;
  let graceDone = 0; // closed with the estimate: neither a pace sample nor work it still covers
  let total = 0;
  let waiting = 0;
  let steps = 0;
  let lastDone = null;
  let lastTouch = t0;
  for (const n of nodes) {
    if (kids.has(n.id)) continue;
    const added = within(n.created) && (mine(n.sid) || n.source === 'user');
    const carried = open.has(n.id) && mine(n.by);
    // Reopened, started or finished during this prompt by it (or its agents).
    const moved = within(n.finished_at) || within(n.started_at) || (n.status !== 'done' && within(n.updated));
    const touched = Boolean(sid && n.by && mine(n.by) && moved);
    if (!added && !carried && !touched) continue;
    if (skippedAbove(map, n)) continue;
    steps += 1;
    const t = ms(n.updated);
    if (t !== null && t > lastTouch && t <= (t1 === Infinity ? now : t1)) lastTouch = t;
    if (n.status === 'done') {
      done += 1;
      total += 1;
      const f = ms(n.finished_at);
      if (f !== null && f >= origin) {
        if (est && f - origin <= ESTIMATE_GRACE_MS) graceDone += 1;
        else {
          paceDone += 1;
          if (lastDone === null || f > lastDone) lastDone = f;
        }
      }
      continue;
    }
    // Only a milestone nobody has started may still grow sub-steps; one being worked on as is weighs 1.
    const w = n.parent === map.root && n.status === 'pending' ? chunks : 1;
    total += w;
    if (n.status === 'blocked') waiting += w;
  }

  const runPace = paceDone && lastDone !== null ? (lastDone - origin) / paceDone : null;
  const estPace = est ? est.ms / Math.max(1, (est.left || total) - graceDone) : null;

  const heartbeat = Boolean(live && sid && live.has(sid));
  let state;
  if (run.ended) state = total && done < total ? 'paused' : 'done';
  else state = heartbeat || now - lastTouch < STALE_MS ? 'running' : 'stopped';

  const r = {
    id: run.id,
    prompt: run.prompt || '',
    follow_ups: run.follow_ups || 0,
    started: run.started,
    ended: run.ended || null,
    state,
    steps,
    done,
    total: Math.round(total * 10) / 10,
    waiting: Math.round(waiting * 10) / 10,
    run_pace_ms: runPace ? Math.round(runPace) : null,
    // Per step: Claude's estimate spread over the work it covered, else the project's history.
    prior_ms: estPace ? Math.round(estPace) : prior ? Math.round(prior) : null,
    estimate_ms: est ? est.ms : null,
    estimate_at: est ? est.at : null,
    pace_from: new Date(origin).toISOString(),
    pace_done: paceDone,
    base: new Date(lastDone !== null ? lastDone : origin).toISOString(),
    elapsed_ms: Math.max(0, (run.ended ? t1 : now) - t0),
    agents: !run.ended && run.agents > 0 ? run.agents : 0, // background agents the idle lead waits on
  };
  return Object.assign(r, extrapolate(r, now)); // pct, eta_ms and pace_ms at `now`
}

// Newest first: the last `limit` runs plus any older one that has not ended.
function summarize(map, doc, { now = Date.now(), live = null, prior = null, limit = 10 } = {}) {
  const all = (doc && doc.runs) || [];
  const kids = index(map);
  const chunks = chunksPerMilestone(map, kids);
  const ownPrior = priorPace(map, prior);
  return all
    .filter((r, i) => i >= all.length - limit || !r.ended)
    .reverse()
    .map((r) => summarizeRun(map, kids, r, all, { now, live, prior: ownPrior, chunks }));
}

module.exports = {
  MAX_RUNS,
  sidOf,
  envSid,
  excerpt,
  promptFile,
  readPrompt,
  runsFile,
  readRuns,
  statRuns,
  openLeaves,
  isNotification,
  onPrompt,
  onStop,
  ensureRun,
  setEstimate,
  gapSamples,
  median,
  priorPace,
  extrapolate,
  summarize,
};
