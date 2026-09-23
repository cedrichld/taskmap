'use strict';
// tests/ui.test.js — the pure parts of the dashboard (ui/constellation.js) under node:test.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ui/constellation.js');

function fixture() {
  const nodes = {};
  const add = (id, parent, title, status, extra) => {
    nodes[id] = Object.assign({ id, parent, order: Object.keys(nodes).length, title, status, status_reason: null, source: 'claude', links: [], notes: [], feedback: [], created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', started_at: null, finished_at: null }, extra || {});
  };
  add('n0', null, 'Root', 'pending');
  add('n1', 'n0', 'Closed milestone', 'done', { finished_at: '2026-09-02T10:00:00Z' });
  add('n2', 'n1', 'Done leaf A', 'done', { finished_at: '2026-09-01T10:00:00Z' });
  add('n3', 'n1', 'Done leaf B', 'done', { finished_at: '2026-09-02T09:00:00Z' });
  add('n4', 'n0', 'Open milestone', 'in_progress');
  add('n5', 'n4', 'Done leaf C', 'done', { finished_at: '2026-09-03T10:00:00Z', notes: [{ ts: '2026-09-03T10:00:00Z', text: 'lives in x.js' }] });
  add('n6', 'n4', 'Pending leaf', 'pending');
  add('n7', 'n4', 'Blocked leaf', 'blocked', { status_reason: 'waiting on user: which colour?' });
  add('n8', 'n4', 'Open chunk', 'in_progress');
  add('n9', 'n8', 'Step in progress', 'in_progress');
  add('n10', 'n8', 'Step done', 'done', { finished_at: '2026-09-04T10:00:00Z' });
  add('n11', 'n0', 'Skipped milestone', 'skipped', { status_reason: 'not needed', updated: '2026-09-05T10:00:00Z' });
  add('n12', 'n11', 'Orphan pending', 'pending');
  return { schema: 1, id: 'fx', name: 'Fixture', root: 'n0', nodes };
}
const ids = (tree) => C.flatten(tree).map((it) => it.id);

test('open scope keeps only unfinished work and what contains it', () => {
  const map = fixture();
  const kids = C.index(map);
  const tree = C.visibleTree(map, kids, { scope: 'open', collapsed: new Set() });
  assert.deepEqual(ids(tree), ['n0', 'n4', 'n6', 'n7', 'n8', 'n9']);
  const m2 = C.flatten(tree).find((it) => it.id === 'n4');
  assert.equal(m2.hiddenDone, 1);
  assert.equal(m2.kind, 'parent');
  assert.equal(C.flatten(tree).find((it) => it.id === 'n9').kind, 'leaf');
});

test('all scope shows everything, in order', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'all', collapsed: new Set() });
  assert.deepEqual(ids(tree), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12']);
});

test('a collapsed node keeps its children out', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'all', collapsed: new Set(['n4']) });
  assert.deepEqual(ids(tree), ['n0', 'n1', 'n2', 'n3', 'n4', 'n11', 'n12']);
  assert.equal(C.flatten(tree).find((it) => it.id === 'n4').collapsed, true);
});

test('the done list is newest first, leaves only, skipped included, with its path', () => {
  const map = fixture();
  const list = C.doneList(map, C.index(map));
  assert.deepEqual(list.map((r) => r.n.id), ['n11', 'n10', 'n5', 'n3', 'n2']);
  assert.deepEqual(list[1].path, ['Open milestone', 'Open chunk']);
  assert.equal(list[2].note, 'lives in x.js');
  assert.equal(list[0].when, '2026-09-05T10:00:00Z');
});

test('the layout keeps children clear of their parent and of each other, and is deterministic', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'all', collapsed: new Set() });
  const a = C.layout(tree);
  const b = C.layout(tree);
  assert.deepEqual(a.map((it) => [it.id, it.x, it.y, it.z, it.r]), b.map((it) => [it.id, it.x, it.y, it.z, it.r]));
  const at = new Map(a.map((it) => [it.id, it]));
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  for (const it of a) {
    if (!it.parent) continue;
    const p = at.get(it.parent.id);
    assert.ok(dist(it, p) >= it.r + p.r + 4, `${it.id} sits on its parent`);
    for (const s of a) {
      if (s === it || !s.parent || s.parent.id !== it.parent.id) continue;
      assert.ok(dist(it, s) >= it.r + s.r + 4, `${it.id} overlaps its sibling ${s.id}`);
    }
  }
  assert.equal(at.get('n0').x, 0);
  assert.equal(at.get('n0').y, 0);
  assert.equal(at.get('n0').z, 0);
  assert.ok(at.get('n0').r > at.get('n1').r && at.get('n1').r > at.get('n2').r, 'root > parent > leaf');
});

test('an only child sits straight out from its parent', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'open', collapsed: new Set() });
  const at = new Map(C.layout(tree).map((it) => [it.id, it]));
  const m = at.get('n4'); const c = at.get('n8'); const s = at.get('n9');
  const u = [c.x - m.x, c.y - m.y, c.z - m.z];
  const v = [s.x - c.x, s.y - c.y, s.z - c.z];
  const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  assert.ok(cross < 1e-6 * Math.hypot(...u) * Math.hypot(...v) + 1e-6 && dot > 0, 'n9 is not on the n4 -> n8 axis');
});

test('fit puts the whole cloud in the frame from every angle', () => {
  const R = 300;
  const cam = { yaw: 0.7, pitch: -0.4, focal: 900, dist: C.fitDistance(R, 900, 800, 600) };
  for (let i = 0; i < 200; i++) {
    const t = i * 2.399963; const y = 1 - (2 * i) / 199; const rr = Math.sqrt(1 - y * y);
    const p = { x: R * rr * Math.cos(t), y: R * y, z: R * rr * Math.sin(t) };
    const q = C.project(p, cam, 400, 300);
    assert.ok(q.x >= -1 && q.x <= 801 && q.y >= -1 && q.y <= 601, `point ${i} lands off screen at ${q.x},${q.y}`);
    assert.ok(q.s > 0, 'scale is positive');
  }
});

test('labels that overlap yield to the higher priority, trying their other spots first', () => {
  const chosen = C.placeLabels([
    { p: 2, cands: [{ x: 0, y: 0, w: 100, h: 20 }] },
    { p: 1, cands: [{ x: 50, y: 5, w: 100, h: 20 }, { x: 50, y: 40, w: 100, h: 20 }] },
    { p: 0, cands: [{ x: 300, y: 0, w: 50, h: 20 }] },
    { p: 0, cands: [{ x: 10, y: 10, w: 20, h: 20 }, { x: 60, y: 45, w: 20, h: 20 }] },
  ]);
  assert.deepEqual(chosen, [0, 1, 0, -1]);
});

test('the exact fit keeps every orb, margin included, inside the frame at every yaw', () => {
  const map = fixture();
  const items = C.layout(C.visibleTree(map, C.index(map), { scope: 'all', collapsed: new Set() }));
  const pts = items.map((it) => ({ x: it.x, y: it.y, z: it.z, m: it.r }));
  const cam = { yaw: 1.1, pitch: 0.5, focal: 900 };
  cam.dist = C.fitDistanceFor(pts, cam, 800, 600);
  for (let k = 0; k < 16; k++) {
    const c = { ...cam, yaw: cam.yaw + 0.1 + (k * Math.PI) / 8 };
    for (const p of pts) {
      const q = C.project(p, c, 400, 300);
      const r = p.m * q.s;
      assert.ok(q.x - r >= -1.5 && q.x + r <= 801.5 && q.y - r >= -1.5 && q.y + r <= 601.5, `orb lands off screen at yaw ${k}: ${q.x},${q.y}`);
    }
  }
});

test('an expanded node shows its finished children in the open scope', () => {
  const map = fixture();
  const kids = C.index(map);
  const tree = C.visibleTree(map, kids, { scope: 'open', expanded: new Set(['n4']) });
  assert.deepEqual(ids(tree), ['n0', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
  const m = C.flatten(tree).find((it) => it.id === 'n4');
  assert.equal(m.hidden, 0);
  const root = C.visibleTree(map, kids, { scope: 'open', expanded: new Set(['n0']) });
  const n1 = C.flatten(root).find((it) => it.id === 'n1');
  assert.ok(n1, 'the finished milestone shows once the root is opened');
  assert.equal(n1.hidden, 2, 'its own finished leaves stay folded until it is opened too');
});

test('the root cannot be folded away', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'all', collapsed: new Set(['n0']) });
  assert.equal(tree.collapsed, false);
  assert.ok(tree.children.length > 0);
});

test('one click opens whatever is hidden, folds the selected open node, else selects', () => {
  const map = fixture();
  const kids = C.index(map);
  const find = (tree, id) => C.flatten(tree).find((it) => it.id === id);
  const folded = C.visibleTree(map, kids, { scope: 'all', collapsed: new Set(['n1']) });
  assert.equal(C.clickAction(find(folded, 'n1'), null), 'reveal');
  assert.equal(C.clickAction(find(folded, 'n1'), 'n1'), 'reveal');
  const open = C.visibleTree(map, kids, { scope: 'open' });
  assert.equal(C.clickAction(find(open, 'n4'), null), 'reveal', 'n4 has a finished leaf hidden by the scope');
  const all = C.visibleTree(map, kids, { scope: 'all' });
  assert.equal(C.clickAction(find(all, 'n4'), null), 'select');
  assert.equal(C.clickAction(find(all, 'n4'), 'n4'), 'fold');
  assert.equal(C.clickAction(find(all, 'n9'), 'n9'), 'select', 'a leaf only selects');
  assert.equal(C.clickAction(all, 'n0'), 'select', 'the root never folds');
  const opened = C.visibleTree(map, kids, { scope: 'open', expanded: new Set(['n0']) });
  assert.equal(C.clickAction(opened, 'n0'), 'fold', 'an opened root drops back to the scope');
});

test('the flat layout is a radial tree: root in the middle, first milestone on top, no orb on another', () => {
  const map = fixture();
  const tree = C.visibleTree(map, C.index(map), { scope: 'all' });
  const items = C.layoutFlat(tree);
  const at = new Map(items.map((it) => [it.id, it]));
  assert.equal(at.get('n0').x, 0);
  assert.equal(at.get('n0').y, 0);
  assert.ok(items.every((it) => it.z === 0));
  assert.ok(Math.abs(at.get('n1').x) < 1e-6 && at.get('n1').y > 0, 'first milestone straight up');
  for (const a of items) {
    for (const b of items) {
      if (a === b) continue;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + 4, `${a.id} touches ${b.id}`);
    }
    if (a.parent) assert.ok(Math.hypot(a.x, a.y) > Math.hypot(at.get(a.parent.id).x, at.get(a.parent.id).y), `${a.id} is not outside its parent`);
  }
  assert.ok(tree.rings.length >= 4 && tree.rings[1] < tree.rings[2]);
  const f = C.fitFlat(items.map((it) => ({ x: it.x, y: it.y, m: it.r })), 900, 800, 600);
  const k = 900 / f.dist;
  for (const it of items) {
    const sx = 400 + (it.x - f.x) * k; const sy = 300 - (it.y - f.y) * k;
    assert.ok(sx >= -0.5 && sx <= 800.5 && sy >= -0.5 && sy <= 600.5, `${it.id} lands off the frame`);
  }
});

test('the floor grid lies flat under the cloud and fades to its rim', () => {
  const g = C.floorGrid(300);
  assert.ok(g.y < -300);
  assert.ok(g.segs.length > 20);
  for (const s of g.segs) {
    assert.equal(s.a.y, g.y); assert.equal(s.b.y, g.y);
    assert.ok(Math.hypot(s.a.x, s.a.z) <= g.disc + 1e-6 && Math.hypot(s.b.x, s.b.z) <= g.disc + 1e-6);
    assert.ok(s.w >= 0 && s.w <= 1.6);
  }
});
