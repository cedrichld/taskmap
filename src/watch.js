'use strict';
// watch.js — tail inbox.jsonl and print one line per new user event.
// Used by the plugin monitor. Prints nothing else, ever.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { envSid } = require('./runs');

function oneLine(s, max = 300) {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function formatInboxLine(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const title = `"${oneLine(ev.title, 120)}"`;
  switch (ev.type) {
    case 'feedback':
      return `[taskmap] feedback on ${ev.node} ${title}: ${oneLine(ev.text)}`;
    case 'node_added':
      return `[taskmap] user added ${ev.node} ${title} under ${ev.parent}`;
    case 'status':
      return `[taskmap] user set ${ev.node} ${title} to ${ev.status}`;
    default:
      return null;
  }
}

// One heartbeat file per session, refreshed while the monitor runs and removed
// when it stops, so the dashboard can show a live dot for sessions that exist.
function heartbeat({ cwd = process.cwd(), beatMs = store.SESSION_BEAT_MS } = {}) {
  const started = store.now();
  const sid = envSid(); // lets the dashboard tell a running prompt from one whose session died
  let lastDir = null;
  let lastId = null;

  const beat = () => {
    let projectId = lastId;
    let dir = null;
    try {
      dir = store.resolveProjectDir({ cwd });
    } catch (e) {
      dir = null;
    }
    if (dir && dir !== lastDir) {
      lastDir = dir;
      try {
        projectId = store.readMap(dir).id;
      } catch (e) {
        projectId = null;
      }
      lastId = projectId;
    } else if (!dir) {
      projectId = null;
      lastId = null;
      lastDir = null;
    }
    store.writeSession({ project_id: projectId, cwd, sid, started });
  };

  beat();
  const timer = setInterval(beat, beatMs);
  timer.unref();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    store.removeSession();
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  return cleanup;
}

// Blocks forever. Resolves the project from cwd, waiting until a map exists.
function watch({ cwd = process.cwd(), out = process.stdout, pollMs = 500, waitMs = 2000, beat = true } = {}) {
  let file = null;
  let offset = 0;
  let partial = '';
  if (beat) heartbeat({ cwd });

  const emit = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      return;
    }
    const text = formatInboxLine(ev);
    if (text) out.write(text + '\n');
  };

  const locate = () => {
    let dir = null;
    try {
      dir = store.resolveProjectDir({ cwd });
    } catch (e) {
      dir = null;
    }
    if (!dir) return false;
    file = path.join(store.dataDir(dir), 'inbox.jsonl');
    // Start at the end: history is for `taskmap inbox`, not for the monitor.
    try {
      offset = fs.statSync(file).size;
    } catch (e) {
      offset = 0;
    }
    partial = '';
    return true;
  };

  const tick = () => {
    if (!file) {
      if (!locate()) {
        setTimeout(tick, waitMs);
        return;
      }
    }
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (e) {
      st = null;
    }
    if (!st) {
      // project removed or inbox not created yet: keep waiting quietly
      try {
        if (!fs.existsSync(path.dirname(file))) file = null;
      } catch (e) {
        file = null;
      }
      offset = 0;
      partial = '';
      setTimeout(tick, waitMs);
      return;
    }
    if (st.size < offset) {
      // truncated or reset: do not replay
      offset = st.size;
      partial = '';
    }
    if (st.size > offset) {
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, offset);
        offset += read;
        const text = partial + buf.toString('utf8', 0, read);
        const lines = text.split('\n');
        partial = lines.pop();
        for (const line of lines) if (line.trim()) emit(line);
      } catch (e) {
        // try again next tick
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (e) {
            // ignore
          }
        }
      }
    }
    setTimeout(tick, pollMs);
  };

  tick();
}

module.exports = { watch, heartbeat, formatInboxLine };
