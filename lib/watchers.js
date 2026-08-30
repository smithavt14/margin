/* sidecar — the WATCHER REGISTRY: who is armed on what, and whether they are still running.

   A `sidecar wait` is a long-lived process holding a turn, and until this file existed only half of
   them left a trace. `wait --dir` wrote a lock (lib/dir.js) because two folder watchers race every
   cursor in the folder; a per-document `wait` wrote nothing at all, so a backgrounded one that died
   with its harness was invisible: the browser eventually stopped reading "claude is here" and there
   was no way to ask what was still armed.

   Two record kinds, one directory, one format:

     sidecar-dirwait-<key>.lock   a folder watcher. Also a LOCK: acquiring it refuses a rival.
     sidecar-docwait-<key>.lock   a document watcher. A record and nothing else.

   The document record deliberately does NOT lock. A per-document wait has always been allowed to
   overlap another one (CLAUDE.md, "One watcher for the whole folder"): the cost of the overlap is one
   doubled digest on one document, which self-heals because both processes read and advance the same
   cursor file. Making it refuse would change a behaviour reviews already depend on. It is written so
   `sidecar watchers` can answer the question, and for no other reason.

   They live in tmp for the reason the folder lock does: this is machine-local state that dies with
   the process, unlike the cursor, and a file beside the documents is a new artifact nobody's
   .gitignore covers.

   Everything here is best-effort. An unwritable tmp must never stop a review, so every write is
   swallowed and the worst case is a watcher that does not appear in the list. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The wait heartbeats every 15s; three missed beats and the holder has stopped saying it is here.
const TTL = 60000;
const PREFIX = { dir: 'sidecar-dirwait-', doc: 'sidecar-docwait-' };

// signal 0 tests for the process without touching it. EPERM means it exists and belongs to someone
// else, which for this purpose is alive; ESRCH means it is gone.
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// The key is (target, agent), so one agent watching two folders holds two records and two agents on
// one folder hold one each. lib/dir.js computes the dir path by this same rule and must keep to it.
function recordPath(kind, target, agent) {
  const key = crypto.createHash('sha1').update(`${target}\0${agent}`).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `${PREFIX[kind]}${key}.lock`);
}

function read(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Arm a DOCUMENT record. Returns the path so the caller can touch and release it; never throws and
// never refuses, because a per-document wait is not a lock.
function arm(file, agent) {
  const p = recordPath('doc', file, agent);
  try { fs.writeFileSync(p, JSON.stringify({ pid: process.pid, kind: 'doc', file, agent, at: new Date().toISOString() })); }
  catch {}
  return p;
}

// The heartbeat is the mtime, which is what tells a killed watcher from a busy one.
function touch(p) { try { const t = new Date(); fs.utimesSync(p, t, t); } catch {} }

// Only ever remove our OWN record: a --force takeover rewrote a dir lock, and the process it took
// over from must not delete the new holder's claim on its way out.
function release(p) {
  try { const rec = read(p); if (rec && rec.pid === process.pid) fs.unlinkSync(p); } catch {}
}

// Every record in tmp, both kinds, newest first. `state` is the whole point of the list:
//   live   the process is running and beating
//   quiet  the process is running and has missed three beats (suspended, or wedged)
//   stale  the process is gone and the record outlived it
// Only `stale` is safe to reap, which is why a stopped heartbeat gets its own word rather than being
// folded into it: a suspended watcher wakes up and carries on, and deleting its record under it would
// hide a watcher that is genuinely armed.
function list(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    const kind = name.startsWith(PREFIX.dir) ? 'dir' : name.startsWith(PREFIX.doc) ? 'doc' : null;
    if (!kind || !name.endsWith('.lock')) continue;
    const p = path.join(os.tmpdir(), name);
    const rec = read(p);
    if (!rec || !rec.pid) continue;
    let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
    const running = alive(rec.pid);
    // `at` is when it armed; the mtime is only the last beat. A record written by an older version
    // carries no `at`, so the mtime stands in and the age reads as "since the last beat" instead.
    const started = Date.parse(rec.at || '') || mtime;
    out.push({ path: p, kind, pid: rec.pid, agent: rec.agent || '?',
               target: rec.file || rec.dir || '(unknown)', since: started, beat: mtime,
               state: !running ? 'stale' : (now - mtime > TTL ? 'quiet' : 'live') });
  }
  return out.sort((a, b) => a.since - b.since);
}

// Reap every record whose process is gone. Returns what it removed, so the caller reports rather than
// counts. A record that vanishes between the list and the unlink is somebody else cleaning up, which
// is the outcome either way.
function clean(records) {
  const dead = (records || list()).filter(r => r.state === 'stale');
  const reaped = [];
  for (const r of dead) { try { fs.unlinkSync(r.path); reaped.push(r); } catch { if (!fs.existsSync(r.path)) reaped.push(r); } }
  return reaped;
}

// Is this pid really the watcher its record claims? A pid is recycled the moment it is freed, so the
// record alone is not enough to send a signal on: the process wearing it now may be anything.
// `ps -o command=` is the second opinion, run without a shell so a crafted path cannot inject.
// Returns the command line when it looks like a sidecar wait, else null — and null when ps itself is
// unavailable, because an unverifiable target is one this refuses to signal.
//
// Two things have to be true of the command line: `wait` stands there as its own argument, and it
// names the thing the record says it is watching. The target is compared by BASENAME as well as in
// full, because the record holds a realpath and the command line holds whatever was typed — on macOS
// a wait armed on /tmp/x/a.md records /private/tmp/x/a.md, and a full-string compare alone refused
// every watcher under /tmp. `sidecar` in the command line satisfies the second half on its own, which
// is what an installed binary looks like (`sidecar wait …`) as opposed to a checkout (`node server.js
// wait …`).
function attributable(pid, target) {
  let cmd = '';
  try {
    const { execFileSync } = require('child_process');
    cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
  if (!cmd) return null;
  if (!/(^|\s)wait(\s|$)/.test(cmd)) return null;
  const names = target ? [target, path.basename(target)].filter(Boolean) : [];
  return (cmd.includes('sidecar') || names.some(n => cmd.includes(n))) ? cmd : null;
}

module.exports = { TTL, alive, recordPath, arm, touch, release, list, clean, attributable, read };
