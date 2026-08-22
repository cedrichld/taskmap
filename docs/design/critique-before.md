# Critique before the design pass (2026-08-22)

Method: dual-agent (A: design review, B: detector). Target: `ui/index.html` at commit 741ac80.

## Design health score: 23/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | live dot, progress bar good; the active node is not prominent |
| 2 | Match system / real world | 2 | raw enums leak (`pending → in_progress`), actors are CLI/UI, node ids everywhere |
| 3 | User control and freedom | 3 | Esc/Cancel everywhere, drafts kept; no expand-all |
| 4 | Consistency and standards | 3 | outline has chevrons, graph none; labels mapped in cards but not in activity |
| 5 | Error prevention | 2 | Mark done / Reopen fire instantly |
| 6 | Recognition rather than recall | 2 | double-click collapse, hover-only links, `f` key all invisible |
| 7 | Flexibility and efficiency | 2 | no jump-to-active, count chips not clickable |
| 8 | Aesthetic and minimalist design | 3 | quiet, one accent; six chips, 60% empty canvas, everything 11–13 px |
| 9 | Error recovery | 2 | raw server strings, no retry |
| 10 | Help and documentation | 1 | three tooltips, no legend |

Detector (`detect.mjs`, full parser): 0 findings.

## Priority issues carried into the pass

- P1 "Now" is invisible — the current in-progress leaf is a 3 px strip.
- P1 Initial viewport clips the root and the blocked node; Fit shrinks cards to confetti.
- P1 Blocked is the weakest-rendered state; reason truncated to ~20 characters.
- P2 Language leaks (enums, CLI/UI, ids instead of titles).
- P2 Hidden interactions (collapse by double-click only).
- Minor: `--dim` on bg is 2.9:1; selected + in-progress kills the pulse; root shows no progress.
