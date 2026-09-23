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
  // `expanded` holds nodes the user opened by hand: their children all show, finished or
  // not. `collapsed` holds nodes folded by hand: none of their children show.
  function visibleTree(map, kids, { scope = 'open', collapsed = new Set(), expanded = new Set() } = {}) {
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
        collapsed: collapsed.has(id) && all.length > 0 && id !== map.root,
        hiddenDone: 0,
        hidden: 0,
        opened: expanded.has(id),
      };
      const open = it.opened;
      if (!it.collapsed) for (const k of all) if (open || keep.get(k.id)) it.children.push(build(k.id, depth + 1, it));
      it.hidden = all.length - it.children.length;
      it.hiddenDone = it.collapsed ? 0 : it.hidden;
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
  // What one click on a node does. A node with anything hidden under it opens; clicking
  // the selected, open node again folds it (the root only drops back to what the scope
  // shows); anything else is just selected.
  function clickAction(it, selectedId) {
    if (!it || it.kind === 'leaf') return 'select';
    if (it.hidden > 0) return 'reveal';
    if (it.id !== selectedId || !it.children.length) return 'select';
    if (it.kind === 'root') return it.opened ? 'fold' : 'select';
    return 'fold';
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
  // ---------- 2D layout: a radial tree ----------
  // The root in the middle and each level on its own ring. Every subtree gets a slice of
  // the circle in proportion to the leaves it holds, the first milestone at the top and
  // the rest clockwise. A ring is just wide enough that neighbours on it never touch.
  const FLAT_GAP = 26;
  function layoutFlat(tree) {
    const weigh = (it) => {
      it.r = orbRadius(it);
      it.w = it.children.length ? it.children.reduce((s, c) => s + weigh(c), 0) : 1;
      return it.w;
    };
    weigh(tree);
    // u runs clockwise from the top, as a fraction of the whole turn.
    const assign = (it, u0, u1) => {
      it.u = (u0 + u1) / 2;
      it.span = u1 - u0;
      let u = u0;
      for (const c of it.children) { const sp = ((u1 - u0) * c.w) / it.w; assign(c, u, u + sp); u += sp; }
    };
    const first = tree.children[0];
    const lead = first ? first.w / tree.w / 2 : 0;
    assign(tree, -lead, 1 - lead);
    const items = flatten(tree);
    const rings = [0];
    const maxR = [];
    for (const it of items) maxR[it.depth] = Math.max(maxR[it.depth] || 0, it.r);
    for (const it of items) {
      if (!it.depth) continue;
      const need = 2 * it.r + FLAT_GAP;
      const half = Math.min(Math.PI, it.span * Math.PI * 2) / 2;
      rings[it.depth] = Math.max(rings[it.depth] || 0, need / (2 * Math.max(1e-3, Math.sin(half))));
    }
    for (let d = 1; d < rings.length; d++) {
      rings[d] = Math.max(rings[d] || 0, rings[d - 1] + maxR[d - 1] + maxR[d] + (d === 1 ? 110 : 80));
    }
    for (const it of items) {
      const th = Math.PI / 2 - it.u * Math.PI * 2;
      it.x = it.depth ? rings[it.depth] * Math.cos(th) : 0;
      it.y = it.depth ? rings[it.depth] * Math.sin(th) : 0;
      it.z = 0;
    }
    tree.rings = rings;
    return items;
  }
  // Scale and centre that fit the flat drawing (points with margin m) in a w x h frame.
  function fitFlat(points, focal, w, h) {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const p of points) {
      const m = p.m || 0;
      x0 = Math.min(x0, p.x - m); x1 = Math.max(x1, p.x + m);
      y0 = Math.min(y0, p.y - m); y1 = Math.max(y1, p.y + m);
    }
    if (!Number.isFinite(x0)) return { dist: focal, x: 0, y: 0 };
    const k = Math.min(Math.max(1, w) / Math.max(1, x1 - x0), Math.max(1, h) / Math.max(1, y1 - y0));
    return { dist: focal / k, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }

  // ---------- the floor under the 3D map ----------
  // A square grid on a disc just below the cloud, fading toward its rim. It turns and
  // tilts with the orbs, so the eye always knows which way is down and how far it has
  // turned. Returned as world-space segments, each with a weight for its alpha.
  function floorGrid(R) {
    const y = -R * 1.05;
    const disc = R * 1.75;
    const raw = disc / 6;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw) || raw;
    const segs = [];
    const fade = (x, z) => Math.max(0, 1 - (Math.hypot(x, z) / disc) ** 2);
    for (let k = -Math.floor(disc / step); k * step <= disc; k++) {
      const c = k * step;
      const half = Math.sqrt(Math.max(0, disc * disc - c * c));
      const n = Math.max(2, Math.ceil((half * 2) / (step / 2)));
      for (let i = 0; i < n; i++) {
        const t0 = -half + (2 * half * i) / n; const t1 = -half + (2 * half * (i + 1)) / n;
        const tm = (t0 + t1) / 2;
        const axis = k === 0 ? 1.6 : 1;
        segs.push({ a: { x: c, y, z: t0 }, b: { x: c, y, z: t1 }, w: fade(c, tm) * axis });
        segs.push({ a: { x: t0, y, z: c }, b: { x: t1, y, z: c }, w: fade(tm, c) * axis });
      }
    }
    for (let i = 0; i < 96; i++) {
      const t0 = (i / 96) * Math.PI * 2; const t1 = ((i + 1) / 96) * Math.PI * 2;
      segs.push({ a: { x: disc * Math.cos(t0), y, z: disc * Math.sin(t0) }, b: { x: disc * Math.cos(t1), y, z: disc * Math.sin(t1) }, w: 0.6 });
    }
    return { y, disc, step, segs };
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
  // `obstacles` (the orbs) are avoided too, except by a `soft` label that finds no spot
  // clear of them: that one may cover an orb, never another label.
  function placeLabels(items, obstacles = []) {
    const order = items.map((r, i) => i).sort((a, b) => items[b].p - items[a].p || a - b);
    const kept = [];
    const chosen = new Array(items.length).fill(-1);
    const over = (r, k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y;
    const hits = (r) => kept.some((k) => over(r, k));
    const blocked = (r) => obstacles.some((k) => over(r, k));
    for (const i of order) {
      const cands = items[i].cands || [items[i]];
      let pick = cands.findIndex((r) => !hits(r) && !blocked(r));
      if (pick < 0 && items[i].soft) pick = cands.findIndex((r) => !hits(r));
      if (pick < 0) continue;
      kept.push(cands[pick]);
      chosen[i] = pick;
    }
    return chosen;
  }

  return { index, visibleTree, flatten, doneList, scopeCounts, titlePath, clickAction, layout, layoutFlat, fitFlat, floorGrid, cloudRadius, orbRadius, project, fitDistance, fitDistanceFor, stars, placeLabels, closed };
});
