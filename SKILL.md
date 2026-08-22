---
name: taskmap
description: Live task map for multi-step work — a tree of plain-language nodes that the user watches at http://localhost:4242 and comments on, and that survives compaction and restarts. Use at the start of ANY task that will take more than a few minutes or touch several files — new projects, features, websites, games, refactors, migrations, long debugging, anything with more than three steps — before writing code. Use it even if the user never mentions a plan, a map, or taskmap; the user expects it by default.
when_to_use: Requests that build, make, create, implement, set up, scaffold, add, extend, refactor, migrate, port, or fix something whose cause is unknown; writing a site, app, game, tool, or library; any ask that needs a plan. Also when a session starts with a "[taskmap] Map found" line, when a "[taskmap]" notification arrives mid-session, or when the user says taskmap, map, plan, dashboard, roadmap, or "track this". Skip only for questions, one-line answers, and single-file edits that take a minute.
allowed-tools: Bash(taskmap *)
---

# taskmap

The map is the plan. It lives in `<project>/.taskmap/map.json`, the user watches it
at http://localhost:4242, and it outlives compaction and restarts. You talk to it only
through the `taskmap` CLI, which is already on PATH. Its output is terse on purpose:
read it, do not re-derive it.

## 1. First action

Run `taskmap status`.

- A map exists: `taskmap tree --open`, then `taskmap inbox`, then continue from
  `taskmap next`. Do not re-plan what is already on the map.
- No map (`error: no taskmap here`): `taskmap init "<name>" --goal "<one sentence>"`,
  then tell the user the dashboard URL once, in one line. Not again unless asked.

## 2. Plan before code

Put the plan on the map before writing any code, in one call:

1. 3 to 8 milestones under `n0` that a non-expert would recognize as the shape of the project.
2. One level of concrete chunks under the first milestone only.

Use a single `add --batch`. Keys are your own labels; `parent` and `links` may name
earlier keys or existing ids. Every item carries `title`, `what`, `why`, `done_when`:

```bash
taskmap add --batch <<'EOF'
[
 {"key":"m1","parent":"n0","title":"Build the maze","what":"...","why":"...","done_when":"..."},
 {"key":"m2","parent":"n0","title":"Make the ghosts chase the player","what":"...","why":"...","done_when":"..."},
 {"key":"c1","parent":"m1","title":"Decide the grid format","what":"...","why":"...","done_when":"..."},
 {"key":"c2","parent":"m1","title":"Build the maze walls","links":["c1"],"what":"...","why":"...","done_when":"..."}
]
EOF
```

Then paste `taskmap tree` into your reply so the plan is visible in the terminal too.
Do not plan level 3, or level 2 of later milestones, until you reach them. Depth below
the root is capped at 3 (milestone, chunk, step).

## 3. Naming

Write every node for someone who does not know the stack.

- `title`: 2 to 6 words, verb first, plain English, no library or framework names.
- `what`: 1 to 3 sentences describing what exists when the node is done. Frameworks may
  appear here, each explained in a clause: "three.js, the library that draws the 3D scene".
- `why`: 1 to 2 sentences on how the node serves the goal and what depends on it.
- `done_when`: one observable check a human could perform.

| Bad title                                   | Good title                              |
| ------------------------------------------- | --------------------------------------- |
| Implement BFS pursuit in GhostAI.ts         | Make the ghosts chase the player        |
| Set up Vite + React + TS scaffolding        | Set up the project                      |
| Migrate Sequelize models to Prisma schema   | Replace the database layer              |

## 4. Execution loop

```bash
taskmap next                 # the first actionable leaf, with its what and done_when
taskmap start <id>           # too big for one sitting (~20 min)? decompose it first with add --batch, then next again
# ... do the work ...
# verify done_when honestly: run it, open it, read it
taskmap done <id> --note "<what was decided; where the code lives>"
taskmap inbox                # pick up feedback before choosing the next node
```

Exactly one leaf in progress per agent at any time. `start` a milestone or chunk when
you begin its first leaf; `done` it only after verifying its own `done_when`.

## 5. Everything you do is on the map

- Work you discover becomes a node before you do it:
  `taskmap add "<title>" --parent <id> --what ".." --why ".." --done-when ".."`.
- A dead end becomes `taskmap skip <id> --reason "<why>"`.
- Waiting on the user becomes `taskmap block <id> --reason "waiting on user: <question>"`,
  then ask the question in chat.
- A change of shape is `taskmap edit <id> --parent|--title|--what|--why|--done-when|--link|--unlink ..`.
- Never silently change scope. If the map says X and you are doing Y, fix the map first.

## 6. User feedback

A notification such as `[taskmap] feedback on n12 "Build the maze walls": walls should be
half as tall` can arrive at any moment, and `taskmap inbox` lists everything unread.

1. Acknowledge on the node: `taskmap note <id> "User: <gist>. Doing: <change>."`
2. Adjust the plan: `reopen`, `edit`, `add`, or `skip` as needed.
3. Tell the user in one line, then keep going.

User-added nodes (`*` in the tree) arrive with empty `what` and `done_when`. Decompose
them when you reach them. If the intent is unclear, `block` them with the question
rather than guess.

## 7. Notes

`taskmap note <id> "<one line>"` records decisions and locations:
"Grid lives in src/maze.txt; 1 = wall." Status is the progress report; notes are not
narration.

## 8. Before ending a turn

1. `taskmap check`. No leaf may stay in progress: finish it, `block` it with the reason,
   or `reopen` it with a note on where you stopped.
2. `taskmap note n0 "State: <where things are>. Next: <the suggested next step>."` so the
   next session, or you after compaction, can resume from one line.

## 9. Subagents

The lead owns the tree shape. Hand a subagent node ids, not the whole map; it runs
`taskmap start`, `note` and `done` on those ids only and never adds milestones or
siblings. The lead verifies the work and marks the parent done. Subagents in git
worktrees still find the map: taskmap looks in the main worktree.

## 10. Token discipline

- One `add --batch` beats ten `add` calls.
- `tree --open` beats `tree --all`; `show <id>` only when you need a node's full text.
- Do not re-read the map after every command; the command output already says what changed.
- Reasons, notes and titles are one line each. Never paste `map.json` or `log.jsonl`.

Other commands: `taskmap status` (one line), `taskmap open` (browser), `taskmap help`.
