'use strict';
// watch.js — tail inbox.jsonl and print one line per new user event.
// Used by the plugin monitor. Prints nothing else, ever.

const fs = require('fs');
const path = require('path');
const store = require('./store');

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

// Blocks forever. Resolves the project from cwd, waiting until a map exists.
function watch({ cwd = process.cwd(), out = process.stdout, pollMs = 500, waitMs = 2000 } = {}) {
  let file = null;
  let offset = 0;
  let partial = '';

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

module.exports = { watch, formatInboxLine };
