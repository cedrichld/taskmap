# taskmap dashboard — design language

One screen, left open all day on a second monitor, that shows a plan as a tree of
bubbles and lets the owner talk back. Dark only. Readable at arm's length for a
40-node map without panning. Everything moves for a reason or not at all.

## 1. Node language

Nodes are bubbles. Shape and size encode the level; the ring encodes the status;
a small trailing pill carries a count; nothing else is drawn on a node.

| Level     | Width × min height | Radius        | Title                         | Extra                                   |
| --------- | ------------------ | ------------- | ----------------------------- | --------------------------------------- |
| Root      | 200 × 58           | 20            | 15 px / 600, 2 lines max      | count pill on the lower-right edge      |
| Parent    | 176 × 50           | 16            | 13.5 px / 600, 2 lines max    | count pill `2/5`; folded → `3/5 ▸`      |
| Leaf      | 156 × 48           | 24 (half)     | 13 px / 500, 2 lines max      | —                                       |

The count pill hangs on the bubble's lower-right edge (half outside) so the title
keeps the full width; clicking it folds or unfolds the branch. Its border takes the
status color.

- **Blocked nodes grow** by two lines: the question (the reason with its
  "waiting on user:" prefix stripped) sits under the title, wraps to two lines,
  then ellipsis. The full reason is the card's tooltip and is always
  complete in the side panel and in the Waiting-on-you strip. Layout rows take the
  tallest node in the row, so nothing overlaps.
- **Surface**: `--card` with a 1 px inset top highlight (`rgba(255,255,255,.04)`)
  and one shadow (`0 4px 14px rgba(0,0,0,.35)`). No gradients anywhere.
- **Status ring** (the only status signal on the node): a 1.5 px border in the
  status color. `in_progress` adds a halo (a 2 px ring 5 px outside the border at
  low alpha) that breathes. `skipped` drops the ring, strikes the title and fades
  the bubble to 55%. `done` keeps a calm green ring and a muted title.
- **User-added nodes** get a second, dashed ring 3 px outside the border in the
  text color at 35% — different in kind from the status ring so the two never
  compete. The `*` is gone.
- **Unread feedback**: a 7 px accent dot at the card's top-right corner, outside
  the text flow.
- **Selected**: a 2 px ring in the text color and the hover surface, so selection
  never competes with the accent-colored in-progress ring.
- **Hover**: surface lightens one step (`--card-hover`); no movement.

## 2. Layout

- Compact tree, laid out by `layout()` in `ui/app.js` (no `d3.tree`: a block
  layout is narrower and fully predictable at three levels): children that have
  visible children sit side by side, 14 px apart; children without visible
  children (leaves and folded parents) **stack vertically** in one column on the
  left of their parent's block, indented 14 px, joined by a spine. A column is
  never wider than one bubble, so a 40-node map is seven columns wide and fits a
  1440-wide window at 0.8×.
- Row height per depth is the tallest side-by-side node at that depth plus a
  42 px gap; stacked leaves are 10 px apart and may run below the next row, since
  nothing else shares their column.
- The drawing is **fit and centered** in the viewport (both axes, 24 px padding)
  on load and after every structural change (node added or removed, collapse
  toggled, project switched). Fit is capped at 1.25× (1.45× on windows 1900 px and wider) so small maps do not balloon.
  Once the user pans or zooms, auto-fit stops until they press Fit or `f`.
- Closed subtrees (every leaf done or skipped) start collapsed on the first visit,
  as in `taskmap tree --open`.

## 3. Links

- Parent → child: an organic cubic curve drawn as a **tapered ribbon**, 6 px at
  the parent, 2 px at the child, filled with `--link` at 70%, so it reads lighter
  toward the child.
- Parent → stacked leaves: a 2 px spine that leaves the parent near its left
  corner, runs down the left of the column and turns with a soft elbow into the
  left edge of each leaf (1.5 px, round caps).
- Cross-links (`depends on`): 1.2 px dashed accent with an arrowhead, hidden until
  the source or target is hovered or selected.

## 4. Spacing and type

- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32. Header rows are 44 px. Panel padding 20.
- Type scale: 11 (labels, meta, reasons on bubbles) · 12 (mono ids and times) ·
  13 (body, leaf titles) · 13.5 (parent titles) · 15 (root) · 17 (panel node title).
- Sans for everything; **mono only for ids and timestamps**. Labels are
  sentence case, 11 px, `--muted`, no letter-spacing tricks except the uppercase
  section labels in the panel (0.06em).
- Line height 1.45 for body, 1.25 for node titles.

## 5. Color tokens

| Token            | Value                     | Use                                      |
| ---------------- | ------------------------- | ---------------------------------------- |
| `--bg`           | `#0e1014`                 | page                                     |
| `--surface`      | `#13161c`                 | header, side panel                       |
| `--surface-2`    | `#181c23`                 | panel sections, composer                 |
| `--card`         | `#1c2129`                 | bubbles                                  |
| `--card-hover`   | `#232933`                 | bubble hover                             |
| `--border`       | `#2a303b`                 | hairlines                                |
| `--border-strong`| `#3a4250`                 | controls, pending ring                   |
| `--text`         | `#dde1e7`                 | primary text                             |
| `--muted`        | `#8f97a3`                 | secondary text                           |
| `--dim`          | `#5f6773`                 | placeholders, skipped                    |
| `--accent`       | `#5b8def`                 | the one interactive color: buttons, links, selection, in-progress, unread |
| `--ok`           | `#5aa87c`                 | done                                     |
| `--warn`         | `#e08a5a`                 | blocked (warm, not alarm red)            |
| `--danger`       | `#e0625a`                 | errors only                              |
| `--link`         | `#465060`                 | tree links                               |

Status → ring: pending `--border-strong`, in progress `--accent`, done `--ok`,
blocked `--warn`, skipped none. Contrast: text on card 11.6:1, muted on card 5.3:1,
accent on bg 5.6:1.

## 6. Motion

Only four things move:

1. **Breathing halo** on the in-progress leaf (the node being worked on): opacity
   0.3 → 0.75 → 0.3 over 3.2 s, ease-in-out, on a pseudo-element (compositor only).
   In-progress parents keep a still halo at 0.3 so one thing breathes at a time.
2. **Ring color morph**: `border-color` and `box-shadow` transition 300 ms when a
   node changes status.
3. **New node**: enters at its parent's position at scale 0.6 and opacity 0, then
   moves to its own position at scale 1 over 320 ms ease-out.
4. **Layout change**: positions interpolate over 320 ms; links follow.

Hover and selection do not animate beyond a 120 ms surface fade. The progress
bar eases 300 ms. `prefers-reduced-motion: reduce` removes the halo animation and
zeroes every duration.

## 7. Side panel and feed

- Panel: node header (status chip, count, id), title at 17 px, then a
  "Waiting on you" box when blocked, then
  what / why / done when as labeled paragraphs, then notes and feedback as a
  timeline with soft unread rows. The footer (parent, links, dates) is mono.
- Composer: a message box pinned to the bottom of the panel — one line tall until
  focused or holding text, a rounded `--surface-2` field with the Send button inside it
  (disabled while empty) (it reads "Sent" for 1.5 s
  after a send); the helper line says when Claude reads it. Replying to a blocked
  node focuses the box with the placeholder "Answer the question above…".
- Actions: five quiet pills (Add subtask, Reopen, Mark blocked, Not needed, Mark done).
  Mark done is disabled while leaves underneath are open; every action is disabled
  while a request is in flight.
- Activity feed: one row per event — time (mono), actor ("Claude" or "You"),
  a verb and the node title, detail on a second line with status words instead of
  enums. Rows are clickable and select the node.
- Header: a "Now" chip names the leaf Claude is working on and how long ago it
  started; clicking it selects the node.
- **Waiting on you** strip: sits under the header whenever any node is blocked;
  one line per blocked node with the question and a Reply button that selects the
  node and focuses the composer.

## 8. Not done on purpose

- No light mode (out of scope).
- No surface gradients or glows: depth comes from one shadow and the inset line.
- No icons library; the few glyphs are text (`▸`, `›`).
- No custom fonts: the system sans stack, so the page is self-contained and loads
  in one request.
