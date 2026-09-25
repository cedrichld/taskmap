'use strict';
// tests/runs.test.js — per-prompt runs (src/runs.js): hook bookkeeping and the progress/ETA maths.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TASKMAP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-home-'));
const store = require('../src/store');
const runs = require('../src/runs');

const MIN = 60000;
const T0 = Date.parse('2026-09-25T10:00:00Z');
const at = (m) => new Date(T0 + m * MIN).toISOString();

// A map built by hand: add(id, parent, status, extra). Everything defaults to "before the run".
function mapOf(spec) {
  const nodes = { n0: { id: 'n0', parent: null, order: 0, title: 'root', status: 'pending', source: 'claude', created: at(-600), updated: at(-600) } };
  for (const [id, parent, status, extra] of spec) {
    nodes[id] = Object.assign({ id, parent, order: 0, title: id, status, source: 'claude', created: at(-500), updated: at(-500), started_at: null, finished_at: null }, extra || {});
  }
  return { id: 'fx', name: 'fx', root: 'n0', nodes };
}
const run = (extra) => Object.assign({ id: 'r1', sid: 'aaa', prompt: 'do the thing', started: at(0), ended: null, open: [] }, extra || {});
const one = (map, r, opts) => runs.summarize(map, { runs: [r] }, Object.assign({ now: T0 + 30 * MIN }, opts))[0];

test('excerpt keeps one line and cuts long prompts', () => {
  assert.equal(runs.excerpt('  fix\n\nthe   bug '), 'fix the bug');
  const long = runs.excerpt('x'.repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(runs.sidOf('abc'), runs.sidOf('abc'));
  assert.equal(runs.sidOf(''), null);
});

test('a plan made during the prompt is its scope; unplanned milestones weigh what milestones here turn out to be', () => {
  const inRun = (m, extra) => Object.assign({ created: at(m), updated: at(m), sid: 'aaa' }, extra || {});
  const map = mapOf([
    ['n1', 'n0', 'in_progress', inRun(1)],
    ['n2', 'n1', 'done', inRun(1, { finished_at: at(10), updated: at(10), by: 'aaa' })],
    ['n3', 'n1', 'in_progress', inRun(1, { started_at: at(10), by: 'aaa' })],
    ['n4', 'n1', 'pending', inRun(1)],
    ['n5', 'n0', 'pending', inRun(1)],
    ['n6', 'n0', 'pending', inRun(1)],
    ['old', 'n0', 'done', { finished_at: at(-400) }],
  ]);
  const r = one(map, run());
  // n1 is broken into 3 steps and "old" (an earlier prompt's) was finished as 1, so n5 and
  // n6 count 2 each.
  assert.equal(r.steps, 5);
  assert.equal(r.total, 3 + 2 + 2);
  assert.equal(r.done, 1);
  assert.equal(r.state, 'running');
  // One step in 10 minutes, then 20 more without another: 30 min for about 2 steps
  // stretches the pace to 15; partial credit for the step under way is capped at 0.8.
  assert.equal(r.run_pace_ms, 10 * MIN);
  assert.equal(r.pace_ms, 15 * MIN);
  assert.equal(r.base, at(10));
  assert.equal(r.eta_ms, Math.round((7 - 1 - 0.8) * 15 * MIN));
  assert.ok(Math.abs(r.pct - 1.8 / 7) < 1e-9);
  // A milestone started as is will not grow sub-steps: it weighs 1.
  map.nodes.n5.status = 'in_progress';
  assert.equal(one(map, run()).total, 3 + 1 + 2);
  // Right after that first step, the pace is the plain 10 minutes.
  assert.equal(one(map, run(), { now: T0 + 11 * MIN }).pace_ms, 10 * MIN);
});

test('work left open by an earlier prompt joins only once this prompt touches the map', () => {
  const map = mapOf([
    ['n1', 'n0', 'in_progress'],
    ['n2', 'n1', 'pending'],
    ['n3', 'n1', 'pending'],
  ]);
  const r = run({ open: ['n2', 'n3'] });
  assert.equal(one(map, r).total, 0, 'a quick question does not inherit the backlog');
  map.nodes.n9 = Object.assign({}, map.nodes.n3, { id: 'n9', created: at(1), updated: at(1), sid: 'aaa' });
  assert.equal(one(map, r).steps, 1, 'nor does a new request that only adds steps');
  delete map.nodes.n9;
  map.nodes.n2 = Object.assign(map.nodes.n2, { status: 'in_progress', by: 'aaa', updated: at(2), started_at: at(2) });
  const s = one(map, r);
  assert.equal(s.total, 2);
  assert.equal(s.steps, 2);
});

test('two sessions on one map each count only their own prompt', () => {
  const map = mapOf([
    ['n1', 'n0', 'in_progress'],
    ['a1', 'n1', 'done', { created: at(1), updated: at(5), sid: 'aaa', by: 'aaa', finished_at: at(5) }],
    ['a2', 'n1', 'pending', { created: at(1), updated: at(1), sid: 'aaa' }],
    ['b1', 'n1', 'done', { created: at(2), updated: at(6), sid: 'bbb', by: 'bbb', finished_at: at(6) }],
    ['b2', 'n1', 'pending', { created: at(2), updated: at(2), sid: 'bbb' }],
    ['b3', 'n1', 'pending', { created: at(2), updated: at(2), sid: 'bbb' }],
    ['shared', 'n1', 'done', { updated: at(7), by: 'bbb', finished_at: at(7) }],
    ['mine', 'n1', 'pending', { created: at(3), updated: at(3), source: 'user' }],
  ]);
  const doc = { runs: [run({ open: ['shared'] }), run({ id: 'r2', sid: 'bbb', open: ['shared'] })] };
  const [b, a] = runs.summarize(map, doc, { now: T0 + 30 * MIN });
  // "shared" was open for both; session bbb finished it, so it is bbb's. The user's node counts for both.
  assert.deepEqual([a.id, a.steps, a.done], ['r1', 3, 1]);
  assert.deepEqual([b.id, b.steps, b.done], ['r2', 5, 2]);
});

test("a subagent's steps count for the prompt it works under", () => {
  const map = mapOf([
    ['n1', 'n0', 'in_progress', { created: at(1), sid: 'aaa' }],
    ['n2', 'n1', 'done', { created: at(1), updated: at(9), sid: 'aaa', by: 'sub', started_at: at(2), finished_at: at(9) }],
    ['n3', 'n1', 'in_progress', { created: at(3), updated: at(3), sid: 'sub', by: 'sub', started_at: at(3) }],
    ['n4', 'n1', 'pending', { created: at(4), updated: at(4), sid: 'bbb' }],
  ]);
  const doc = { runs: [run(), run({ id: 'r2', sid: 'bbb', started: at(2) })] };
  const a = runs.summarize(map, doc, { now: T0 + 20 * MIN })[1];
  assert.deepEqual([a.id, a.steps, a.done], ['r1', 2, 1]);
});

test('ended runs are done or paused; unended ones stop when the session is gone', () => {
  const map = mapOf([
    ['n1', 'n0', 'in_progress', { created: at(1), sid: 'aaa' }],
    ['n2', 'n1', 'done', { created: at(1), updated: at(4), sid: 'aaa', by: 'aaa', finished_at: at(4) }],
    ['n3', 'n1', 'blocked', { created: at(1), updated: at(5), sid: 'aaa', by: 'aaa' }],
  ]);
  const paused = one(map, run({ ended: at(6) }));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.waiting, 1);
  assert.equal(paused.elapsed_ms, 6 * MIN);
  assert.equal(paused.eta_ms, null);
  map.nodes.n3.status = 'done';
  map.nodes.n3.finished_at = at(6);
  assert.equal(one(map, run({ ended: at(6) })).state, 'done');
  assert.equal(one(map, run({ ended: at(0.5) })).steps, 0, 'what came after the run ended is not its work');
  const late = T0 + 5 * 3600 * 1000;
  assert.equal(one(map, run(), { now: late }).state, 'stopped');
  assert.equal(one(map, run(), { now: late, live: new Set(['aaa']) }).state, 'running');
});

test('the pace blends this prompt with the project history, and the browser formula agrees', () => {
  const history = [];
  for (let i = 0; i < 5; i++) history.push([`h${i}`, 'n0', 'done', { finished_at: at(-300 + i * 4) }]);
  const map = mapOf(history.concat([
    ['n1', 'n0', 'in_progress', { created: at(1), sid: 'aaa' }],
    ['n2', 'n1', 'done', { created: at(1), updated: at(12), sid: 'aaa', by: 'aaa', finished_at: at(12) }],
    ['n3', 'n1', 'pending', { created: at(1), sid: 'aaa' }],
  ]));
  assert.equal(runs.priorPace(map), 4 * MIN);
  const r = one(map, run(), { now: T0 + 13 * MIN });
  assert.equal(r.pace_ms, Math.round((1 * 12 * MIN + 2 * 4 * MIN) / 3));
  const later = runs.extrapolate(r, T0 + 14 * MIN);
  assert.ok(later.eta_ms < r.eta_ms, 'the ETA counts down between updates');
  assert.equal(runs.extrapolate({ ...r, state: 'done' }, T0).eta_ms, null);
});

test('hooks: a prompt opens a run, stop ends it, a message mid-turn joins the running one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-proj-'));
  store.initProject(dir, { name: 'p', goal: 'g', track: true });
  store.mutate(dir, 'cli', (map, ctx) => store.addBatch(map, ctx, [{ key: 'a', parent: 'n0', title: 'Left over' }]));
  runs.onPrompt({ sessionId: 'S1', prompt: 'first\nprompt', dir, ts: at(0) });
  let doc = runs.readRuns(dir);
  assert.equal(doc.runs.length, 1);
  assert.deepEqual([doc.runs[0].prompt, doc.runs[0].ended, doc.runs[0].open], ['first prompt', null, ['n1']]);
  // Typed while the turn runs: same run, the first prompt keeps the bar.
  runs.onPrompt({ sessionId: 'S1', prompt: 'also do this', dir, ts: at(3) });
  doc = runs.readRuns(dir);
  assert.deepEqual(doc.runs.map((r) => [r.id, r.prompt, r.ended, r.follow_ups]), [['r1', 'first prompt', null, 1]]);
  runs.onStop({ sessionId: 'S1', dir: null, ts: at(9) }); // cwd elsewhere: the prompt record knows the project
  assert.equal(runs.readRuns(dir).runs[0].ended, at(9));
  assert.equal(runs.readPrompt(runs.sidOf('S1')).ended, at(9));
  const before = fs.statSync(runs.runsFile(dir)).mtimeMs;
  runs.onStop({ sessionId: 'S1', dir, ts: at(10) });
  assert.equal(fs.statSync(runs.runsFile(dir)).mtimeMs, before, 'nothing to end, nothing rewritten');
  // After a Stop, the next prompt is a new turn.
  runs.onPrompt({ sessionId: 'S1', prompt: 'second', dir, ts: at(20) });
  // Interrupted with Esc (no Stop): the transcript says so, and the next prompt is a new run.
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: at(25) }) + '\n');
  runs.onPrompt({ sessionId: 'S1', prompt: 'third', dir, transcriptPath: transcript, ts: at(30) });
  doc = runs.readRuns(dir);
  assert.deepEqual(doc.runs.map((r) => [r.id, r.prompt, r.ended]), [['r1', 'first prompt', at(9)], ['r2', 'second', at(30)], ['r3', 'third', null]]);
});

test('a notification resumes the last prompt instead of starting one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-note-'));
  store.initProject(dir, { name: 'n', goal: 'g', track: true });
  const note = '<task-notification> <task-id>b1</task-id> <summary>Agent finished</summary>';
  runs.onPrompt({ sessionId: 'S3', prompt: note, dir, ts: at(0) });
  assert.equal(runs.readRuns(dir).runs.length, 0, 'no run named after a notification');
  runs.onPrompt({ sessionId: 'S3', prompt: 'revamp the site with a few agents', dir, ts: at(1) });
  runs.onStop({ sessionId: 'S3', dir, ts: at(5) });
  runs.onPrompt({ sessionId: 'S3', prompt: note, dir, ts: at(30) });
  const doc = runs.readRuns(dir);
  assert.deepEqual(doc.runs.map((r) => [r.prompt, r.ended, r.follow_ups]), [['revamp the site with a few agents', null, 1]]);
  assert.equal(runs.isNotification('fix <task-notification> parsing'), false);
  assert.equal(runs.isNotification('<cross-session-message from="lab chat">give an ETA</cross-session-message>'), true);
  assert.equal(runs.isNotification('<agent-message from="af318a1ea5a3c40c0"> [Subagent hand-back] report'), true); // seen live: a hand-back started a run
});

test('a map created mid-prompt joins the prompt that made it', () => {
  runs.onPrompt({ sessionId: 'S2', prompt: 'build it', dir: null, ts: at(0) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-new-'));
  store.initProject(dir, { name: 'q', goal: 'g', track: true });
  runs.ensureRun(dir, runs.sidOf('S2'));
  runs.ensureRun(dir, runs.sidOf('S2'));
  const doc = runs.readRuns(dir);
  assert.equal(doc.runs.length, 1);
  assert.deepEqual([doc.runs[0].started, doc.runs[0].prompt, doc.runs[0].sid], [at(0), 'build it', runs.sidOf('S2')]);
  const r = store.mutate(dir, 'cli', (map, ctx) => store.newNode(map, ctx, { parent: 'n0', title: 'Step' }), { sid: runs.sidOf('S2') });
  assert.equal(r.result.sid, runs.sidOf('S2'));
});

test('background agents: the turn ends, the run keeps going until they report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-agents-'));
  store.initProject(dir, { name: 'a', goal: 'g', track: true });
  const sid = runs.sidOf('S4');
  const last = () => runs.readRuns(dir).runs.slice(-1)[0];
  runs.onPrompt({ sessionId: 'S4', prompt: 'fix both bugs with two agents', dir, ts: at(0) });
  runs.onStop({ sessionId: 'S4', dir, agents: 2, ts: at(4) });
  assert.deepEqual([last().ended, last().agents], [null, 2], 'the lead waits; the run stays open');
  assert.equal(runs.readPrompt(sid).ended, null, 'the prompt is not over');
  // Typed while the agents work: joins, as it would mid-turn.
  runs.onPrompt({ sessionId: 'S4', prompt: 'lab 5 is out, no worries', dir, ts: at(6) });
  assert.deepEqual([runs.readRuns(dir).runs.length, last().follow_ups, last().agents], [1, 1, undefined]);
  runs.onStop({ sessionId: 'S4', dir, agents: 2, ts: at(7) });
  // One agent reports: the lead resumes, then waits on the other.
  runs.onPrompt({ sessionId: 'S4', prompt: '<task-notification> <task-id>a1</task-id>', dir, ts: at(12) });
  assert.deepEqual([last().ended, last().agents], [null, undefined]);
  runs.onStop({ sessionId: 'S4', dir, agents: 1, ts: at(13) });
  assert.equal(last().agents, 1);
  runs.onPrompt({ sessionId: 'S4', prompt: '<task-notification> <task-id>a2</task-id>', dir, ts: at(20) });
  runs.onStop({ sessionId: 'S4', dir, ts: at(22) });
  assert.deepEqual([runs.readRuns(dir).runs.length, last().ended], [1, at(22)], 'all back: the run ends');
  assert.equal(runs.readPrompt(sid).ended, at(22));
});

test('a run waiting on agents keeps its ETA and says so', () => {
  const inRun = (m, extra) => Object.assign({ created: at(m), updated: at(m), sid: 'aaa' }, extra || {});
  const map = mapOf([
    ['m', 'n0', 'in_progress', inRun(1)],
    ['a', 'm', 'done', inRun(1, { started_at: at(2), finished_at: at(6), updated: at(6) })],
    ['b', 'm', 'in_progress', inRun(1, { started_at: at(6), updated: at(6) })],
    ['c', 'm', 'in_progress', inRun(1, { started_at: at(6), updated: at(6) })],
  ]);
  const r = one(map, run({ agents: 2 }), { now: T0 + 9 * MIN });
  assert.deepEqual([r.state, r.agents], ['running', 2]);
  assert.ok(r.eta_ms > 0, 'the ETA keeps counting');
  const P = require('../ui/prompts');
  const w = P.words(r, T0 + 9 * MIN);
  assert.match(w.eta, /^ETA ~~\d/, 'no estimate from Claude: taskmap\'s own, marked ~~');
  assert.equal(w.small, '2 agents working · 9min in');
  assert.equal(P.words({ ...r, agents: 1 }, T0 + 9 * MIN).small, '1 agent working · 9min in');
  assert.equal(one(map, run({ agents: 2, ended: at(8) }), { now: T0 + 9 * MIN }).agents, 0, 'an ended run waits on nothing');
});

test("Claude's estimate sets the pace; without one, no guess before the first step", () => {
  const inRun = (m, extra) => Object.assign({ created: at(m), updated: at(m), sid: 'aaa' }, extra || {});
  const map = mapOf([
    ['m', 'n0', 'in_progress', inRun(4)],
    ['a', 'm', 'in_progress', inRun(4, { started_at: at(4) })],
    ['b', 'm', 'pending', inRun(4)],
    ['c', 'm', 'pending', inRun(4)],
    ['d', 'm', 'pending', inRun(4)],
    ['old', 'n0', 'done', { finished_at: at(-400) }],
    ['old2', 'n0', 'done', { finished_at: at(-390) }],
    ['old3', 'n0', 'done', { finished_at: at(-300) }],
  ]);
  // The project's history says ~45 min a step; nothing is done yet: no ETA at all.
  const P = require('../ui/prompts');
  const bare = one(map, run(), { now: T0 + 5 * MIN });
  assert.equal(bare.eta_ms, null);
  assert.equal(P.words(bare, T0 + 5 * MIN).eta, 'ETA after 1st step');
  // Four minutes of looking around, then "taskmap eta 12m" with the plan: 3 min a step.
  const est = { ms: 12 * MIN, at: at(4), left: 4 };
  const r = one(map, run({ estimate: est }), { now: T0 + 4 * MIN });
  assert.deepEqual([r.prior_ms, r.estimate_ms, r.pace_from, r.base], [3 * MIN, 12 * MIN, at(4), at(4)]);
  assert.equal(r.eta_ms, 12 * MIN, 'at the moment it is given, the ETA is the estimate');
  assert.equal(P.words(r, T0 + 4 * MIN).eta, 'ETA 12min', "Claude's estimate carries no ~");
  const later = one(map, run({ estimate: est }), { now: T0 + 6 * MIN });
  assert.equal(later.eta_ms, Math.round((4 - 2 / 3) * 3 * MIN), 'and counts down');
  assert.equal(P.words(later, T0 + 6 * MIN).eta, 'ETA 10min', 'counting down on schedule is still Claude\'s');
  // Sixteen minutes on, nothing finished: the estimate has run out and taskmap stretches it.
  const late = one(map, run({ estimate: est }), { now: T0 + 20 * MIN });
  assert.ok(late.eta_ms > 0);
  assert.match(P.words(late, T0 + 20 * MIN).eta, /^ETA ~\d/);
  assert.equal(P.etaSource(late, T0 + 20 * MIN, late.eta_ms), 'adjusted');
  // Steps finishing faster than estimated pull the ETA in.
  map.nodes.a = Object.assign(map.nodes.a, { status: 'done', finished_at: at(5), updated: at(5), by: 'aaa' });
  map.nodes.b = Object.assign(map.nodes.b, { status: 'done', finished_at: at(6), updated: at(6), by: 'aaa' });
  const fast = one(map, run({ estimate: est }), { now: T0 + 6 * MIN });
  assert.deepEqual([fast.pace_done, fast.run_pace_ms], [2, MIN]);
  assert.equal(fast.pace_ms, Math.round((2 * MIN + 2 * 3 * MIN) / 4));
  assert.match(P.words(fast, T0 + 6 * MIN).eta, /^ETA ~\d/, 'ahead of schedule: moved by taskmap');
});

test('setEstimate puts the estimate on the session\'s open run with the work it covers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmap-runs-eta-'));
  store.initProject(dir, { name: 'e', goal: 'g', track: true });
  const sid = runs.sidOf('S5');
  runs.onPrompt({ sessionId: 'S5', prompt: 'small fixes', dir, ts: at(0) });
  store.mutate(dir, 'cli', (map, ctx) => store.addBatch(map, ctx, [
    { key: 'm', parent: 'n0', title: 'Fix it' },
    { key: 'a', parent: 'm', title: 'One' },
    { key: 'b', parent: 'm', title: 'Two' },
  ]), { sid });
  const r = runs.setEstimate(dir, sid, 10 * MIN, at(2));
  assert.deepEqual(r.estimate, { ms: 10 * MIN, at: at(2), left: 2 });
  assert.equal(runs.setEstimate(dir, runs.sidOf('nobody'), MIN, at(3)), null, 'no open run for that session');
  runs.onStop({ sessionId: 'S5', dir, ts: at(9) });
  assert.equal(runs.setEstimate(dir, sid, MIN, at(10)), null, 'a finished prompt takes no estimate');
});
