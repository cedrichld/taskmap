'use strict';
/* taskmap constellation — the pure parts of the 3D map: which nodes the scope shows,
   where each one sits in space, how a point lands on the screen, which labels yield.
   No DOM here: ui/app.js loads it in the browser, tests/ui.test.js in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Constellation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const idNum = (id) => parseInt(String(id).slice(1), 10) || 0;
  const closed = (s) => s === 'done' || s === 'skipped';

  // ---------- the tree ----------
  function index(map) {
    const kids = new Map();
    for (const n of Object.values(map.nodes)) {
      if (!kids.has(n.id)) kids.set(n.id, []);
      if (n.parent != null) {
        if (!kids.has(n.parent)) kids.set(n.parent, []);
        kids.get(n.parent).push(n);
      }
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.order - b.order || idNum(a.id) - idNum(b.id));
    return kids;
  }

  // The scope decides what the graph and the outline draw. `open` keeps a node when it,
  // or anything under it, is still pending, in progress or blocked; a skipped parent
  // closes everything beneath it. `all` keeps every node. The root always stays.
  function visibleTree(map, kids, { scope = 'open', collapsed = new Set() } = {}) {
    const keep = new Map();
    const decide = (id, underSkipped) => {
      const n = map.nodes[id];
      const skipped = underSkipped || n.status === 'skipped';
      let any = false;
      for (const k of kids.get(id) || []) if (decide(k.id, skipped)) any = true;
      const own = !skipped && !closed(n.status);
      const v = scope === 'all' || id === map.root || own || any;
      keep.set(id, v);
      return v;
    };
    decide(map.root, false);
    const build = (id, depth, parent) => {
      const n = map.nodes[id];
      const all = kids.get(id) || [];
      const it = {
        id, n, depth, parent, children: [],
        kind: id === map.root ? 'root' : all.length ? 'parent' : 'leaf',
        collapsed: collapsed.has(id) && all.length > 0,
        hiddenDone: all.filter((k) => !keep.get(k.id)).length,
      };
      if (!it.collapsed) for (const k of all) if (keep.get(k.id)) it.children.push(build(k.id, depth + 1, it));
      return it;
    };
    return build(map.root, 0, null);
  }
  function flatten(tree) {
    const out = [];
    const walk = (it) => { out.push(it); for (const c of it.children) walk(c); };
    walk(tree);
    return out;
  }
  function titlePath(map, id) {
    const out = [];
    for (let n = map.nodes[id]; n && n.parent != null && n.parent !== map.root; ) {
      n = map.nodes[n.parent];
      if (n) out.unshift(n.title);
    }
    return out;
  }
  const whenOf = (n) => n.finished_at || n.updated || n.created || '';
  // Finished work, newest first: every done or skipped leaf, plus a skipped parent as one row.
  function doneList(map, kids) {
    const rows = [];
    for (const n of Object.values(map.nodes)) {
      if (n.id === map.root) continue;
      const leaf = !(kids.get(n.id) || []).length;
      if (!((leaf && closed(n.status)) || (!leaf && n.status === 'skipped'))) continue;
      const notes = n.notes || [];
      rows.push({ n, path: titlePath(map, n.id), when: whenOf(n), note: notes.length ? String(notes[notes.length - 1].text || '') : '' });
    }
    return rows.sort((a, b) => b.when.localeCompare(a.when) || idNum(b.n.id) - idNum(a.n.id));
  }
  function scopeCounts(map, kids) {
    const tree = visibleTree(map, kids, { scope: 'open' });
    return { open: flatten(tree).filter((it) => it.kind === 'leaf').length, done: doneList(map, kids).length };
  }

  // ---------- 3D layout: a dandelion ----------
  // The root sits at the origin with its milestones spread over a sphere around it.
  // Every deeper level spreads over a cap of a sphere around its parent, facing away
  // from the grandparent, so a branch grows outward like a seed head. Each sphere is
  // just wide enough that no two sibling subtrees can touch.
  const GAP = 30;
  const CAP = 0.3; // cosine of the cap's half-angle (about 72 degrees) below the root
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  function orbRadius(it) {
    if (it.kind === 'root') return 26;
    if (it.kind === 'parent') return it.depth === 1 ? 16 : it.depth === 2 ? 11 : 8;
    return closed(it.n.status) ? 4.5 : 7.5;
  }
  function hash(id) {
    let h = 2166136261;
    for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 1000) / 1000;
  }
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // k unit vectors spread evenly over a cap, as [across, across, along-the-axis].
  function capPoints(k, cosCap, phase) {
    const out = [];
    for (let i = 0; i < k; i++) {
      const a = 1 - (1 - cosCap) * ((i + 0.5) / k);
      const rr = Math.sqrt(Math.max(0, 1 - a * a));
      const phi = phase + i * GOLDEN;
      out.push([rr * Math.cos(phi), rr * Math.sin(phi), a]);
    }
    return out;
  }

  function layout(tree) {
    const measure = (it) => {
      it.r = orbRadius(it);
      const cs = it.children;
      if (!cs.length) { it.R = it.r; it.ring = 0; it.dirs = []; return; }
      for (const c of cs) measure(c);
      const maxR = Math.max(...cs.map((c) => c.R));
      if (cs.length === 1) {
        it.dirs = [[0, 0, 1]];
        it.ring = it.r + cs[0].R + GAP;
        it.R = it.ring + cs[0].R;
        return;
      }
      const dirs = capPoints(cs.length, it.kind === 'root' ? -1 : CAP, hash(it.id) * Math.PI * 2);
      let ring = it.r + maxR + GAP;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const theta = Math.acos(Math.max(-1, Math.min(1, dot(dirs[i], dirs[j]))));
          ring = Math.max(ring, (cs[i].R + cs[j].R + GAP) / (2 * Math.sin(Math.max(1e-3, theta) / 2)));
        }
      }
      it.dirs = dirs;
      it.ring = ring;
      it.R = ring + maxR;
    };
    measure(tree);
    const place = (it, pos, axis) => {
      it.x = pos[0]; it.y = pos[1]; it.z = pos[2];
      const cs = it.children;
      if (!cs.length) return;
      let u; let v;
      if (it.kind === 'root') { u = [1, 0, 0]; v = [0, 0, 1]; } else {
        const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        u = norm(cross(axis, helper));
        v = cross(axis, u);
      }
      cs.forEach((c, i) => {
        const d = it.dirs[i];
        const dir = norm([
          u[0] * d[0] + v[0] * d[1] + axis[0] * d[2],
          u[1] * d[0] + v[1] * d[1] + axis[1] * d[2],
          u[2] * d[0] + v[2] * d[1] + axis[2] * d[2],
        ]);
        place(c, [pos[0] + dir[0] * it.ring, pos[1] + dir[1] * it.ring, pos[2] + dir[2] * it.ring], dir);
      });
    };
    place(tree, [0, 0, 0], [0, 1, 0]);
    return flatten(tree);
  }
  // Radius of the sphere around the origin that holds every orb, glow included.
  function cloudRadius(items) {
    let R = 0;
    for (const it of items) R = Math.max(R, Math.hypot(it.x, it.y, it.z) + it.r * 2.5);
    return R || 1;
  }

  // ---------- camera ----------
  // The camera orbits the origin at `dist`, yawed around Y and pitched around X, and
  // looks at it through a pinhole of focal length `focal` (in screen px).
  function project(p, cam, cx, cy) {
    const cy1 = Math.cos(cam.yaw); const sy1 = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch); const sp = Math.sin(cam.pitch);
    const x1 = p.x * cy1 + p.z * sy1;
    const z1 = -p.x * sy1 + p.z * cy1;
    const y2 = p.y * cp - z1 * sp;
    const z2 = p.y * sp + z1 * cp;
    const depth = cam.dist - z2;
    const s = cam.focal / Math.max(1, depth);
    return { x: cx + x1 * s, y: cy - y2 * s, s, depth };
  }
  // The distance at which a sphere of radius R fills the shorter side of a w x h frame.
  function fitDistance(R, focal, w, h) {
    const half = Math.max(1, Math.min(w, h) / 2);
    return Math.sqrt(R * R + (focal * R / half) ** 2);
  }
  // The distance at which every point (plus its margin, in world units) lands inside a
  // w x h frame at this pitch, checked around the whole turn so the slow orbit stays in frame.
  function fitDistanceFor(points, cam, w, h) {
    const cp = Math.cos(cam.pitch); const sp = Math.sin(cam.pitch);
    const hw = Math.max(1, w / 2) / 1.015; const hh = Math.max(1, h / 2) / 1.015;
    let d = 1;
    for (let k = 0; k < 24; k++) {
      const yaw = cam.yaw + (k * Math.PI) / 12;
      const cy1 = Math.cos(yaw); const sy1 = Math.sin(yaw);
      for (const p of points) {
        const x1 = p.x * cy1 + p.z * sy1;
        const z1 = -p.x * sy1 + p.z * cy1;
        const y2 = p.y * cp - z1 * sp;
        const z2 = p.y * sp + z1 * cp;
        const m = p.m || 0;
        d = Math.max(d, z2 + ((Math.abs(x1) + m) * cam.focal) / hw, z2 + ((Math.abs(y2) + m) * cam.focal) / hh);
      }
    }
    return d;
  }
  function stars(count, radius, seed = 7) {
    const out = [];
    let s = seed;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    for (let i = 0; i < count; i++) {
      const y = rnd() * 2 - 1; const t = rnd() * Math.PI * 2; const rr = Math.sqrt(1 - y * y);
      const d = radius * (0.7 + rnd() * 0.6);
      out.push({ x: rr * Math.cos(t) * d, y: y * d, z: rr * Math.sin(t) * d, a: 0.12 + rnd() * 0.3, r: rnd() < 0.15 ? 1.6 : 1 });
    }
    return out;
  }

  // ---------- labels ----------
  // Greedy: the most important label takes the first of its candidate spots that is
  // free; anything that would overlap a placed label tries its next spot, then hides.
  function placeLabels(items) {
    const order = items.map((r, i) => i).sort((a, b) => items[b].p - items[a].p || a - b);
    const kept = [];
    const chosen = new Array(items.length).fill(-1);
    const hits = (r) => kept.some((k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y);
    for (const i of order) {
      const cands = items[i].cands || [items[i]];
      for (let c = 0; c < cands.length; c++) {
        if (hits(cands[c])) continue;
        kept.push(cands[c]);
        chosen[i] = c;
        break;
      }
    }
    return chosen;
  }

  return { index, visibleTree, flatten, doneList, scopeCounts, titlePath, layout, cloudRadius, orbRadius, project, fitDistance, fitDistanceFor, stars, placeLabels, closed };
});
