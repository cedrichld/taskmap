# taskmap — data model and API contract

Version 1 (`schema: 1`). This file is the contract between `src/store.js`,
`src/cli.js`, `src/server.js`, `src/watch.js` and `ui/`. Nothing writes
`map.json` except `store.js`.

## 1. Files

### Per project: `<project>/.taskmap/`

| File          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `map.json`    | The whole map. Rewritten atomically on every mutation.         |
| `log.jsonl`   | Append-only, one line per mutation (CLI and UI).               |
| `inbox.jsonl` | Append-only, the subset of log events the user originated.     |
| `map.lock`    | Lock file, exists only while a write is in progress.           |

`taskmap init` adds `.taskmap/` to `<project>/.gitignore` unless `--track`
(only when the directory is inside a git work tree).

### Global: `~/.taskmap/`

| File            | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `registry.json` | All known projects. `{ "schema": 1, "projects": { "<id>": { "id", "name", "path", "updated" } } }` |
| `server.pid`    | PID of the detached server, written by `taskmap serve`.     |
| `server.log`    | stdout+stderr of the detached server.                       |
| `config.json`   | Optional. `{ "prompt_reminder": false }` (phase 2 switch).  |
| `sessions/<pid>.json` | One per running `taskmap watch`; see below.           |
| `share.json`    | `{ token, created, url, pid }`. Exists only while a share runs. |
| `share.pid`, `share.log` | The detached `cloudflared` process and its output.  |
| `demo/`         | The demo project created by `taskmap demo`.                 |

### Session heartbeats: `~/.taskmap/sessions/<pid>.json`

```json
{ "project_id": "portfolio-website-3f9a1c", "cwd": "/home/me/site", "pid": 4211,
  "started": "2026-08-22T14:03:11.412Z", "last_seen": "2026-08-22T14:41:52.006Z",
  "opened": true }
```

One file per Claude Code session, written by the `taskmap watch` monitor: on start,
then every 20 s (`SESSION_BEAT_MS`), and removed on exit. A session counts as **live**
while `last_seen` is under 60 s old (`SESSION_TTL_MS`); anything older is a session
that died without cleaning up and is unlinked by the next reader. `project_id` is
`null` until the session's directory has a map. `opened` is set by
`taskmap open --if-needed` and is what stops a session opening a second tab; the
heartbeat preserves it across refreshes.

### The share token: `~/.taskmap/share.json`

Written by `taskmap share` **before** the tunnel starts, so the dashboard is never
public and unguarded. `token` is 32 random bytes as base64url (43 characters). While
the file exists, the server applies the share guard (section 6). `share --stop` kills
the `cloudflared` process and unlinks the file, which invalidates every link.

Project id = `slug(name) + "-" + sha1(absolute path).slice(0, 6)`, e.g.
`portfolio-website-3f9a1c`. The id is stable for a given name and path and
never changes after `init`.

Timestamps are ISO 8601 UTC strings (`2026-08-21T14:03:11.412Z`).

## 2. map.json

```json
{
  "schema": 1,
  "id": "portfolio-website-3f9a1c",
  "name": "Portfolio website",
  "goal": "A personal site that gets me interviews",
  "root": "n0",
  "created": "2026-08-21T14:03:11.412Z",
  "updated": "2026-08-21T15:20:02.001Z",
  "version": 17,
  "next_id": 23,
  "nodes": { "n0": { "...": "Node" }, "n1": { "...": "Node" } }
}
```

- `version` increments by one on every write. The UI uses it to detect change.
- `next_id` is the counter behind monotonic ids `n<k>`. Ids are never reused.
- `root` is always `"n0"`, the only node with `parent: null`.

### Node

```json
{
  "id": "n12",
  "parent": "n3",
  "order": 1,
  "title": "Build the maze walls",
  "what": "A wall layout loaded from a text grid and drawn as rectangles.",
  "why": "Every other game rule depends on knowing where the walls are.",
  "done_when": "The maze from the design sketch is visible and the player cannot cross a wall.",
  "status": "in_progress",
  "status_reason": null,
  "source": "claude",
  "links": ["n9"],
  "notes": [{ "ts": "…", "text": "Grid lives in src/maze.txt; 1 = wall." }],
  "feedback": [{ "ts": "…", "text": "walls should be half as tall", "read": false, "kind": "feedback" }],
  "created": "…",
  "updated": "…",
  "started_at": "…",
  "finished_at": null
}
```

| Field           | Type / values                                              | Notes |
| --------------- | ---------------------------------------------------------- | ----- |
| `parent`        | node id or `null` (root only)                              | Hierarchy. |
| `order`         | int, 0-based, contiguous among siblings                    | Siblings sort by `order`. |
| `title`         | non-empty string                                           | Warn (not reject) over 8 words. |
| `what`, `why`, `done_when` | string, may be `""`                             | |
| `status`        | `pending` `in_progress` `done` `blocked` `skipped`         | |
| `status_reason` | string or `null`                                           | Required for `blocked` and `skipped`, `null` otherwise. |
| `source`        | `claude` or `user`                                         | `user` = created from the dashboard. |
| `links`         | array of node ids                                          | "depends on" cross-links. No self-link, no duplicates. |
| `notes`         | `[{ts, text}]`                                             | Decisions and locations. |
| `feedback`      | `[{ts, text, read, kind}]`                                 | User-originated events on this node, see below. |
| `started_at`    | ISO string or `null`                                       | Set on first `start`. |
| `finished_at`   | ISO string or `null`                                       | Set on `done`, cleared on `reopen`. |

Depth: root is depth 0, milestones depth 1, chunks depth 2, steps depth 3.
Creating or moving a node to depth 4 or more is rejected unless `--force`
(the UI never forces).

### Feedback entries and the `read` flag

Every user-originated event lives on the node it concerns as a feedback
entry with a `kind`:

| `kind`     | Created by                                   | `text`                                        |
| ---------- | -------------------------------------------- | --------------------------------------------- |
| `feedback` | `POST …/feedback`                            | the user's message                            |
| `added`    | `POST …/nodes` (user-added node)             | `added by user under <parent id>`             |
| `status`   | `POST …/nodes/:nid/status` (user override)   | `set to <status> by user` (+ `: <reason>`)    |

`read: false` until Claude runs `taskmap inbox` (or the server receives
`POST …/nodes/:nid/read`). "Unread count" anywhere in the tool means the
number of feedback entries with `read: false`, across all nodes. `kind` may
be missing on old data and then means `feedback`.

### Derived values

- **Leaf**: a non-root node with no children. The root is never a leaf, so a
  project with no nodes reads `0/0`.
- **Effectively skipped**: the node or any ancestor has status `skipped`.
- **Progress**: `done leaves / (total leaves − effectively skipped leaves)`.
  Shown as `done/total` where `total` already excludes skipped leaves.
- **Closed subtree** (collapsed by `tree --open`): the node is `done` or
  `skipped` and every descendant is `done` or `skipped`.
- **Actionable** (`taskmap next`): the first leaf in depth-first sibling
  order that is `pending`, has no `blocked` or `skipped` ancestor, and whose
  `links` are all `done` or `skipped`.

## 3. log.jsonl and inbox.jsonl

One JSON object per line.

```json
{ "ts": "…", "actor": "cli", "type": "done", "node": "n12", "detail": { "from": "in_progress", "to": "done", "note": "…" } }
```

| `type`     | `actor` | `detail`                                          |
| ---------- | ------- | ------------------------------------------------- |
| `init`     | cli     | `{ name, goal }`                                  |
| `add`      | cli/ui  | `{ title, parent, source }`                       |
| `start` `done` `block` `skip` `reopen` | cli | `{ from, to, reason?, note? }` |
| `status`   | ui      | `{ from, to, reason? }` (user override)           |
| `edit`     | cli     | `{ fields: ["title", …] }`                        |
| `note`     | cli     | `{ text }`                                        |
| `feedback` | ui      | `{ text }`                                        |
| `read`     | cli/ui  | `{ count }`                                       |

`inbox.jsonl` receives a copy of every `actor: "ui"` event of type
`feedback`, `add` (written as `node_added`) and `status`, with two extra
fields so a tail can print a line without opening the map:

```json
{ "ts": "…", "actor": "ui", "type": "feedback",   "node": "n12", "title": "Build the maze walls", "text": "walls should be half as tall" }
{ "ts": "…", "actor": "ui", "type": "node_added", "node": "n19", "title": "Add a start screen", "parent": "n0" }
{ "ts": "…", "actor": "ui", "type": "status",     "node": "n7",  "title": "Make ghosts chase the player", "status": "pending", "reason": null }
```

`taskmap watch` prints, per new line, exactly one of:

```
[taskmap] feedback on n12 "Build the maze walls": walls should be half as tall
[taskmap] user added n19 "Add a start screen" under n0
[taskmap] user set n7 "Make ghosts chase the player" to pending
```

Newlines inside `text` become spaces; text is cut at 300 characters with `…`.

## 4. Writes: atomicity and locking (`store.js`)

`mutate(projectDir, actor, fn)`:

1. Acquire `<project>/.taskmap/map.lock` with `O_EXCL` (`fs.openSync(path, "wx")`).
   On `EEXIST`, sleep with backoff (5 ms doubling to 100 ms) and retry. If the
   lock's mtime is older than 5 s it is stale: unlink and retry. Give up with
   `error: map.json is locked` after 10 s.
2. Read and parse `map.json`.
3. Call `fn(map, ctx)`; it mutates `map` and returns `{ result, events }`.
   `events` are log lines (`{type, node, detail}`) and optional inbox lines.
4. `version += 1`, `updated = now`, touch `node.updated` for changed nodes.
5. Serialize with two-space indentation, write to
   `map.json.<pid>.<random>.tmp` in the same directory, `fsync`, then
   `renameSync` over `map.json` (atomic on POSIX).
6. Append events to `log.jsonl` (and `inbox.jsonl` when applicable) with a
   single `appendFileSync` call per file.
7. Release the lock (unlink), update `registry.json` `updated` for the
   project (best effort, same temp-and-rename pattern, no lock).

Reads (`readMap`) never take the lock; they retry once on a JSON parse error,
which can only happen while a different writer's rename is mid-flight on a
non-POSIX filesystem.

## 5. CLI (`bin/taskmap`)

Every command resolves the project first:

1. `--project <id>` or `TASKMAP_PROJECT=<id>` → look the id up in the registry.
2. Otherwise walk up from `cwd` looking for a `.taskmap/` directory.
3. Otherwise, if `cwd` is inside a git work tree, take the first entry of
   `git worktree list --porcelain` (the main work tree) and look for
   `<main>/.taskmap/`.
4. Otherwise: `error: no taskmap here. Run: taskmap init "<name>" --goal "<one sentence>"`.

Exit codes: 0 success, 1 rejected input or missing project, 2 internal
error. Errors are one line on stderr: `error: <what>. <fix hint>`.
Warnings are one line on stderr starting with `warn:`. Success output goes
to stdout and is the affected node id unless documented otherwise. Color
only when stdout is a TTY. No banners.

### Output formats (asserted by `tests/smoke.sh`)

`tree`
```
<name>  <done>/<total> leaves done  <n> in progress  <b> blocked  <k> unread
[~] n0  <name>  (3/12)
  [x] n1  Set up the project  (4/4)
  [~] n2  Build the maze  (1/5)
    [x] n5  Decide the grid format
    [~] n6  Build the maze walls  (2 unread)
    [ ] n7  Place the pellets *
    [!] n8  Tune the wall colors  blocked: waiting on user: which palette?
    [-] n9  Add diagonal walls  skipped: not in the design
```
- Glyphs: `[ ]` pending, `[~]` in_progress, `[x]` done, `[!]` blocked, `[-]` skipped.
- `(d/t)` after the title of every node that has children: done leaves / total non-skipped leaves.
- ` *` after the title of user-added nodes. `(k unread)` when the node has unread feedback.
- `blocked: <reason>` / `skipped: <reason>` at the end of the line.
- Default `--open` prints closed subtrees as one line. `--all` expands everything. `--depth N` hides nodes deeper than N below root.

`next`
```
n7  Place the pellets
what: <what>
done_when: <done_when>
links: n5
also in_progress: n6
```
or `none  <reason>` e.g. `none  all leaves done`, `none  remaining leaves are blocked: n8`, `none  n7 waits on n5 (pending)`, `none  no nodes yet`.

`show <id>`
```
n6  Build the maze walls  [in_progress]
parent: n2  order: 1  source: claude  links: n5
what: …
why: …
done_when: …
notes:
  2026-08-21T10:00:00Z  Grid lives in src/maze.txt; 1 = wall.
feedback:
  2026-08-21T10:05:00Z  unread  walls should be half as tall
created 2026-08-21T09:00:00Z  started 2026-08-21T10:00:00Z
```

`inbox`
```
n12 "Build the maze walls": walls should be half as tall
n19 "Add a start screen" added by user under n0
n7 "Make ghosts chase the player" set to pending by user
```
or `inbox empty`. Marks everything printed as read unless `--peek`.

`status` (one line)
```
<name>  <done>/<total> leaves done  in progress: n6 Build the maze walls  blocked: <b>  <k> unread  http://127.0.0.1:4242/?p=<id>
```

`check`
```
in_progress: n2  Build the maze
in_progress: n6  Build the maze walls  (leaf)
blocked: 1
waiting: n8  Tune the wall colors  waiting on user: which palette?
unread: 2
```
`check --json` → `{"map":true,"id":"…","name":"…","in_progress":[{"id":"n6","title":"…","leaf":true}],"blocked":[{"id":"n8","title":"…","reason":"…"}],"unread":2}`. One `waiting:` line per blocked node. Without a map: `no map` / `{"map":false}`. Exit 0 always. The root is never reported as in progress.

`add` prints the new id. `add --batch` prints one `key -> id` line per item.
`init` prints `n0  <name>  <url>` (or `status` output when the map already exists).
`start` `done` `block` `skip` `reopen` `edit` `note` print the node id.
`serve --ensure` prints `server running at <url>` or `server started at <url>`.
`share` prints the tunnel URL with `?t=<token>`, a blank line, a QR code of that URL
and two lines of help; `share --stop` prints `share stopped; the link no longer works`
or `no share running`. Without `cloudflared` on `PATH` it exits 1 with one line naming
the install page. Running `share` again while one is up reprints the same link.
`open --if-needed` prints the URL alone when it opened a browser, or
`<url>  (already open in a browser)` / `<url>  (already opened this session)` when it
did not. It opens nothing when a live session heartbeat for the project has `opened`,
or when `/api/clients` reports a connected client for it; with no answer from the
server it opens. `TASKMAP_NO_BROWSER=1` suppresses the launch everywhere.
`demo` prints the demo URL. `open` prints the URL it opened. `forget <id>` removes a registry entry and prints the id.
`export --obsidian <dir>` writes `<id> <title>.md` per node (YAML frontmatter, `[[wikilinks]]` to parent, children, dependencies and dependents) and prints `<n> notes -> <dir>`.
`config prompt-reminder on|off` toggles `prompt_reminder` in `~/.taskmap/config.json`; bare `config` prints the file.

Hooks read the event JSON on stdin and print what Claude should see:
- `hook session-start`: `[taskmap] Map found: <name>, <done>/<total> done, <n> in progress, <b> blocked, <k> unread. Run /taskmap to resume.` or nothing. A second line names the overview URL when more than one project is registered and present on disk. When `source` is `compact`: a `[taskmap] Context was compacted…` line, the `tree --open` output (depth reduced until it fits in 9,000 characters), the in-progress nodes, the blocked nodes and the unread count.
- `hook stop`: nothing when `stop_hook_active` is true or no leaf is in progress; otherwise `{"decision":"block","reason":"taskmap: n5 \"…\" is still in_progress …"}`.
- `hook prompt`: nothing unless `prompt_reminder` is on, the prompt is over 400 characters, does not start with `/`, and no leaf is in progress; then one `[taskmap] Long prompt …` line.

### Status transitions

| Command  | New status    | Also                                                |
| -------- | ------------- | --------------------------------------------------- |
| `start`  | `in_progress` | `started_at` if unset, `status_reason = null`. Warns if another node is already in progress. |
| `done`   | `done`        | `finished_at = now`, `status_reason = null`, `--note` appends a note. Warns if leaves below are not done. |
| `block`  | `blocked`     | `status_reason = reason` (required).                |
| `skip`   | `skipped`     | `status_reason = reason` (required).                |
| `reopen` | `pending`     | `status_reason = null`, `finished_at = null`.       |

Any transition is allowed from any status; the tool trusts the operator.

### Rejections (exit 1, one line)

- unknown node id → `error: unknown node n99. Run 'taskmap tree --all' to list ids.`
- parent cycle → `error: n3 cannot be its own ancestor.`
- empty title → `error: title is empty.`
- unknown status → `error: unknown status "nope". Use pending|in_progress|done|blocked|skipped.`
- depth → `error: n12 would sit 4 levels below the root; the limit is 3. Add it higher up or pass --force.`
- missing reason → `error: block needs --reason "<why>".`
- bad batch JSON → `error: --batch expects a JSON array on stdin: [{key, parent, title, what, why, done_when, links}].`

## 6. HTTP API (`src/server.js`)

Bound to `127.0.0.1:4242` (`TASKMAP_PORT` overrides the port, the host is
fixed). All responses are JSON except static files.

**Share guard.** When `~/.taskmap/share.json` exists, every request whose `Host`
header is not `localhost`, `127.0.0.1` or `[::1]` must carry the token, or the answer
is `401` with an empty body and no other header. The token arrives either as `?t=`,
which for `GET`/`HEAD` answers `302` to the same path without it and sets
`taskmap_share=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` (plus
`Secure` when `X-Forwarded-Proto` is `https`), or in that cookie. Comparison is
`crypto.timingSafeEqual`. The file is re-read only when its mtime or size changes, so
`share --stop` takes effect on the next request. Requests from this machine are never
challenged, which also closes the DNS-rebinding hole. Errors:
`{ "error": "<message>" }` with status 400 (bad input), 404 (unknown
project or node, or project directory missing), 500 (unexpected).

| Method | Path | Body | Response |
| ------ | ---- | ---- | -------- |
| GET | `/` | | the overview page (`ui/index.html`). `/?p=<id>` answers `302` to `/p/<id>` |
| GET | `/p/<id>` | | the project page (`ui/project.html`); the id is read client-side |
| GET | `/app.js` `/overview.js` `/style.css` `/vendor/d3.v7.min.js` | | static files from `ui/` |
| GET | `/api/health` | | `{ "ok": true, "app": "taskmap", "version": "0.1.0", "pid": 123, "port": 4242 }` |
| GET | `/api/projects` | | `{ "projects": [ { "id", "name", "path", "goal", "updated", "exists", "live", "sessions", "clients", "progress": { "done", "total" } \| null, "in_progress": n, "in_progress_titles": [..], "blocked": b, "unread": k } ] }` newest first |
| GET | `/api/clients` | | `{ "ok": true, "total": n, "projects": { "<id>": n }, "sessions": { "<id>": n }, "session_ttl_ms": 60000 }` |
| GET | `/api/projects/:id` | | `{ "project": { "id", "name", "path", "updated", "exists", "url" }, "map": <map.json>, "log": [ last 100 log lines, oldest first ] }` |
| GET | `/api/projects/:id/events` | | SSE, see below |
| POST | `/api/projects/:id/feedback` | `{ "node": "n12", "text": "…" }` | `{ "ok": true, "node": <node> }` |
| POST | `/api/projects/:id/nodes` | `{ "parent": "n0", "title": "…", "what"?: "…", "why"?: "…" }` | `201 { "ok": true, "id": "n19", "node": <node> }` |
| POST | `/api/projects/:id/nodes/:nid/status` | `{ "status": "done", "reason"?: "…" }` | `{ "ok": true, "node": <node> }` |
| POST | `/api/projects/:id/nodes/:nid/read` | | `{ "ok": true, "read": <count marked> }` |

Validation: `text` and `title` must be non-empty strings (≤ 4000 / ≤ 200
chars); `reason` is required for `blocked` and `skipped`; `parent` and
`node` must exist; bodies over 64 KB and non-JSON bodies are 400.
POSTs are logged with `actor: "ui"`; the first three also append to
`inbox.jsonl` and create an unread feedback entry on the node.

`live` is true when at least one session heartbeat for the project is fresh;
`clients` is the number of SSE connections the server currently holds for it.

`/p/<project id>` is the project page. `/?p=<id>` redirects to it, so links printed
before 0.2 keep working. On `/p/<unknown id>` the UI falls back to the most recently
updated project that still exists on disk and says so.

### SSE: `/api/projects/:id/events`

```
retry: 2000

data: {"type":"map","map":{…},"log":[…]}

data: {"type":"ping"}
```

- A `map` message is sent immediately on connect and again whenever
  `map.json` changes (`map.version` differs or the file's mtime/size changed).
- A `ping` message every 20 s keeps proxies and the browser happy.
- The server polls the mtime of every registered `map.json` every 300 ms
  (`fs.watch` is not used: atomic renames and editors make it unreliable).
  A CLI change is therefore visible in the browser within ~300 ms.

## 7. UI expectations (`ui/`)

- The overview (`/`) polls `GET /api/projects` every 2 s and draws one card per
  project: name, goal, progress bar, in-progress titles, blocked and unread chips,
  a live dot when `live`, and the age of `updated`. Live projects sort first, then
  by `updated` descending. A card links to `/p/<id>`. No SSE: the payload is small
  and the page must survive the server restarting.
- On a project page, on load: `GET /api/projects` for the switcher, `GET /api/projects/:id`
  for the initial render, then `EventSource` on `/events`. Re-render on every
  `map` message. Reconnect with backoff (1 s, 2 s, 4 s, max 15 s) and show a
  "disconnected" state meanwhile; also re-fetch the map on reconnect.
- Projects with `exists: false` are greyed in the switcher and not selectable.
- View choice (Graph | Outline) and collapsed node ids are kept in
  `sessionStorage` per project; the default is Graph, or Outline under 768 px.
- Under 768 px the side panel is a bottom sheet: selecting a node raises it,
  `Message Claude` focuses the composer, and Close, the backdrop or Escape lowers it.
  Every control is at least 44 px and inputs are 16 px so iOS does not zoom. The
  overview grid becomes one column under 640 px.
- The graph is fit and centered on load and after every structural change
  (nodes added or removed, a fold toggled) unless the user has panned or zoomed;
  Fit / `f` restores auto-fit. It is centered in the free area — the window minus
  the header, the Waiting-on-you strip and the side panel, all of which float over
  the canvas — and capped at 1.25x, or 1.7x on windows 1900 px and wider.
- Stacked leaves wrap into up to four columns. `bestLayout()` lays the tree out at
  one to four columns and keeps whichever yields the largest fit scale, requiring a
  3 % gain before spending the extra width.
- Status on a node is a ring plus a shaped mark (hollow / filled / check / bar /
  struck), never hue alone. Only the in-progress leaf carries full accent and the
  breathing halo; its ancestors get the same ring at 30 % and no halo.
- With nothing selected the panel shows the first blocked node's question and an
  Answer button, or what Claude is working on, or "All done"; then the status legend
  and the keyboard shortcuts.
- Every status write from the panel leaves an Undo for 12 seconds that writes the
  previous status back. Blocked nodes show their reason on the card (two
  lines, then ellipsis) and in a "Waiting on you" strip under the header with a
  Reply control that focuses the feedback box on that node.
- The UI never marks feedback read on its own.
- Visual language: `docs/design/DESIGN.md`. Headless renders:
  `node tests/shots.js <projectId|/path> <WxH> <out.png> [select=<id>] [view=outline]
  [mobile=1]`; a 40-node fixture: `tests/gen40.js`.

## 8. Plugin wiring

- `.claude-plugin/plugin.json`: `name`, `version`, `description`, `skills: ["./"]`,
  `hooks: "./hooks/hooks.json"`, `experimental.monitors: "./monitors/monitors.json"`.
- `hooks/hooks.json` (phase 1): `SessionStart` → `"${CLAUDE_PLUGIN_ROOT}"/bin/taskmap hook session-start`;
  plain stdout reaches Claude's context for this event.
- `monitors/monitors.json`: `[{ "name": "taskmap-inbox", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/taskmap watch", "description": "User feedback and tasks from the taskmap dashboard", "when": "always" }]`.
  The command runs in the session working directory; each stdout line
  reaches Claude as a notification.
- Phase 2 hooks: compaction re-injection uses `SessionStart` with
  `source: "compact"` (PostCompact output does not reach Claude's context);
  `Stop` blocks once via `{ "decision": "block", "reason": … }` unless
  `stop_hook_active` is true; `UserPromptSubmit` prints one line of plain
  stdout when enabled in `~/.taskmap/config.json`.
