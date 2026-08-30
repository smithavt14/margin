/* sidecar — `sidecar wait <file>`: the reactive-loop primitive (P1), now watch/presence/timeout
   plumbing over lib/digest.js (P2).

   Moved verbatim out of server.js when the CLI grew its other verbs (lib/cli.js). Deliberately
   server-independent: it fs-watches the files directly, so it works with nothing running. The only
   thing it talks to a server about is decorative presence.

   The digest is no longer an in-memory delta of one wake — it seeds its baseline FROM the persisted
   cursor (lib/digest.js), so `wait` blocks until something the agent HASN'T SEEN, not just something
   that happens after launch. Consequence: launched with an unseen backlog it returns immediately with
   it. It shares one renderer with `sidecar digest`, and advances the cursor on a digest-emitting exit
   (never on a timeout exit). No cursor present → baseline is the current state → old behavior (wake on
   the next change). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { loadReview, sidecarPath } = require('./review.js');
const { snapshot, computeDigest, renderDigest, loadSeen, saveSeen, loadBaseline } = require('./digest.js');
const { ping: pingPresence, pingMany } = require('./presence.js');
const Dir = require('./dir.js');
const Watchers = require('./watchers.js');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const AGENT = process.env.SIDECAR_AGENT || 'claude';
const USAGE = 'usage: sidecar wait <file> [--timeout <seconds>]\n' +
              '       sidecar wait --dir <folder> [--timeout <seconds>] [--force]\n' +
              '       --timeout 0 blocks until something happens, with no backstop';

function runWait(argv) {
  let file = null, dir = null, dirGiven = false, force = false;
  let timeoutSec = 900;   // 15-min backstop (Alex's call) so a background wait can't hang forever
  for (let i = 0; i < argv.length; i++) {
    // `Number(x) || timeoutSec` read `--timeout 0` as the default and armed the 15-minute backstop
    // anyway, which is the opposite of what 0 says. Zero means no timeout: block until an event.
    // Anything unparseable still falls back, so a typo'd value cannot silently become "forever".
    if (argv[i] === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v) && v >= 0) timeoutSec = v; }
    else if (argv[i] === '--dir') { dirGiven = true; dir = argv[++i]; }
    else if (argv[i] === '--force') force = true;
    else if (!file) file = argv[i];
  }
  if (dirGiven) {
    if (!dir) { console.error(USAGE); process.exit(2); }
    return runWaitDir(dir, { timeoutSec, force });
  }
  if (!file) { console.error(USAGE); process.exit(2); }
  const raw0 = path.resolve(process.cwd(), file);
  // A folder passed as the positional watched a path chokidar would happily accept and loadReview
  // could never read: it slept until its timeout and reported nothing. Say which flag it wanted.
  try {
    if (fs.statSync(raw0).isDirectory()) {
      console.error(`sidecar wait: ${raw0} is a folder.\nWatch every document in it with:  sidecar wait --dir ${raw0}`);
      process.exit(2);
    }
  } catch {}
  // Fail loud: a relative path resolved from the wrong cwd would otherwise silently watch a nonexistent
  // file (and mis-key presence). Prefer an ABSOLUTE path; if relative, it must be relative to the served dir.
  if (!fs.existsSync(raw0)) {
    console.error(`sidecar wait: no file at ${raw0}\nPass an absolute path, or run from the served directory.`);
    process.exit(2);
  }
  // Canonicalize through symlinks BEFORE keying presence: on macOS /tmp is a symlink to /private/tmp,
  // and the server keys presence by its own realpath — an un-realpath'd key silently no-ops presence
  // (the server-side half of this fix lives in server.js). Also used for watching/reading so both agree.
  const abs = (() => { try { return fs.realpathSync(raw0); } catch { return raw0; } })();

  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const loadSafe = () => { try { return loadReview(abs); } catch { return { items: [] }; } };

  // A load is what renames a pre-1.7 sibling set (lib/review.js migrateLegacy), so it has to happen
  // BEFORE the cursor is read: an unrenamed `.review.seen.json` reads as no cursor at all, and the
  // backlog it was holding would go unreported for this wake.
  loadSafe();
  // Baseline = the persisted cursor for this agent, else a snapshot of the current state. Seeding from
  // the cursor is what makes an unseen backlog surface immediately; seeding from current state (no
  // cursor) preserves the original "wake on the next change" semantics.
  const baseline = (loadSeen(abs) || {})[AGENT] || snapshot(loadSafe(), sha(readSafe(abs)));
  const baseDone = !!((loadSafe().session || {}).done);   // a done that flips true DURING the wait should wake it

  let leaving = false, watcher = null, beat = null, timer = null, record = null;

  // Prints the digest and advances the cursor iff there's something unseen (or done just flipped).
  // Returns true when it emitted. Never emits twice: the caller guards with `leaving`.
  // NOTE: `baseline` above is the CURSOR snapshot; loadBaseline() is the doc-text baseline it diffs
  // against. saveSeen gets `raw` so the doc baseline advances with the cursor — and the timeout exit
  // below advances neither, on purpose.
  // Returns null when nothing was unseen; otherwise the ids now in hand, for the exit ping. The rule is
  // "which of these gets an answer": `news` and `replies` always do, and so does a REJECTION CARRYING A
  // REASON. The reason is an invitation to retry, the digest ships those in full for exactly that, and
  // the board used to sit blank while the follow-up was composed. A bare rejection stays dark, because
  // "just no" usually ends the thread and a light promising a reply that never comes is worse than no
  // light. Accepts, resolves and orphans stay dark for the same reason.
  const marksReply = (x) => x.status === 'rejected' && x.reasons.length > 0;
  function emit() {
    const raw = readSafe(abs);
    const d = computeDigest(baseline, loadSafe(), raw, AGENT, loadBaseline(abs, AGENT));
    if (d.empty && !(d.done && !baseDone)) return null;   // nothing unseen yet — keep sleeping
    console.log(renderDigest(d));
    saveSeen(abs, AGENT, d.snapshot, raw);
    return [...new Set([...d.news, ...d.replies, ...d.decided.filter(marksReply)].map(x => x.id).filter(Boolean))];
  }

  // Best-effort presence: tell a running server "Claude is here" so the browser can show it. Purely
  // decorative and server-optional — if the POST fails (server down), the wait still works.
  // `items` are the thread ids in hand (the browser marks those cards "replying"). Every ping from
  // here sends an EXPLICIT list, empty when empty-handed: the wait is the authority on what this
  // agent holds, so its heartbeat clearing a stale mark is the point, and `[]` is what says so. A CLI
  // write verb pings the same route with the field omitted, which means "leave my marks alone".
  const ping = (state, items, cb) => pingPresence(abs, state, items || [], cb);
  // `leaving` guard: an accept touches the doc AND the sidecar → two chokidar events. leave() is async
  // (a ≤400ms presence ping precedes process.exit), so without a synchronous flag the second event
  // re-entered emit() and the digest printed twice (2026-07 double-print bug). Set it before the async
  // ping; the watcher handler checks it first.
  const leave = (code, pstate, items) => {
    if (leaving) return; leaving = true;
    clearInterval(beat); clearTimeout(timer);
    if (watcher) watcher.close();
    if (record) Watchers.release(record);
    ping(pstate || 'idle', items, () => process.exit(code));
  };

  // Something already unseen at startup (a backlog, or done) → I'm about to handle it: show "working".
  // Nothing is registered yet on purpose: this path never blocks, so there is no armed watcher to
  // report and a record written here would only ever be seen as one that leaked.
  { const ids = emit(); if (ids) { ping('working', ids, () => process.exit(0)); return; } }

  // From here it genuinely blocks, so say so where `sidecar watchers` can read it. This is a RECORD
  // and not a lock: a second per-document wait on the same file is still allowed, exactly as it has
  // always been (lib/watchers.js says why).
  record = Watchers.arm(abs, AGENT);
  ping('watching');
  beat = setInterval(() => { if (!leaving) { Watchers.touch(record); ping('watching'); } }, 15000);   // heartbeat so a killed session goes stale, not stuck
  // TIMEOUT exit: emit() never ran, so the cursor is deliberately NOT advanced. `--timeout 0` arms no
  // timer at all, and the watcher below is then the only thing keeping the process alive.
  if (timeoutSec > 0) timer = setTimeout(() => {
    // Says what it is in words, because exit 1 on its own reads as a failure and this is the ordinary
    // end of a quiet turn: the cursor sat still, so re-arming picks up exactly where this left off.
    console.log('still watching (no activity within ' + timeoutSec + 's). The timeout expired, nothing was missed ' +
                'and nothing advanced, so run it again.\n\nDONE: false');
    leave(1, 'idle');
  }, timeoutSec * 1000);
  watcher = chokidar.watch([sidecarPath(abs), abs], { ignoreInitial: true });
  // Alex acted → the wait exits, but I'm now HANDLING it. Ping "working" (NOT idle) so the browser reads
  // "claude is working…" through my response window instead of "waiting for claude", and send the woken
  // ids so the cards themselves read "replying". Re-arming → "here", empty-handed.
  watcher.on('all', () => { if (leaving) return; const ids = emit(); if (ids) leave(0, 'working', ids); });
  process.on('SIGINT', () => leave(130, 'idle'));
  // SIGTERM too, now that this wait leaves a record behind: the default action would kill it without
  // running leave(), and the record it left would sit in tmp until something reaped it. Same exit code
  // the folder wait uses.
  process.on('SIGTERM', () => leave(143, 'idle'));
}

/* `sidecar wait --dir <folder>` — one process over every document in a folder.

   Same contract as the single-document wait, read a folder at a time: it blocks until something the
   agent has not seen lands on ANY document in the folder, prints one digest labelled per document,
   and exits 0. Timeout exits 1 and advances nothing. A path that is not a folder, or a folder this
   agent is already watching, exits 2.

   Everything underneath is the per-document machinery, run once per document: the cursor is still
   `<doc>.sidecar.seen.json`, the baseline is still `<doc>.sidecar.seen.base.<agent>`, and a cursor
   only advances for a document that actually contributed to the digest that was printed. So a folder
   wait and a per-document wait can be swapped for each other mid-review and neither replays nor
   skips a turn. */
function runWaitDir(dirArg, { timeoutSec, force }) {
  const raw0 = path.resolve(process.cwd(), dirArg);
  let isDir = false; try { isDir = fs.statSync(raw0).isDirectory(); } catch {}
  if (!isDir) {
    console.error(`sidecar wait --dir: no folder at ${raw0}\nPass an absolute path to the folder holding the documents.`);
    process.exit(2);
  }
  // Realpath before anything keys off it, for the two reasons the single-document wait does it: the
  // server keys presence by ITS realpath (a /tmp vs /private/tmp mismatch silently no-ops presence),
  // and the lock key must name the same folder however it was spelled on the command line.
  const dir = (() => { try { return fs.realpathSync(raw0); } catch { return raw0; } })();

  const lock = Dir.acquireLock(dir, AGENT, { force });
  if (lock.error) {
    console.error(`sidecar wait --dir: ${AGENT} is already watching ${dir} (pid ${lock.error.pid}, since ${lock.error.at}).\n` +
      `One watcher per folder: two share every cursor in it, so whichever advances one first decides what the other thinks it has seen.\n` +
      `Pass --force to take over.`);
    process.exit(2);
  }

  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const loadSafe = (p) => { try { return loadReview(p); } catch { return { items: [] }; } };

  // Per-document state, built on first sight and never rebuilt. A document that appears mid-wait is
  // baselined at its current state exactly as a document present at launch with no cursor is, so
  // creating a file does not wake the watcher and the first real change to it does. `loadSafe` before
  // the cursor is read for the same reason the single-document wait does it: a load is what renames a
  // pre-1.7 sibling set, and an unrenamed cursor reads as no cursor at all.
  const state = new Map();
  const see = (abs) => {
    if (state.has(abs)) return;
    loadSafe(abs);
    state.set(abs, { baseline: (loadSeen(abs) || {})[AGENT] || snapshot(loadSafe(abs), sha(readSafe(abs))),
                     baseDone: !!((loadSafe(abs).session || {}).done) });
  };
  const docs = () => { const live = Dir.docsIn(dir); for (const p of live) see(p); return live; };
  docs();

  let leaving = false, watcher = null, beat = null, timer = null;

  const marksReply = (x) => x.status === 'rejected' && x.reasons.length > 0;
  // Prints the folder digest and advances the cursors of the documents in it, iff something is
  // unseen. Returns the presence entries to ping on the way out (every document reads "working", and
  // the ones that woke it carry the thread ids so their cards read "replying"), or null to sleep on.
  function emit() {
    const results = docs().map((abs) => {
      const st = state.get(abs);
      const raw = readSafe(abs);
      const review = loadSafe(abs);
      const d = computeDigest(st.baseline, review, raw, AGENT, loadBaseline(abs, AGENT));
      return { abs, rel: path.relative(dir, abs), raw, d, woke: !d.empty || (d.done && !st.baseDone) };
    });
    if (!results.some(r => r.woke)) return null;
    console.log(Dir.renderDirDigest(dir, results));
    return results.map((r) => {
      if (!r.woke) return { path: r.abs, state: 'working', items: [] };
      saveSeen(r.abs, AGENT, r.d.snapshot, r.raw);
      const st = state.get(r.abs);
      st.baseline = r.d.snapshot; st.baseDone = r.d.done;
      const ids = [...new Set([...r.d.news, ...r.d.replies, ...r.d.decided.filter(marksReply)]
        .map(x => x.id).filter(Boolean))];
      return { path: r.abs, state: 'working', items: ids };
    });
  }

  const pingAll = (st, cb) => pingMany(docs().map(p => ({ path: p, state: st, items: [] })), cb);
  const leave = (code, entries) => {
    if (leaving) return; leaving = true;
    clearInterval(beat); clearTimeout(timer);
    if (watcher) watcher.close();
    Dir.releaseLock(lock.path);
    if (entries) pingMany(entries, () => process.exit(code));
    else pingAll('idle', () => process.exit(code));
  };

  // Something already unseen at startup (a backlog on any document, or a done) → handle it now.
  { const entries = emit(); if (entries) { Dir.releaseLock(lock.path); pingMany(entries, () => process.exit(0)); return; } }

  pingAll('watching');
  beat = setInterval(() => { if (leaving) return; Dir.touchLock(lock.path); pingAll('watching'); }, 15000);
  // TIMEOUT exit: emit() never ran, so no cursor moved. `--timeout 0` arms no timer, same as the
  // single-document wait.
  if (timeoutSec > 0) timer = setTimeout(() => {
    console.log(`still watching ${docs().length} document(s) in ${dir} (no activity within ${timeoutSec}s). The timeout ` +
                `expired, nothing was missed and nothing advanced, so run it again.\n\nDONE: false`);
    leave(1);
  }, timeoutSec * 1000);

  // Watch the FOLDER, not the list of documents it held at launch — that is what lets a document
  // created mid-wait join without the agent re-arming, and it costs one watcher instead of two (a
  // file list still needs a directory watcher to notice additions). depth 0 keeps it to this folder,
  // matching the doc set. The filter is the same pair the server's watcher uses: documents and their
  // sidecars. It deliberately excludes `.sidecar.seen*`, which this process writes itself — watching
  // its own cursor advance is a wake-up from nobody.
  const { docKind } = require('./cli.js');   // lazy for the same reason lib/dir.js is: cli.js requires this file
  const watched = (p) => {
    if (p === dir) return true;
    const b = path.basename(p);
    return !b.startsWith('.') && (!!docKind(b) || b.endsWith('.sidecar.json'));
  };
  watcher = chokidar.watch(dir, { ignored: (p) => !watched(p), ignoreInitial: true, depth: 0 });
  watcher.on('all', () => { if (leaving) return; const entries = emit(); if (entries) leave(0, entries); });
  // SIGTERM as well as SIGINT, which the single-document wait does not need: a killed folder wait
  // leaves a lock behind, and one that is cleaned up on the way out beats one that has to time out.
  process.on('SIGINT', () => leave(130));
  process.on('SIGTERM', () => leave(143));
}

module.exports = runWait;
