# Critique after the modern pass (2026-08-22)

Same method, same rubric, same graders' brief as [critique-before.md](critique-before.md):
two isolated sub-agents, one reading source and rendered pixels at 1440×900, 2560×1440
and 390×844 and scoring Nielsen's ten heuristics 0–4, one running the detector, the
injected browser detector and independent measurements. The reviewer was told to score
independently and not to assume the redesign improved anything.

## Design health score: 24/40 (was 18/40)

| # | Heuristic | Before | After | What still costs it |
|---|---|---|---|---|
| 1 | Visibility of system status | 3 | 3 | "2 in progress" counts nodes while "9/29 leaves" counts leaves; the accent mark still fires on the whole ancestor chain |
| 2 | Match system / real world | 2 | 3 | "Add high-level task", `n25` on screen, "read on the next `taskmap inbox`" |
| 3 | User control and freedom | 1 | 3 | Undo toast on status writes; still no undo on a sent message, no way to hide done work in a 45-row outline |
| 4 | Consistency and standards | 2 | 2 | one action has three names (Reply / Answer this / Message Claude); outline rows staircase so the status column never aligns |
| 5 | Error prevention | 2 | 2 | five status writes, one click, no primary among them; the Undo toast is the only thing holding this up |
| 6 | Recognition rather than recall | 1 | 3 | the always-on legend; but the count pill has no affordance saying it folds |
| 7 | Flexibility and efficiency | 1 | 2 | `f` is still the only map shortcut; no search or filter on a 45-node outline |
| 8 | Aesthetic and minimalist design | 2 | 2 | the rail's middle is empty; one fact encoded four ways in an overview footer |
| 9 | Recognise / diagnose / recover | 3 | 2 | raw error text with no retry and no dismiss; "disconnected" without "retrying…" |
| 10 | Help and documentation | 1 | 2 | legend plus three shortcut lines; "when does Claude see my message?" is answered with a CLI command name |
| | **Total** | **18** | **24** | |

Heuristic 9 went **down**: the same error handling now sits beside a much better
blocked flow, and the reviewer marked it against that raised bar rather than against
revision 2.

## What the pass bought

- **The canvas composes.** Stacks wrap into up to four columns and `bestLayout()`
  keeps whichever of one to four fills the canvas best. The 2560 render went from
  ~87 % empty to width-bound at 1.5×, and the wide-screen cap moved 1.45 → 1.7 so a
  screen read from two metres gets bigger type rather than more void.
- **Status stopped being hue.** A ring plus a shaped mark — hollow, filled, check,
  bar, struck — so pending is visible (it was 1.6:1), and the vocabulary survives
  colour blindness and 0.4× zoom.
- **One live node, not a lit lineage.** Only the in-progress leaf carries full accent
  and the breathing halo.
- **The rail answers the screen's question.** Blocked → the question and *Answer this*;
  otherwise what Claude is on, or *All done* in `--ok`; then the legend and the
  shortcuts, permanently. Heuristics 3, 6 and 10 all moved on this one change.
- **Undo.** Every status write into a running agent's plan leaves a 12-second Undo.
- **Contrast.** Text failures went from three (2.83:1, 3.23:1, ~2.3:1) to none on the
  project page; control borders moved from 1.43:1 to `--control-line`, clearing the
  3:1 of WCAG 1.4.11; focus is one 2 px accent ring on every stop, ≥5.5:1 everywhere.
- **The phone stopped being a media query.** Two-row header, an opaque sticky
  composer, a swipeable action row, and nothing under 44 px.

## What the reviewer still wants, in order

1. **The map is illegible at the size it will normally be.** `bestLayout()` only
   varies columns for stacked *childless* leaves; a top-level row of six milestones is
   never rebroken, so a 29-leaf map fits at 0.73× with ~9 px titles while ~450 px of
   canvas height sits empty. Wrap the top-level row too, and add a readability floor:
   below ~0.9×, auto-collapse closed milestones or stop shrinking and let the map pan.
2. **The blocked question truncates everywhere except the panel.** `.w-q` is
   `nowrap`/ellipsis and `.card .reason` clamps at two lines; on a phone it collapses
   to "free wit…". This is the one node that should size to its own text.
3. **The rail wastes its middle and starves its feed.** `#activity` is pinned at 28 %
   (three rows) while the empty state leaves 250–450 px of black. Let the feed absorb
   the slack and make the legend collapsible, persisted like `taskmap:activity-collapsed`.
4. **The overview gives the most area to the project that needs the least.** The wide
   tile goes to `live`, so a 98 %-done project with nothing blocked outranks one with
   a blocked node and two unread messages. Span on `needs > 0` too, and fill the extra
   width with the question. Also move `no session running` out of `ul.ov-now`, where it
   reads as a fourth in-progress task.
5. **On a phone the chrome sits on top of live content in outline view.**
   `--chrome-top` is written only from `fitFrame()`, which the outline never calls, so
   it stays at the 108 px fallback and the first rows render under the Now chip and the
   strip. Set it from a `ResizeObserver`, and give the waiting strip `--chrome-strong` —
   DESIGN.md's own rule about content reading through a control strip is applied to the
   composer and not to the one strip carrying a question.

Accepted and not fixed: `bounce-easing` on `--spring`. The brief asked for a spring on
the hover lift; the overshoot is down from 1.25 to 1.08 and any `y₂ > 1` trips the rule.

## Design specificity

> "The node language is genuinely this product's own; the frame around it is a 2026
> Linear/Vercel dashboard template."

The product's own: the bubble tree with tapered ribbons and spines, the count pill that
folds its branch, a blocked node that grows its question onto the canvas, one breathing
halo, the Waiting-on-you strip *and* the panel default, and the status vocabulary in
plain language — *"Claude is on this one"*, *"Dropped, with a reason"*, *"You added it
from here"*. Interchangeable: the translucent header, the 340 px rail with an activity
feed, the segmented control, the bento card grid. The overview in particular still
contains nothing that says an agent is running this.

## Fixed after the run

The critique measured the build as it stood; these went in immediately after and are
in the committed screenshots.

- **The blocked question no longer truncates.** `.w-q` wraps to two lines (three on a
  phone, where the strip stacks title / question / Reply instead of squeezing them onto
  one 390 px row, which had reduced it to "buy ced…"). The strip is now opaque over its
  warn wash, like the composer.
- **`--chrome-top` comes from a `ResizeObserver`** on the header and the strip rather
  than from the fit path, so the outline no longer renders its first rows under the
  floating chrome on a phone.
- **The activity feed absorbs the rail's slack** (`flex: 1 1 auto; min-height: 200px`)
  instead of being pinned to three rows beside 450 px of black.
- **The wide overview tile goes to `live || needs-you`,** so a blocked project with
  unread messages outranks a finished one, and `no session running` moved out of the
  in-progress list where it read as a fourth task.
- **In-progress ancestors dim their mark too,** not only their ring, so a still frame
  shows one live node.
- **`.composer textarea:focus { outline: none }`** became `:focus:not(:focus-visible)`,
  so keyboard focus reaches the field itself.
- **`.card.user`'s transparent box-shadow** no longer overrides a selected node's ring.
- **The header's "in progress" count counts leaves,** matching the "8/15 leaves" beside it.
- **Tooltips on the three clipped elements that had none**: `.act .what`, the Now chip
  title, and a blocked node's reason.

## Accepted, not fixed

- **Non-text contrast on node borders** (1.15–2.34:1). The brief specifies hairlines at
  low alpha, and on a node the border is not the thing that identifies the status — the
  mark is, and it clears AA. Every actual control (`select`, `.seg`, buttons, inputs)
  uses `--control-line` and measures 3.16–3.23:1.
- **`flat-type-hierarchy` (1.4:1 between steps).** Operate mode asks for a 1.125–1.2
  ratio and the brief asks for three sizes; the detector's rule is written for brand
  surfaces.
- **`overused-font` (Inter at 79–88 %).** One family is the correct answer for product
  UI, and the page stays self-contained with no web font.
