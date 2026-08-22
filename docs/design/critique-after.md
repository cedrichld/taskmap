# Critique after the design pass (2026-08-22)

Method: dual-agent (A: design review, B: detector). Target: `ui/index.html` after the
bubble redesign. Same rubric as [critique-before.md](critique-before.md).

## Design health score: 27/40 (was 23/40)

| # | Heuristic | Before | After | Key issue now |
|---|---|---|---|---|
| 1 | Visibility of system status | 3 | 3 | live dot, "updated … ago", Now chip with elapsed time, Sent flash |
| 2 | Match system / real world | 2 | 3 | "leaves", node ids and `taskmap inbox` still appear in the panel |
| 3 | User control and freedom | 3 | 2 | no undo for a sent message |
| 4 | Consistency and standards | 3 | 3 | graph hides the status word, outline shows it (by design) |
| 5 | Error prevention | 2 | 3 | (fixed after the run: Mark done guarded on open leaves, in-flight disable, Not needed action) |
| 6 | Recognition rather than recall | 2 | 3 | fold-by-pill and `f` are taught only in the empty-panel placeholder |
| 7 | Flexibility and efficiency | 2 | 2 | no key to jump to Now or the next blocked node |
| 8 | Aesthetic and minimalist design | 3 | 3 | header row 2 is dense at 1440 |
| 9 | Error recovery | 2 | 3 | plain-language errors with a next step |
| 10 | Help and documentation | 1 | 2 | a few tooltips, one placeholder hint |

Detector (`detect.mjs`, full parser, three runs incl. `--no-config`): 0 findings, not degraded.

Design-specificity verdict: "authored, not interchangeable" — the bubble grammar, the
tapered ribbons and spine, the warm Waiting-on-you strip and the Now chip are the
product's own; the right column is still the generic details-over-log shape.

## Fixed after the run

- P1 panel content hidden under the sticky composer at 900 px → composer is one line
  until focused or holding text; activity pane 36% → 28%; its collapsed state persists.
- P1 "waiting on user:" prefix ate the first line of the question on cards and in the
  strip → prefix stripped there (full reason kept in the panel); reason text 12 px.
- P2 "N unread" read as the user's inbox → "N for Claude", muted; timeline tag
  "not read by Claude yet".
- P2 fit cap wasted a 2560 monitor → cap 1.25×, 1.45× on windows ≥ 1900 px.
- P2 status actions without guards → buttons disabled in flight, Mark done disabled
  while leaves underneath are open, "Not needed" (skip with reason) added, Send
  disabled while the box is empty.
- Minor: Now chip reads "for 15h"; UI status events use the right verb in the feed;
  outline cards widen to 960 px.

## Deliberately not done

- Inline answering from the strip (the strip is a pointer; one composer keeps one
  draft per node and one place to look for errors).
- Replacing the four status verbs with "Reply / Add / Not this": Claude owns status,
  but overriding it from the dashboard is a documented feature of the API.
- Keyboard traversal of the tree (arrow keys, jump to Now): out of the brief; `f`,
  Esc, Enter/Space on a focused bubble and Ctrl+Enter stay.
- A custom tooltip for the blocked reason: the native one plus the strip and the
  panel already carry the full text three times.
- Light mode; icon fonts; web fonts; gradients; glow. See DESIGN.md §8.
