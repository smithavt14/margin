/* sidecar — the DIRECTORY layer under `sidecar wait --dir` and `sidecar digest --dir`.

   Reviewing a product means reviewing a FOLDER: a brief, a research report, a business case. Per
   document that was one `wait` process each, three background watchers juggled for one review, and
   three digests the agent had to stitch together itself. `--dir` is one watcher and one digest over
   the whole folder.

   It is an AGGREGATION LAYER and nothing else. Every cursor stays exactly where it was — one
   `<doc>.sidecar.seen.json` per document, keyed by agent (lib/digest.js) — so a folder wait and a
   per-document wait read and advance the same markers, and switching between them loses nothing. A
   directory-level cursor would have been a second store to keep honest, and the first time the two
   disagreed the agent would have replayed or skipped a turn.

   Three things live here: which files a folder's review consists of, how several per-document
   digests read as one, and the lock that stops two folder watchers fighting over the same cursors.
   All of it is pure except `docsIn` (a readdir) and the lock (a file in tmp). */
const fs = require('fs');
const path = require('path');
const { digestBody } = require('./digest.js');
const Watchers = require('./watchers.js');

// ---------- the doc set ----------

// The same folder the PANEL shows (server.js /api/dir): every document directly in it, no recursion,
// no dotfiles, nothing outside the `docKind` allowlist that already gates the picker, the watcher and
// every CLI verb. One definition means the agent watches exactly the rows the human sees.
//
// `require` is deliberately lazy: lib/cli.js requires this module, and its own `module.exports` is
// assigned at the bottom of the file, so a top-level require here would capture an empty object.
// Sorted by name so a digest lists documents in one order rather than the readdir's.
function docsIn(dir) {
  const { docKind } = require('./cli.js');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && docKind(e.name))
    .map(e => path.join(dir, e.name))
    .sort();
}

// ---------- the aggregate digest ----------

// Several per-document deltas (lib/digest.js computeDigest) as one report. `results` is EVERY
// document in the folder, in order, each `{ rel, d }`; this filters, because the count of documents
// with something to say is only meaningful against the count of documents looked at.
//
// The per-document renderer is reused for the body of each section (digestBody), so a line means the
// same thing here as it does in a single-document digest. What differs is the frame: a heading per
// document, and one DONE for the folder.
//
// DONE is true only when EVERY document is marked done, because that is the question the loop asks —
// "may I stop watching this folder?" — and one finished document does not answer it. The partial
// count rides along by name so the agent can see the review closing without opening anything.
function renderDirDigest(label, results) {
  const n = results.length;
  const plural = (k) => `${k} document${k === 1 ? '' : 's'}`;
  const done = results.filter(r => r.d.done).map(r => r.rel);
  const allDone = n > 0 && done.length === n;
  const tail = `DONE: ${allDone ? 'true' : 'false'}` +
    (done.length && !allDone ? `  (${done.length} of ${n} marked done: ${done.join(', ')})` : '');

  const live = results.filter(r => !r.d.empty);
  if (!live.length) return `nothing new across ${plural(n)} in ${label}\n\n${tail}`;

  let out = `## sidecar — your turn in ${label} (${live.length} of ${plural(n)})`;
  for (const r of live) {
    out += `\n\n### ${r.rel}${r.d.noMarker ? '  (no last-seen marker)' : ''}`;
    const body = digestBody(r.d, '####');   // the document's own name is the ### above it
    if (body) out += '\n' + body;
  }
  return out + '\n\n' + tail;
}

// ---------- the lock ----------

// One folder watcher per agent. Two of them share every cursor in the folder, so whichever advances
// one first decides what the other believes it has already seen, and the human gets answered twice or
// not at all — the same reason a second `hq wait` refuses.
//
// The lock covers DIRECTORY waits only, and a per-document `wait` inside the folder coexists with one.
// Three reasons, and the third is the honest one: a per-document wait writes no lock today and has to
// keep behaving byte-for-byte as it does, so it can neither refuse nor be detected; the failure this
// prevents is folder-wide (two heartbeats claiming presence on every document, two watchers racing
// every cursor in it); and one overlapping per-document wait costs one doubled digest on one document,
// which self-heals because the cursor it advances is the same file both processes read.
//
// It lives in tmp rather than beside the documents: it is machine-local and dies with the process,
// unlike the cursor, and a lock file in the folder is a new artifact nobody's .gitignore covers.
//
// The file itself is one of the two record kinds `sidecar watchers` lists, so its name, its TTL and
// its liveness test come from lib/watchers.js rather than being spelled a second time here. What
// stays here is the only thing the registry does not do: refusing a rival.
const LOCK_TTL = Watchers.TTL;   // the wait heartbeats every 15s; three missed beats and the holder is gone

function lockPath(dir, agent) { return Watchers.recordPath('dir', dir, agent); }

function readLock(p) { return Watchers.read(p); }

const alive = Watchers.alive;

// The live holder of `p`, or null. Two independent staleness checks, because either one alone lies:
// a pid can be recycled by an unrelated process, and an mtime alone cannot tell a killed watcher from
// a busy one. A lock is held when its owner is running AND something refreshed it recently.
function heldBy(p, now = Date.now()) {
  const rec = readLock(p);
  if (!rec || !rec.pid) return null;
  let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch { return null; }
  if (now - mtime > LOCK_TTL) return null;
  if (rec.pid !== process.pid && !alive(rec.pid)) return null;
  return rec;
}

// Returns { path } on success, { error: <the holder> } when someone else has it. `force` takes over,
// which is the escape hatch for a lock whose holder is wedged rather than dead.
function acquireLock(dir, agent, { force = false } = {}) {
  const p = lockPath(dir, agent);
  const held = heldBy(p);
  if (held && !force && held.pid !== process.pid) return { error: held };
  // `kind` names the record for the registry's benefit; the filename already says it, and a record
  // that carries its own kind survives being read by something that does not know the prefixes.
  try { fs.writeFileSync(p, JSON.stringify({ pid: process.pid, kind: 'dir', dir, agent, at: new Date().toISOString() })); }
  catch { return { path: p };  }   // an unwritable tmp must not stop a review; the lock is a courtesy
  return { path: p };
}

// The heartbeat: the mtime is half of what heldBy reads, so a watcher that stops beating goes stale
// on its own without anything having to clean up after it.
function touchLock(p) { try { const t = new Date(); fs.utimesSync(p, t, t); } catch {} }

// Only ever remove our OWN lock: a --force takeover rewrote the file, and the process it took over
// from must not delete the new holder's claim on its way out.
function releaseLock(p) {
  try { const rec = readLock(p); if (rec && rec.pid === process.pid) fs.unlinkSync(p); } catch {}
}

module.exports = { docsIn, renderDirDigest, lockPath, heldBy, acquireLock, touchLock, releaseLock, LOCK_TTL };
