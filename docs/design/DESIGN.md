# taskmap dashboard — design language

One screen, left open all day on a second monitor, that shows a plan as a constellation
of orbs and lets the owner talk back. Dark only, because the use scene is a second
monitor beside a terminal at any hour. Readable at arm's length for a 40-node map
without panning. Everything moves for a reason or not at all.

The reference points are Linear, Vercel and Raycast in 2026: confident and quiet,
depth from layering rather than decoration, one accent, no gradients, no glow.

## 1. Surfaces

Three planes, and the order matters more than the colours.

| Plane | Token | What sits on it |
| --- | --- | --- |
| Canvas | `--bg` `#08090b` | the graph, the outline, the overview grid |
| Chrome | `--chrome` `rgba(18,20,24,.72)` + `backdrop-filter: blur(20px) saturate(140%)` | header, Waiting-on-you strip, side panel, bottom sheet |
| Raised | `--surface` `#14171b`, `--surface-2` `#181b20` | panel sections, composer, overview cards, the root node |

The chrome floats over the canvas: the canvas is the whole window and the header,
the Waiting-on-you strip and the side panel are translucent slabs above it, so the
dot grid and the tree pass under them. `fit()` measures those slabs at render time
and keeps the tree out from under them, which is why the map is centred in the free
area rather than in the window.

That is the whole depth system — no shadows on resting elements, one layered shadow
on hover, and hairlines at `rgba(255,255,255,.07)`, `.16` between surfaces. Anything
whose *edge is what identifies it* — a button, a select, an input, the view toggle,
a count pill — uses `--control-line` `rgba(255,255,255,.35)` instead, which clears
the 3:1 that WCAG 1.4.11 asks of a control boundary. A sticky footer over scrolling
content (the composer) is opaque `--chrome-strong`, never translucent: content
reading through a control strip is a bug, not depth.

The canvas carries a **starfield**: 220 one-pixel points on a shell two and a half
times the size of the cloud, `--text` at 6–18 %, drawn on the same camera as the orbs
so they turn with the map. That parallax is what makes the depth read; nothing else
about them is meant to be noticed. Under the root sits a **pool of light**, `--accent`
at 7 % fading to nothing over the cloud's radius, so the constellation floats in space
rather than sitting on flat black.

## 2. Type

One family, the system geometric sans: `Inter, Geist, "SF Pro Text", -apple-system,
"Segoe UI", Roboto, sans-serif`. Mono (`ui-monospace, SFMono-Regular, Menlo,
Consolas, monospace`) **only** for node ids, timestamps and file paths — the things
that are literally identifiers.

Three sizes carry the screen:

| Size | Weight | Tracking | Use |
| --- | --- | --- | --- |
| 11 px | 500 | `.02em` | labels, meta, counts, status words, count pills |
| 12–13 px | 450–600 | `-.006em` | body, node titles, feed rows |
| 15 px | 600 | `-.02em` | the root node, overview card names |

Two more exist and earn it: 18 px/600/`-.02em` for the panel's node title, and 20 px
for nothing else yet. Line height 1.45 for prose, 1.25 for titles.

`font-variant-numeric: tabular-nums` everywhere a number can change in place —
progress counts, percentages, elapsed times, unread badges — so nothing shifts as it
ticks. Uppercase section labels keep `.06em`; nothing else gets letter-spacing tricks.

## 3. Scope

The map is read in three scopes, chosen in the header and remembered per project:

| Scope | Shows | Why |
| --- | --- | --- |
| **Open** (default) | every node that is pending, in progress or blocked, and whatever contains one | a map with 250 finished tasks has to show the six that are not |
| **Done** | a flat list of finished and dropped tasks, newest first, grouped by day, each with its milestone › chunk path, finish time and last note | the archive, one place, chronological |
| **All** | the whole tree; finished leaves become small quiet orbs | structure and history together |

Open and All feed the Map, Graph, 3D and List views alike. A parent keeps its `done/total`
pill in every scope, so a milestone with hidden finished leaves still says how far it
is. The Done tab shows a count beside its name; so does Open.

## 4. Orbs

Every node is a sphere on the canvas; its title is HTML floating beside it, so text is
crisp at any zoom and can be measured for collision. Size encodes the level, colour
and glow encode the status, a trailing pill carries the count.

| Level | Radius (world px) | Body |
| --- | --- | --- |
| Root | 26 | `#4d5568`, lit from the top-left, a cool white glow at 16 % |
| Milestone | 16 | `#343a47`, same lighting, hairline rim |
| Chunk | 11 | as milestone |
| Step | 8 | as milestone |
| Leaf, open | 7.5 | see status |
| Leaf, finished | 4.5 | `--ok` at 78 %, no glow |

Every filled orb is a radial gradient offset to the top-left (55 % toward white at the
highlight, 45 % toward black at the rim), which is the whole 3D illusion; sprites are
rasterised once per colour and size and blitted.

- **Status on a leaf**: pending is a hollow ring in `--dim` on a dark disc; in progress
  is a filled `--accent` orb with a breathing glow (radius 3.6×, 50 % at the core,
  additive); blocked is `--warn` with a slower, quieter glow (38 %); done is a small
  `--ok` orb; skipped is `--dim` at 38 %.
- **Status on a hub** (root, milestone, chunk): the body never changes; a 14 % rim in
  the status colour says in progress (`--accent` at 70 %), blocked (`--warn`), done
  (`--ok` at 70 %) or skipped (`--dim`). Blocked and in-progress hubs get a faint glow
  (28 % and 20 %) so a lit branch is visible from across the room.
- **Depth**: everything behind the centre fades toward 50 % (fog on links, orbs and
  titles alike); nearer things are brighter and larger.
- **Selected** is a 1.5 px `--text` ring 4 px outside the orb and the raised label;
  **hover** is the same ring at 60 %. **User-added** orbs carry a dashed ring 6 px out
  and a dashed outline on the label. **Unread feedback** is an accent dot at the orb's
  top-right.
- **Titles** sit 7 px beside their orb on a 62 % black pill: 12 px/450 for leaves,
  13 px/600 for hubs, 15 px/600 for the root. The only thing after a title is a `+N`
  pill in an accent wash when N tasks are folded under it (the orb itself gets a
  dotted ring 4.5 px out). A blocked title is a warm pill; its question lives in the
  Waiting strip, not on the map. The in-progress leaf's title takes an accent-tinted
  pill; the selected one a `--text` inset ring.
- **Which titles show**: few, on purpose. Always: the root, open milestones, the task
  in progress, anything blocked, and whatever is hovered or selected. Finished
  milestones in Graph (where there is room) but not in 3D. Everything else only once
  the view is zoomed in on it (scale 1.1 for open chunks, 1.3 for open leaves, 1.6 to
  2.4 for finished work). Each title tries the side away from the root first, then
  right, left, below, above, and takes the first spot that covers neither a title
  already placed nor another orb; the order is the current task, selected, hovered,
  blocked, in-progress hubs, root, milestones, chunks, then leaves. A title that was
  visible last frame gets a small bonus so the set does not flicker as the map turns.
- **Ground**: in 3D a square grid on a disc just below the cloud, fading to a rim,
  with a dashed stem from the root to its centre, all in `--text` at up to 15 %. It
  turns and tilts with the orbs, so orientation is always readable. In Graph a faint
  ring per level around the root instead.

## 5. Layout: a dandelion

`layout()` in `ui/constellation.js`, pure and deterministic, so the same map always
draws the same shape.

- The root sits at the origin. Its milestones spread evenly over a **sphere** around it
  (a Fibonacci spiral, phase seeded from the node id).
- Every deeper level spreads over a **cap** of a sphere around its parent, 72° half-angle,
  facing away from the grandparent, so a branch grows outward like a seed head. An
  only child sits straight out along the axis.
- The sphere's radius is the smallest that keeps every pair of sibling subtrees apart:
  for each pair, `(R_i + R_j + 30) / (2 sin(θ/2))` with `θ` their angular separation,
  and never less than `parent.r + max(R) + 30`. A subtree's radius `R` is its sphere
  plus its largest child's `R`, so the guarantee holds all the way down.
- **Fit** (load, structural change, Fit, `f`): the camera distance is the smallest at
  which every orb, with a margin of 2.2 radii, lands inside the free area, checked at
  24 yaws around the turn so the slow orbit never carries the map out of frame. The
  free area is the window minus the header, the strip and the panel, less 36 % of its
  width (capped at 300 px) for the titles that hang beside the orbs. The closest a fit
  goes is 1.5×, so a map with two nodes does not fill the screen with one orb. Panning,
  zooming or orbiting by hand stops auto-fit until Fit or `f`.
- The camera looks slightly from above (pitch 0.38 rad) and starts turned 0.55 rad so
  the first milestone is not in front of the root.

## 6. Links

- Parent → child: a 1 px line in `--link` at 80 %, faded by depth, drawn centre to
  centre under the orbs.
- The path from the root to the task in progress is `--accent` at 60 %, 1.5 px, so a
  still frame says where Claude is even before the glow is noticed.
- The path to the hovered or selected orb is `--text` at 45 %, 1.5 px.
- Cross-links (`after`): 1.2 px dashed `--accent`, only for the orb under the pointer
  or selected.

## 7. Colour

| Token | Value | Contrast on `--bg` | Use |
| --- | --- | --- | --- |
| `--text` | `#e8eaef` | 16.5:1 | primary text |
| `--muted` | `#969ca8` | 7.2:1 | secondary text, labels |
| `--dim` | `#767d85` | 4.8:1 | placeholders, skipped |
| `--accent` | `#6e8bfa` | 6.4:1 | the one interactive colour: links, focus, selection, in progress, unread |
| `--ok` | `#5f9d7c` | 6.3:1 | done |
| `--warn` | `#c9945f` | 7.5:1 | blocked |
| `--danger` | `#d4736a` | 6.1:1 | errors only |
| `--link` | `#39404c` | — | tree links |

Every status colour is desaturated on purpose and used identically in the graph, the
outline, the overview and the feed: `pending` = hairline, `in progress` = accent,
`done` = ok, `blocked` = warn, `skipped` = none. A filled accent surface takes
near-black text (`#0a0c0f`, 6.4:1), never white (3.1:1). No gradients, no glow, no
neon anywhere.

## 8. Motion

The canvas has its own loop; it runs only while something moves and drops to 25 frames
a second when the only motion is breathing. Under `prefers-reduced-motion: reduce`
nothing below moves except the hover ring and the sheet.

1. **Orbit**: the camera turns at 0.05 rad/s, one full turn in about two minutes. It
   waits five seconds after the last touch, never turns under a pointer, and `o`
   pauses it. This is the one thing that is always moving, and it is the reason the
   map reads as 3D.
2. **Breathing**: the in-progress leaf's glow swells and fades over 3.2 s; a blocked
   leaf's over 4.6 s, quieter.
3. **New orb**: appears at its parent's position at zero size and eases into place;
   an orb leaving the scope shrinks and fades the same way (exponential ease, 170 ms
   time constant).
4. **Layout change**: positions ease the same way; links follow because they are drawn
   from the current positions.
5. **Fit**: distance and pitch ease with a 150 ms time constant; yaw is never reset.
6. **Titles**: opacity over 160 ms so a title that yields or returns fades instead of
   popping; position never animates.

Sheets slide 240 ms; the progress bar eases 300 ms on `transform`. Nothing animates a
layout property.

## 9. The panel when nothing is selected

The right rail used to be an instruction over 500 px of black, including at the exact
moment something was blocked and waiting for an answer. It now answers whatever the
screen is currently asking:

1. Something blocked → the question itself, with **Answer this**.
2. Otherwise, a leaf in progress → what Claude is on and for how long.
3. Otherwise, everything done → *All done*, in `--ok`, because that is the peak of
   the whole product and it used to be the dimmest text on the page.
4. Otherwise → a plain line about picking a bubble.

Under that, always: the **legend** (the five status marks on round swatches, plus
user-added and unread) and the four **shortcuts** (drag, click, `f`, `o`). Nothing else
in the product teaches the orb vocabulary, and a tooltip cannot be read from two metres
away.

**Undo.** A status write from here lands in a running agent's plan, so every one of
them leaves a toast naming what changed with an Undo that writes the previous status
back. It stays for 12 seconds.

## 10. Overview

Bento grid: cards on a 320 px-minimum auto-fill, and a project with a live session
spans two columns above 900 px — the thing you care about is the big tile. Each card
is a raised surface with the same hairline, the same three type sizes, the same status
vocabulary and the same tabular numerals. The live dot is the only animated element on
the page.

Sorted **live first, then by what is waiting on you** (blocked + unread), then by last
change. The page's question is "who needs me?", not only "who is running?". A project
with work in progress and no session heartbeat says *no session running* in `--warn`,
because a stalled run and a healthy one otherwise look identical.

## 11. Icons

A dozen marks, authored inline as 16 × 16 SVG on a 1.5 px stroke with round caps and
joins: chevron, arrow-left, close, plus, reply, dot. No icon library, no Unicode glyph
standing in for an icon. Anything that is not in the set does not get an icon.

## 12. Chrome the browser draws

Themed from the palette, not left to defaults: text selection (`--accent` at 28 %),
the caret, scrollbars (`--hairline-strong` thumb on transparent), focus rings (2 px
`--accent` at 2 px offset, on every focusable element), and tabular numerals in data.

## 13. Not done on purpose

- No light mode. The use scene is a second monitor next to a terminal.
- No web fonts: the page stays self-contained and loads in one request. Operate mode
  permits a system sans; this one is tuned rather than chosen by default.
- No shadows on resting elements. Depth is layering.
- No 3D library. The constellation is a 2D canvas with its own camera and pre-rendered
  orb sprites; the whole renderer is a few hundred lines and the repo stays
  dependency-free.
