# Critique before the modern pass (2026-08-22)

Method: the `impeccable` command, two isolated sub-agents. **A** is a design review
that reads the source and the rendered pixels at 1440×900, 2560×1440 and 390×844 and
scores Nielsen's ten heuristics 0–4. **B** is mechanical: the bundled detector, the
browser detector injected into the live pages over CDP, and independent measurements
(contrast, tap targets, overflow, clipped text, focus order, token counts, motion).
Neither saw the other's output. Target: `ui/project.html` and `ui/index.html` after
revision 2 and the always-open / phone work of revision 3.

The revision 2 pass ([critique-r2-before.md](critique-r2-before.md),
[critique-r2-after.md](critique-r2-after.md)) scored 23/40 and 27/40 under a
different, more generous grader. **Those numbers are not comparable to these.** This
file and [critique-after.md](critique-after.md) are the comparable pair: same method,
same rubric, same day, one build apart.

## Design health score: 18/40

| # | Heuristic | Score | Reason |
|---|---|---|---|
| 1 | Visibility of system status | 3 | live dot, "updated 1m ago", Now chip, breathing halo, feed — strong; docked because *pending* has no perceivable ring and "in progress" smears across four ancestors |
| 2 | Match system / real world | 2 | node titles are excellent; `n38`, "read on the next `taskmap inbox`", "leaves" and the raw "waiting on user:" prefix are machine language |
| 3 | User control and freedom | 1 | no undo anywhere; Mark done and Reopen fire instantly into a running agent's plan |
| 4 | Consistency and standards | 2 | `.chip` defined twice and the overview rule clobbers the panel chip; accent means five different things; leaf radius 24 > parent radius 16, so "shape encodes level" reads backwards |
| 5 | Error prevention | 2 | Mark done is guarded and reasons are demanded, but destructive pills carry the same weight as safe ones |
| 6 | Recognition rather than recall | 1 | no legend for a nine-treatment ring vocabulary; fold-by-pill, `f` and drag-to-pan live only in a placeholder that vanishes on first selection |
| 7 | Flexibility and efficiency | 1 | no search, no filter, no jump-to-blocked, no keyboard tree navigation; one shortcut |
| 8 | Aesthetic and minimalist design | 2 | restrained per component, but the canvas wastes 84–87 % of itself, the header carries six counts, and a blocked question is printed three times on one screen |
| 9 | Recognise / diagnose / recover | 3 | best-in-class error copy; docked for no retry and no recovery from a mistaken status write |
| 10 | Help and documentation | 1 | two lines in a vanishing placeholder plus `title` tooltips; the README never reached the product |

**Design specificity:** the node language is the product's own — blocked nodes growing
to carry their question, the count pill straddling the bubble's edge as the fold
control, tapered ribbon links, the dashed ring for user-added nodes. Everything around
it is a stock dark-dev-dashboard shell. Verdict from A: *"nothing in the composition
knows this screen is watched, not used."*

## Mechanical evidence (B)

Bundled detector: exit 0 on the HTML — but **degraded**, its HTML parser modules are
not installed with the plugin, so that 0 is meaningless. With parsers restored in a
scratch copy: exit 0 on the HTML pair, exit 2 on `ui/` (one `bounce-easing` warning on
`--spring`). URL mode is unavailable (needs puppeteer). The browser detector *did* run,
injected over CDP: 24 findings on the project page at 1440, 39 at 390, 8 and 7 on the
overview.

Measured, at the start of the pass:

| Check | Finding |
|---|---|
| Text contrast | `.ov-idle` `#5f6773` on `#1c2129` = **2.83:1**; white on `#5b8def` buttons = **3.23:1**; skipped titles ≈ 2.3:1 |
| Non-text contrast | pending card border **1.37:1**, control borders **1.43:1**, `#now` 1.95:1 — all below the 3:1 of WCAG 1.4.11 |
| Tap targets | 9 under 44 px at 1440; at 390 the header overflowed (`clientHeight` 88 vs `scrollHeight` 179) and three elements were occluded at 75–100 % |
| Clipped text | 36 clipped elements at 1440, **none with a `title` fallback**; `.act .detail` hid ~5 lines |
| Focus | `#activity-list` fell back to the UA `outline: auto` |
| Canvas use | tree occupied 16 % of canvas width at 1440; ~87 % of the canvas empty at 2560 |
| Motion | no layout-property animation, nothing over 300 ms; one `bounce-easing` flag |

## What A asked for, in order

1. **The canvas does not compose.** `layout()` stacks every childless parent into one
   column regardless of viewport, so the drawing is always tall and thin and always
   height-constrained.
2. **Status is not readable at a glance** — invisible pending ring, four nested accent
   rings on one lineage, selection as a fourth ring, and hue as the only channel.
3. **The right rail is dead most of the time and empty at the highest-stakes moment** —
   an instruction over 500 px of black while a project sits blocked.
4. **Irreversible actions, no undo, inverted weight** — Send gets a confirmation, Mark
   done does not.
5. **The phone view is a media query, not a design.**

The answers are in [DESIGN.md](DESIGN.md) and the result is in
[critique-after.md](critique-after.md).
