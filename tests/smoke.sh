#!/usr/bin/env bash
# tests/smoke.sh — end-to-end check of the taskmap CLI and server in a temp dir.
# Uses an isolated TASKMAP_HOME and its own port so it never touches ~/.taskmap.
# Exit 0 when every assertion passes.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TM="$HERE/bin/taskmap"
TMP="$(mktemp -d)"
export TASKMAP_HOME="$TMP/home"
export TASKMAP_PORT="${TASKMAP_PORT:-4747}"
unset TASKMAP_PROJECT
URL="http://127.0.0.1:$TASKMAP_PORT"
PASS=0
FAIL=0
WPID=""

cleanup() {
  "$TM" serve --stop >/dev/null 2>&1 || true
  [ -n "$WPID" ] && kill "$WPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "FAIL $1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/     | /'
}
contains() { # label haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (expected '$3')" "$2"; fi
}
not_contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (did not expect '$3')" "$2"; else ok "$1"; fi
}
equals() { # label actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', expected '$3')"; fi
}

mkdir -p "$TMP/proj" && cd "$TMP/proj" && git init -q

# ---- init -------------------------------------------------------------
out=$("$TM" init "Pac-Man clone" --goal "A playable Pac-Man in the browser" 2>&1)
equals "init exits 0" "$?" "0"
contains "init prints root id and url" "$out" "n0  Pac-Man clone  $URL/?p="
contains "init writes .gitignore" "$(cat .gitignore)" ".taskmap/"
out=$("$TM" init "again" --goal "x" 2>&1)
equals "init is idempotent" "$?" "0"
contains "init again prints status" "$out" "0/0 leaves done"
[ -f .taskmap/map.json ] && ok "map.json exists" || bad "map.json missing"
[ -f .taskmap/log.jsonl ] && ok "log.jsonl exists" || bad "log.jsonl missing"

# ---- add --batch: 3 levels -------------------------------------------
out=$("$TM" add --batch 2>&1 <<'EOF'
[
 {"key":"m1","parent":"n0","title":"Build the maze","what":"Walls on a canvas.","why":"Everything moves inside it.","done_when":"The maze is visible."},
 {"key":"m2","parent":"n0","title":"Make the ghosts chase the player"},
 {"key":"c1","parent":"m1","title":"Decide the grid format"},
 {"key":"c2","parent":"m1","title":"Build the maze walls","links":["c1"],"done_when":"The player cannot cross a wall."},
 {"key":"s1","parent":"c2","title":"Draw the wall rectangles"}
]
EOF
)
equals "batch exits 0" "$?" "0"
contains "batch prints key -> id" "$out" "m1 -> n1"
contains "batch resolves keys in order" "$out" "s1 -> n5"

# ---- tree / next / show ----------------------------------------------
out=$("$TM" tree 2>&1)
contains "tree header" "$out" "Pac-Man clone  0/3 leaves done  0 in progress  0 blocked  0 unread"
contains "tree root line" "$out" "[ ] n0  Pac-Man clone  (0/3)"
contains "tree indents two spaces" "$out" "  [ ] n1  Build the maze  (0/2)"
contains "tree level 3" "$out" "      [ ] n5  Draw the wall rectangles"
out=$("$TM" next 2>&1)
contains "next picks first pending leaf" "$out" "n3  Decide the grid format"
out=$("$TM" show n4 2>&1)
contains "show prints links" "$out" "links: n3"
contains "show prints done_when" "$out" "done_when: The player cannot cross a wall."

# ---- status commands --------------------------------------------------
equals "start prints id" "$("$TM" start n3 2>/dev/null)" "n3"
contains "tree shows in_progress glyph" "$("$TM" tree)" "[~] n3"
equals "done prints id" "$("$TM" done n3 --note "grid is a text file" 2>/dev/null)" "n3"
contains "tree shows done glyph" "$("$TM" tree)" "[x] n3"
contains "next honours links" "$("$TM" next)" "n5  Draw the wall rectangles"
equals "block prints id" "$("$TM" block n5 --reason "waiting on user: wall color?" 2>/dev/null)" "n5"
contains "tree shows blocked reason" "$("$TM" tree)" "[!] n5  Draw the wall rectangles  blocked: waiting on user: wall color?"
contains "next skips blocked" "$("$TM" next)" "n2  Make the ghosts chase the player"
contains "status counts blocked" "$("$TM" status)" "blocked: 1"
contains "check counts blocked" "$("$TM" check)" "blocked: 1"
contains "check lists the question" "$("$TM" check)" "waiting: n5  Draw the wall rectangles  waiting on user: wall color?"
contains "check --json lists blocked" "$("$TM" check --json)" '"blocked":[{"id":"n5"' 
equals "skip prints id" "$("$TM" skip n2 --reason "ghosts come later" 2>/dev/null)" "n2"
contains "tree shows skipped" "$("$TM" tree)" "[-] n2  Make the ghosts chase the player  skipped: ghosts come later"
contains "next reports blocked" "$("$TM" next)" "none  remaining leaves are blocked: n5"
equals "reopen prints id" "$("$TM" reopen n5 2>/dev/null)" "n5"
contains "tree shows pending after reopen" "$("$TM" tree)" "[ ] n5  Draw the wall rectangles"
contains "skipped leaves leave the denominator" "$("$TM" tree)" "1/2 leaves done"
out=$("$TM" block n4 2>&1)
equals "block without reason exits 1" "$?" "1"
contains "block without reason hint" "$out" "needs --reason"

# ---- rejections -------------------------------------------------------
out=$("$TM" start n99 2>&1)
equals "unknown id exits 1" "$?" "1"
contains "unknown id message" "$out" "error: unknown node n99."
out=$("$TM" add "Too deep" --parent n5 2>&1)
equals "depth-4 add exits 1" "$?" "1"
contains "depth-4 message" "$out" "4 levels below the root; the limit is 3"
out=$("$TM" add "" --parent n0 2>&1)
equals "empty title exits 1" "$?" "1"
out=$("$TM" edit n1 --parent n4 2>&1)
equals "parent cycle exits 1" "$?" "1"
contains "cycle message" "$out" "cannot be its own ancestor"
out=$("$TM" add "One two three four five six seven eight nine" --parent n0 2>&1 >/dev/null)
contains "long title warns" "$out" "warn:"

# ---- server -----------------------------------------------------------
out=$("$TM" serve --ensure 2>&1)
contains "serve --ensure" "$out" "server"
out2=$("$TM" serve --ensure 2>&1)
contains "serve --ensure is idempotent" "$out2" "server running at $URL"
health=$(curl -s -m 2 "$URL/api/health")
contains "health" "$health" '"ok":true'
ID=$("$TM" check --json | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] && ok "check --json has id ($ID)" || bad "check --json has no id"
contains "api projects lists it" "$(curl -s "$URL/api/projects")" "\"id\":\"$ID\""
full=$(curl -s "$URL/api/projects/$ID")
contains "api full map" "$full" '"schema":1'
contains "api log tail" "$full" '"type":"init"'

# SSE: a map event within 1 s of a CLI change
SSE="$TMP/sse.txt"
curl -s -N --max-time 5 "$URL/api/projects/$ID/events" >"$SSE" 2>/dev/null &
sleep 0.7
"$TM" note n4 "walls are 32px tall" >/dev/null 2>&1
for _ in $(seq 1 20); do
  [ "$(grep -c '"type":"map"' "$SSE" 2>/dev/null)" -ge 2 ] && break
  sleep 0.05
done
n=$(grep -c '"type":"map"' "$SSE" 2>/dev/null)
[ "${n:-0}" -ge 2 ] && ok "SSE delivers a map event within 1 s of a CLI change" || bad "SSE map events: ${n:-0}"

# feedback round trip: curl POST -> inbox
r=$(curl -s -X POST "$URL/api/projects/$ID/feedback" -H 'content-type: application/json' -d '{"node":"n4","text":"walls should be half as tall"}')
contains "feedback POST ok" "$r" '"ok":true'
contains "tree shows unread" "$("$TM" tree)" "n4  Build the maze walls  (0/1)  (1 unread)"
out=$("$TM" inbox 2>&1)
contains "inbox prints feedback" "$out" 'n4 "Build the maze walls": walls should be half as tall'
equals "inbox empties" "$("$TM" inbox)" "inbox empty"
r=$(curl -s -X POST "$URL/api/projects/$ID/nodes" -H 'content-type: application/json' -d '{"parent":"n0","title":"Add a start screen"}')
contains "user node POST" "$r" '"id":"n7"'
contains "tree marks user node" "$("$TM" tree)" "n7  Add a start screen *  (1 unread)"
contains "inbox prints user node" "$("$TM" inbox)" 'n7 "Add a start screen" added by user under n0'
r=$(curl -s -X POST "$URL/api/projects/$ID/nodes/n3/status" -H 'content-type: application/json' -d '{"status":"pending"}')
contains "status override POST" "$r" '"status":"pending"'
contains "inbox prints override" "$("$TM" inbox)" 'n3 "Decide the grid format" set to pending by user'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/feedback" -d 'nope')
equals "bad JSON is 400" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/feedback" -H 'content-type: application/json' -d '{"node":"n99","text":"x"}')
equals "unknown node is 404" "$code" "404"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/nodes/n3/status" -H 'content-type: application/json' -d '{"status":"weird"}')
equals "unknown status is 400" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/projects/nope")
equals "unknown project is 404" "$code" "404"
contains "ui index served" "$(curl -s "$URL/")" "<html"

# ---- check ------------------------------------------------------------
out=$("$TM" check 2>&1)
equals "check exits 0" "$?" "0"
contains "check prints unread" "$out" "unread: 0"
"$TM" start n5 >/dev/null 2>&1
contains "check lists in_progress" "$("$TM" check)" "in_progress: n5  Draw the wall rectangles  (leaf)"
"$TM" reopen n5 >/dev/null 2>&1

# ---- watch ------------------------------------------------------------
W="$TMP/watch.txt"
"$TM" watch >"$W" 2>&1 &
WPID=$!
sleep 1.2
echo '{"ts":"2026-01-01T00:00:00.000Z","actor":"ui","type":"feedback","node":"n4","title":"Build the maze walls","text":"make them thicker"}' >>.taskmap/inbox.jsonl
sleep 1.5
kill "$WPID" 2>/dev/null
wait "$WPID" 2>/dev/null
WPID=""
equals "watch prints exactly one line" "$(wc -l <"$W" | tr -d ' ')" "1"
equals "watch line format" "$(cat "$W")" '[taskmap] feedback on n4 "Build the maze walls": make them thicker'

# ---- hooks ------------------------------------------------------------
hook() { # name json
  printf '%s' "$2" | "$TM" hook "$1" 2>/dev/null
}
contains "session-start prints the summary" "$(hook session-start "{\"source\":\"startup\",\"cwd\":\"$PWD\"}")" "[taskmap] Map found: Pac-Man clone, 0/4 done, 0 in progress, 0 blocked, 0 unread. Run /taskmap to resume."
out=$(hook session-start "{\"source\":\"compact\",\"cwd\":\"$PWD\"}")
contains "compact re-injects the tree" "$out" "[ ] n0  Pac-Man clone  (0/4)"
contains "compact keeps the indentation" "$out" "      [ ] n5  Draw the wall rectangles"
contains "compact names the map" "$out" "[taskmap] Context was compacted."
equals "session-start is silent without a map" "$(cd "$TMP" && hook session-start "{\"source\":\"startup\",\"cwd\":\"$TMP\"}")" ""
"$TM" start n5 >/dev/null 2>&1
contains "stop blocks on an open leaf" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" '"decision":"block"'
equals "stop allows the second time" "$(hook stop "{\"stop_hook_active\":true,\"cwd\":\"$PWD\"}")" ""
"$TM" reopen n5 >/dev/null 2>&1
equals "stop allows with nothing open" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" ""
long=$(printf 'x%.0s' $(seq 1 450))
equals "prompt reminder is off by default" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" ""
"$TM" config prompt-reminder on >/dev/null 2>&1
contains "prompt reminder fires on a long prompt" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" "[taskmap] Long prompt"
equals "prompt reminder skips short prompts" "$(hook prompt "{\"prompt\":\"short\",\"cwd\":\"$PWD\"}")" ""
"$TM" start n5 >/dev/null 2>&1
equals "prompt reminder skips when a leaf is in progress" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" ""
"$TM" reopen n5 >/dev/null 2>&1
"$TM" config prompt-reminder off >/dev/null 2>&1

# ---- export -----------------------------------------------------------
out=$("$TM" export --obsidian "$TMP/vault" 2>&1)
equals "export exits 0" "$?" "0"
contains "export reports the count" "$out" "notes -> $TMP/vault"
[ -f "$TMP/vault/n4 Build the maze walls.md" ] && ok "export writes a note per node" || bad "export note missing" "$(ls "$TMP/vault")"
note=$(cat "$TMP/vault/n4 Build the maze walls.md")
contains "export links the parent" "$note" "**Parent:** [[n1 Build the maze]]"
contains "export links dependencies" "$note" "**Depends on:** [[n3 Decide the grid format]]"
contains "export has frontmatter" "$note" "status: pending"

# ---- lock contention --------------------------------------------------
for i in $(seq 1 20); do "$TM" note n0 "concurrent note $i" >/dev/null 2>&1 & done
wait
count=$(node -e 'const m=require(process.argv[1]);console.log(m.nodes.n0.notes.length)' "$PWD/.taskmap/map.json" 2>/dev/null)
equals "20 concurrent notes all land" "$count" "20"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$PWD/.taskmap/map.json" && ok "map.json is valid JSON" || bad "map.json corrupt"
[ -e .taskmap/map.lock ] && bad "lock file left behind" || ok "no lock file left behind"
equals "no temp files left" "$(ls -A .taskmap | grep -c '\.tmp$')" "0"

# ---- wrap up ----------------------------------------------------------
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
