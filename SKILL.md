---
name: taskmap
description: Live task map the user watches at http://localhost:4242 while Claude works — a tree of plain-language nodes that survives compaction and restarts. Use at the start of any task longer than a few minutes or touching several files, before writing code, even if the user never mentions it. Skip for questions and one-file edits.
when_to_use: Requests that build, implement, set up, add, refactor, migrate, port, or fix something whose cause is unknown; a "[taskmap] Map found" line at session start; a "[taskmap]" notification mid-session; the words taskmap, map, plan, dashboard, roadmap, or "track this".
allowed-tools: Bash(taskmap *)
---

# taskmap

The map is the plan and the user's window into what you are doing. It lives in
`<project>/.taskmap/map.json`; you touch it only through the `taskmap` CLI. Its output
is terse: read it, do not re-derive it.

**Cost rule: a taskmap command never gets a tool call of its own.** Chain it with the
real work in the same Bash call: `taskmap done n7 --next && npm test`,
`taskmap start n8 && cat src/x.js`. Every separate call re-reads the whole conversation.

## 1. Start

`taskmap status`. Map exists: `taskmap open --if-needed && taskmap tree --open && taskmap inbox`,
then continue from the first open leaf; never re-plan what is already there. No map:
`taskmap init "<name>" --goal "<one sentence>"`, mention the dashboard URL once.

## 2. Plan

Before code, one `add --batch`: 3 to 8 milestones under `n0`, plus one level of chunks
under the first milestone only. Deeper levels are added when reached; depth is capped at 3.

```bash
taskmap add --batch <<'JSON'
[
 {"key":"m1","parent":"n0","title":"Build the maze","done_when":"Maze is visible and walls block the player"},
 {"key":"m2","parent":"n0","title":"Make the ghosts chase the player"},
 {"key":"c1","parent":"m1","title":"Decide the grid format","what":"Text grid, 1 = wall"},
 {"key":"c2","parent":"m1","title":"Build the maze walls","links":["c1"]}
]
JSON
```

Fields, each one line, written for someone who does not know the stack:

- `title` (required): 2 to 6 words, verb first, no library names. "Make the ghosts
  chase the player", not "Implement BFS in GhostAI.ts".
- `done_when`: one observable check. On milestones, and on leaves whose finish is not
  obvious from the title.
- `what`: only when the title is not enough. Longer text is allowed only when you are
  using it to think a problem through (a design choice, a tricky bug); that is the one
  place detail pays for itself.
- `why`: omit.

Paste `taskmap tree` into the reply once so the plan is in the terminal too.

## 3. Work

```bash
taskmap start <id>                       # starts its milestones too; --note ".." if you already know something
# ... work; verify done_when honestly: run it, open it, read it ...
taskmap done <id> --note "<decision; where the code lives>" --next
                                         # closes finished parents, starts and prints the next leaf
```

One leaf in progress at a time. The user watches the in-progress leaf on the dashboard,
so `start` before the work, not after. Too big for ~20 minutes? `add --batch` under it first.

- Discovered work: `taskmap add "<title>" --parent <id>` before doing it.
- Dead end: `skip <id> --reason ".."`. Changed shape: `edit <id> --title|--what|--done-when|--parent|--link ..`.
- Unclear? Decide and record: `taskmap note <id> "assumed X because Y; say so if wrong"`.
  Do not stop to ask.
- `block <id> --reason "waiting on user: <question>"` only for costly or irreversible
  choices with no sane default: paid services, deleting data, public deploys, a product
  choice that changes most of the plan. Ask in one line in chat, `taskmap next`, keep working.

## 4. Feedback

A `[taskmap] feedback on n12 ...` line can arrive at any time; `taskmap inbox` lists what
is unread. Note the gist on the node, adjust the plan (`reopen`, `edit`, `add`, `skip`),
tell the user in one line, continue. Feedback on a blocked node is its answer: `reopen`,
`start`, finish it first. User-added nodes (`*`) have no `what`; fill in the most
plausible intent when you reach them.

## 5. Ending a turn

The Stop hook refuses to end while a leaf is in progress. Close it in the last real call:
`taskmap done <id> --note ".." --state "State: <where things are>. Next: <step>. Waiting on you: <question or nothing>"`,
or `block` / `reopen --note "<where you stopped>"` it. End the reply with one
`Waiting on you:` line.

## 6. Subagents

Hand a subagent node ids, not the map; it runs `start`, `note`, `done` on those ids only.
The lead verifies the work and owns the tree.

## 7. Keep it small

One `add --batch`, not ten `add`s. `tree --open`, not `--all`; `show <id>` rarely. Never
re-read the map after a command; never paste `map.json`. Notes and reasons are one line.
Other commands: `status`, `next`, `check`, `help`.
