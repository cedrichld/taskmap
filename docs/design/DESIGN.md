# taskmap dashboard — design language

One screen, left open all day on a second monitor, that shows a plan as a tree of
bubbles and lets the owner talk back. Dark only, because the use scene is a second
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

The canvas carries a **dot grid**: 1 px dots on a 24 px lattice, `--hairline` coloured,
drawn behind the tree and tracking pan and zoom so it reads as ground rather than
wallpaper. It fades in over 0.5–0.85× and out over 1.6–2.4× (`opacity` only,
compositor-cheap), so a zoomed-out 40-node map is not sitting on moiré and a
zoomed-in detail view is clean.

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

## 3. Nodes

Bubbles, tightened. Shape and size encode the level; a thin ring plus a shaped mark
encode the status; a trailing pill carries the count. Nothing else is drawn.

| Level | Size | Radius | Surface | Title |
| --- | --- | --- | --- | --- |
| Root | 208 × 54 | 16 | **filled** `--surface-2` | 15 px / 600 |
| Parent | 188 × 46 | 14 | 2.5 % wash | 13 px / 600 |
| Leaf | 176 × 34 (grows to 2 lines) | 18 (pill) | 2.5 % wash | 12 px / 450 |

The root is the only node with a real surface; everything else is a 2.5 % white wash
that separates it from the dot grid without becoming a card. Leaves are pills — the
smallest, lightest thing on the canvas, because there are the most of them.

- **Status** is a 1 px ring in the status colour plus an 8 px **mark** in the leading
  gutter. The mark carries shape as well as hue, because hue alone fails colour-blind
  readers (WCAG 1.4.1) and fails everyone at 0.4× zoom:

  | Status | Ring | Mark |
  | --- | --- | --- |
  | pending | hairline | hollow, `--dim` edge |
  | in progress | accent (leaf) / accent at 30 % (its ancestors) | filled accent |
  | done | `--ok` at 50 % | filled, with a check cut out of it |
  | blocked | `--warn` | filled, with a bar cut out of it, and the node grows its question |
  | skipped | hairline | struck through, title struck, node at 62 % |

- **In progress**: only the leaf being worked on carries full accent and a breathing
  2 px halo. Its ancestors get the same ring at 30 % and no halo, so a still frame
  shows one live node rather than a lit-up lineage.
- **Blocked** nodes grow two lines: the question, with its "waiting on user:" prefix
  stripped, under the title. The full reason is the tooltip, the panel and the strip.
- **Skipped** keeps a hairline ring, strikes the mark and the title, fades to 62 %.
- **User-added** nodes take a dashed hairline ring 3 px outside the border — different
  in kind from the status ring, so the two never compete.
- **Unread feedback** is an 8 px accent dot at the top-right corner, outside the flow.
- **Hover** lifts 2 px on a spring (`cubic-bezier(.2,.85,.35,1.08)`, 180 ms) and turns on
  the only layered shadow in the design: `0 1px 2px rgba(0,0,0,.5), 0 10px 26px
  rgba(0,0,0,.4)`. Nothing else lifts.
- **Selected** is a 1 px ring in `--text` plus the raised surface, so selection never
  competes with the accent-coloured in-progress ring.

## 4. Layout

- Compact tree, laid out by `layout(maxCols)` in `ui/app.js`. Children that have
  visible children sit side by side, 14 px apart; children without visible children
  stack under their parent, indented 14 px, each column joined to the parent by its
  own spine.
- **The stack wraps.** A stack of five or more leaves breaks into up to four columns
  of four. `bestLayout()` lays the whole tree out at one, two, three and four columns
  and keeps whichever fills the canvas best, requiring 3 % more scale before it will
  spend the extra width. A tall thin ribbon of nodes in an empty canvas is the worst
  thing this view can do, and this is what stops it.
- Row height per depth is the tallest side-by-side node at that depth plus a 42 px gap;
  stacked leaves are 10 px apart.
- Fit and centre in the **free** area — the window minus the header, the strip and
  the panel — on load and after every structural change, capped at 1.25× (1.7×
  above 1900 px, where the screen is read from further away). `bounds()` includes what is drawn, not the boxes: halos sit 8 px
  outside, dashed rings 5, count pills 9 below, spines 14 to the left. Panning or
  zooming stops auto-fit until Fit or `f`.
- Closed subtrees start collapsed, as in `taskmap tree --open`.
- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32. Header rows 44 px. Panel padding 20.

## 5. Links

- Parent → child: a cubic curve drawn as a tapered ribbon, 5 px at the parent, 1.5 px
  at the child, `--link` at 65 %, so it reads lighter toward the child.
- Parent → stacked leaves: a 1.5 px spine down the left of the column, turning with a
  soft elbow into each leaf's left edge.
- Cross-links (`depends on`): 1.2 px dashed accent with an arrowhead, hidden until the
  source or target is hovered or selected.

## 6. Colour

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

## 7. Motion

Five things move, all under 300 ms except the breathing.

1. **Breathing halo** on the in-progress leaf: opacity 0.22 → 0.6 → 0.22 over 3.2 s.
2. **Status morph**: `border-color` and `box-shadow` over 240 ms.
3. **New node**: enters at its parent's position at 0.6× and 0 opacity, arrives over
   280 ms ease-out.
4. **Layout change**: positions interpolate over 280 ms; links follow.
5. **Hover lift**: 2 px over 180 ms on `--spring`
   (`cubic-bezier(.2,.85,.35,1.08)`). The overshoot is small and deliberate; a
   bounce detector will still flag any `y₂ > 1`, and that finding is accepted.

Sheets slide 240 ms; the progress bar eases 300 ms on `transform`. Nothing animates a
layout property. `prefers-reduced-motion: reduce` removes the halo animation and zeroes
every duration.

## 8. The panel when nothing is selected

The right rail used to be an instruction over 500 px of black, including at the exact
moment something was blocked and waiting for an answer. It now answers whatever the
screen is currently asking:

1. Something blocked → the question itself, with **Answer this**.
2. Otherwise, a leaf in progress → what Claude is on and for how long.
3. Otherwise, everything done → *All done*, in `--ok`, because that is the peak of
   the whole product and it used to be the dimmest text on the page.
4. Otherwise → a plain line about picking a bubble.

Under that, always: the **legend** (the five status marks, plus user-added and unread)
and the three **shortcuts**. Nothing else in the product teaches a nine-treatment ring
vocabulary, and a tooltip cannot be read from two metres away.

**Undo.** A status write from here lands in a running agent's plan, so every one of
them leaves a toast naming what changed with an Undo that writes the previous status
back. It stays for 12 seconds.

## 9. Overview

Bento grid: cards on a 320 px-minimum auto-fill, and a project with a live session
spans two columns above 900 px — the thing you care about is the big tile. Each card
is a raised surface with the same hairline, the same three type sizes, the same status
vocabulary and the same tabular numerals. The live dot is the only animated element on
the page.

Sorted **live first, then by what is waiting on you** (blocked + unread), then by last
change. The page's question is "who needs me?", not only "who is running?". A project
with work in progress and no session heartbeat says *no session running* in `--warn`,
because a stalled run and a healthy one otherwise look identical.

## 10. Icons

A dozen marks, authored inline as 16 × 16 SVG on a 1.5 px stroke with round caps and
joins: chevron, arrow-left, close, plus, reply, dot. No icon library, no Unicode glyph
standing in for an icon. Anything that is not in the set does not get an icon.

## 11. Chrome the browser draws

Themed from the palette, not left to defaults: text selection (`--accent` at 28 %),
the caret, scrollbars (`--hairline-strong` thumb on transparent), focus rings (2 px
`--accent` at 2 px offset, on every focusable element), and tabular numerals in data.

## 12. Not done on purpose

- No light mode. The use scene is a second monitor next to a terminal.
- No web fonts: the page stays self-contained and loads in one request. Operate mode
  permits a system sans; this one is tuned rather than chosen by default.
- No shadows on resting elements. Depth is layering.
