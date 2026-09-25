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

test('a plan made during the prompt is its scope; unplanned milestones weigh like planned ones', () => {
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
  // n1 is broken into 3 steps, so n5 and n6 count 3 each; "old" belongs to an earlier prompt.
  assert.equal(r.steps, 5);
  assert.equal(r.total, 3 + 3 + 3);
  assert.equal(r.done, 1);
  assert.equal(r.state, 'running');
  // One step in 10 minutes, 20 minutes into the next: partial credit is capped at 0.8.
  assert.equal(r.pace_ms, 10 * MIN);
  assert.equal(r.base, at(10));
  assert.equal(r.eta_ms, Math.round((9 - 1 - 0.8) * 10 * MIN));
  assert.ok(Math.abs(r.pct - 1.8 / 9) < 1e-9);
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
