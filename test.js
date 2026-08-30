/* sidecar test suite — spins the real server against a temp fixture dir and hits the real API.
   Run: npm test */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

// mirror the server's content hash (sha1 hex, first 12) so tests can assert the returned hash
// equals the sha of the exact bytes on disk.
const sha_of = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

const PORT = 4991;
const BASE = `http://127.0.0.1:${PORT}`;
let dir, proc;

const DOC = `# Title

Intro paragraph with **bold** text and a [link](https://example.com).

## Section A

Repeated line here.

## Section B

Repeated line here.

- item one
- item two

| a | b |
| - | - |
| 1 | 2 |

\`\`\`js
const x = 1;
\`\`\`

Closing paragraph.
`;

const j = (r) => r.json();
// Retry once on a CONNECTION-level failure. undici keeps sockets alive between requests, but Node's
// server closes an idle connection after keepAliveTimeout (5s) — so the first fetch following a long
// stretch of non-HTTP tests (the CLI block runs for seconds without touching the server) reuses a
// socket the server has already closed and gets ECONNRESET. Nothing to do with the code under test:
// it moved when the tests were reordered, always landing on whichever HTTP test came first after the
// gap. Retrying establishes a fresh connection. Only connection errors retry; a real HTTP response,
// including a 4xx/5xx, is returned untouched.
async function fetchRetry(url, init) {
  try { return await fetch(url, init); }
  catch (e) {
    if (!/fetch failed/.test(e.message)) throw e;
    return fetch(url, init);
  }
}
const state = () => fetchRetry(`${BASE}/api/state?path=doc.md`).then(j);
const put = (url, body) => fetchRetry(`${BASE}${url}`, { method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (url, body) => fetchRetry(`${BASE}${url}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// Raw GET so we can set an arbitrary Host header (fetch/undici normalizes it to the target).
const rawGet = (pathname, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
    headers: host ? { Host: host } : {} }, (res) => {
    let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject); req.end();
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
  fs.writeFileSync(path.join(dir, 'doc.md'), DOC);
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir });
  proc = spawn('node', [path.join(__dirname, 'server.js'), dir],
    { env: { ...process.env, SIDECAR_PORT: PORT }, stdio: 'pipe' });
  await new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(); });
    proc.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('state returns markdown, hash, empty review', async () => {
  const s = await state();
  assert.equal(s.markdown, DOC);
  assert.match(s.hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(s.review.items, []);
});

test('save with correct baseHash succeeds and returns new hash', async () => {
  const s = await state();
  const next = s.markdown.replace('Intro paragraph', 'Intro paragraph EDITED');
  const r = await put('/api/save', { path: 'doc.md', content: next, baseHash: s.hash });
  assert.equal(r.status, 200);
  const body = await j(r);
  assert.notEqual(body.hash, s.hash);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /EDITED/);
});

test('save with stale baseHash returns 409 and does not clobber', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await put('/api/save', { path: 'doc.md', content: 'CLOBBERED', baseHash: 'deadbeef0000' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('save without baseHash overrides (explicit "save anyway" path)', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await put('/api/save', { path: 'doc.md', content: before, baseHash: undefined });
  assert.equal(r.status, 200);
});

test('save preserves CRLF endings — client PUTs all-LF (marked normalizes), file stays CRLF', async () => {
  // fixture with CRLF endings; git-tracked separately from doc.md so other tests are unaffected.
  const crlfDoc = 'Line one.\r\nLine two.\r\nLine three.\r\n';
  fs.writeFileSync(path.join(dir, 'crlf.md'), crlfDoc);
  const s = await fetch(`${BASE}/api/state?path=crlf.md`).then(j);
  assert.ok(s.markdown.includes('\r\n'), 'state returns the raw CRLF bytes');
  // client sends the same text but all-LF (what marked+serializer produce) plus a small edit.
  const edited = s.markdown.replace(/\r\n/g, '\n').replace('Line two.', 'Line two EDITED.');
  const r = await put('/api/save', { path: 'crlf.md', content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const saved = fs.readFileSync(path.join(dir, 'crlf.md'), 'utf8');
  assert.ok(saved.includes('\r\n'), 'CRLF endings preserved');
  assert.ok(!saved.replace(/\r\n/g, '').includes('\n'), 'no lone \\n left (every \\n preceded by \\r)');
  assert.match(saved, /Line two EDITED\./, 'the edit landed');
  // returned hash matches what is actually on disk, so the next baseHash stays valid.
  assert.equal((await j(r)).hash, sha_of(saved));
});

test('save keeps an LF file LF — no stray \\r introduced', async () => {
  const lfDoc = 'Alpha.\nBeta.\nGamma.\n';
  fs.writeFileSync(path.join(dir, 'lf.md'), lfDoc);
  const s = await fetch(`${BASE}/api/state?path=lf.md`).then(j);
  const edited = s.markdown.replace('Beta.', 'Beta EDITED.');
  const r = await put('/api/save', { path: 'lf.md', content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const saved = fs.readFileSync(path.join(dir, 'lf.md'), 'utf8');
  assert.ok(!saved.includes('\r'), 'no \\r introduced into an LF file');
  assert.match(saved, /Beta EDITED\./);
  assert.equal((await j(r)).hash, sha_of(saved), 'returned hash matches on-disk LF bytes');
});

test('save returned hash equals the sha of the bytes actually written (CRLF)', async () => {
  const crlfDoc = 'One.\r\nTwo.\r\n';
  fs.writeFileSync(path.join(dir, 'crlf2.md'), crlfDoc);
  const s = await fetch(`${BASE}/api/state?path=crlf2.md`).then(j);
  const r = await put('/api/save', { path: 'crlf2.md', content: 'One.\nTwo CHANGED.\n', baseHash: s.hash });
  const body = await j(r);
  const saved = fs.readFileSync(path.join(dir, 'crlf2.md'), 'utf8');
  assert.ok(saved.includes('\r\n'));
  // next save with the returned hash as baseHash must NOT 409 (optimistic lock stays consistent).
  const r2 = await put('/api/save', { path: 'crlf2.md', content: 'One.\nTwo CHANGED AGAIN.\n', baseHash: body.hash });
  assert.equal(r2.status, 200, 'returned hash matched on-disk bytes — no false 409');
});

test('review PUT merges by id — agent items written between load and save survive', async () => {
  // client loads (empty-ish), agent writes an item straight to the sidecar, client PUTs its own item
  const agentItem = { id: 'agent1', kind: 'comment', by: 'claude',
    anchor: { quote: 'Closing paragraph.', occurrence: 0 }, status: 'open',
    thread: [{ by: 'claude', at: 'x', text: 'agent note' }] };
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'),
    JSON.stringify({ schema: 1, items: [agentItem] }));
  const clientItem = { id: 'alex1', kind: 'comment', by: 'alex',
    anchor: { quote: 'item one', occurrence: 0 }, status: 'open',
    thread: [{ by: 'alex', at: 'x', text: 'alex note' }] };
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [clientItem] } });
  const body = await j(r);
  const ids = body.review.items.map(i => i.id).sort();
  assert.deepEqual(ids, ['agent1', 'alex1']);
});

test('review PUT same-id merge unions threads — a stale client PUT cannot drop the agent reply (H1)', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  // 1) client seeds c1 with one human message.
  const human1 = { by: 'alex', at: '2026-07-18T10:00:00Z', text: 'first human note' };
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'alex', anchor: { quote: 'item one', occurrence: 0 },
      status: 'open', thread: [human1] }] } });
  // 2) agent appends a reply straight to the sidecar (the client never sees it).
  const agentMsg = { by: 'claude', at: '2026-07-18T10:05:00Z', text: 'agent reply' };
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  onDisk.items.find(i => i.id === 'c1').thread.push(agentMsg);
  fs.writeFileSync(p, JSON.stringify(onDisk));
  // 3) human, whose loaded copy predates the agent reply, adds their own reply and PUTs the STALE c1
  //    (has human1 + human2, MISSING agentMsg).
  const human2 = { by: 'alex', at: '2026-07-18T10:10:00Z', text: 'second human note' };
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'alex', anchor: { quote: 'item one', occurrence: 0 },
      status: 'open', thread: [human1, human2] }] } });
  const thread = (await j(r)).review.items.find(i => i.id === 'c1').thread;
  const texts = thread.map(m => m.text);
  assert.ok(texts.includes('agent reply'), 'agent reply was dropped — the H1 data-loss bug');
  assert.ok(texts.includes('second human note'), 'human reply was dropped');
  assert.ok(texts.includes('first human note'));
  assert.equal(thread.length, 3, 'exactly the three distinct messages, no dupes');
  assert.deepEqual(texts, ['first human note', 'agent reply', 'second human note'], 'insertion order: on-disk (human1, agent reply) then the incoming new one (human2)');
});

test('review PUT same-id merge does not regress a decided status back to open', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  // on disk: c2 already resolved.
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'item two', occurrence: 0 },
      status: 'resolved', decidedAt: '2026-07-18T09:00:00Z', thread: [] }] } });
  // stale PUT still thinks c2 is open.
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'item two', occurrence: 0 },
      status: 'open', thread: [] }] } });
  const c2 = (await j(r)).review.items.find(i => i.id === 'c2');
  assert.equal(c2.status, 'resolved', 'terminal status regressed to open');
  assert.equal(c2.decidedAt, '2026-07-18T09:00:00Z', 'decidedAt not carried');
});

test('review PUT same-id no-op merge: unchanged item keeps identical thread + status, no dupes', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  const item = { id: 'c3', kind: 'comment', by: 'alex', anchor: { quote: 'Title', occurrence: 0 },
    status: 'open', thread: [
      { by: 'alex', at: '2026-07-18T08:00:00Z', text: 'a' },
      { by: 'claude', at: '2026-07-18T08:01:00Z', text: 'b' }] };
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [item] } });
  // PUT the very same item again (normal single-writer save with no concurrent change).
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [item] } });
  const c3 = (await j(r)).review.items.find(i => i.id === 'c3');
  assert.equal(c3.status, 'open');
  assert.deepEqual(c3.thread, item.thread, 'thread changed on a no-op PUT (dupes or reorder)');
});

test('accept applies replacement at exact anchor and settles the card', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Closing paragraph.', occurrence: 0 }, replacement: 'Closing paragraph, improved.' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(md, /Closing paragraph, improved\./);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
});

test('accept with occurrence targets the right duplicate', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug2', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Repeated line here.', occurrence: 1 }, replacement: 'Second copy, replaced.' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug2' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const a = md.indexOf('Repeated line here.');       // first copy intact
  const b = md.indexOf('Second copy, replaced.');    // second copy replaced
  assert.ok(a !== -1 && b !== -1 && a < b, 'first stayed, second replaced');
});

// A visible-text quote MATCHES its marked-up source — that tolerance is the point, and comments rely
// on it. But it must not be SPLICED: the file has "**bold** text", so the quote "bold text" resolves to
// the raw span `bold** text`, which begins inside the bold run. Replacing it used to write
// "****bold** prose" — four asterisks, broken emphasis. This test asserted only /\*\*bold\*\* prose/,
// which the corrupted string also satisfies, so it passed for the whole time the bug existed.
test('tolerant anchor matches visible text, but accept refuses to splice a half-marked span', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug3', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'bold text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));

  // It still resolves — the matcher is unchanged.
  const Anchor = require('./public/anchor.js');
  assert.ok(Anchor.findNth(before, 'bold text', 0), 'visible-text quote still matches');

  const r = await post('/api/accept', { path: 'doc.md', id: 'sug3' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /unbalanced/);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before, 'file untouched');

  // Quoting the raw markdown gives a splice-safe span, and that applies cleanly.
  review.items.push({ id: 'sug3b', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: '**bold** text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r2 = await post('/api/accept', { path: 'doc.md', id: 'sug3b' });
  assert.equal(r2.status, 200);
  const after = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(after, /with \*\*bold\*\* prose and/);
  assert.ok(!/\*\*\*\*/.test(after), 'no doubled markers');
});

test('accept on a vanished anchor 409s and orphans the card, file untouched', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug4', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'THIS TEXT DOES NOT EXIST ANYWHERE', occurrence: 0 }, replacement: 'x' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug4' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug4').status, 'orphaned');
});

test('orphan detection is idempotent — repeated reads do not rewrite the sidecar (no reload storms)', async () => {
  await state(); // may legitimately write once (annotate pass)
  const p = path.join(dir, 'doc.md.sidecar.json');
  const m1 = fs.statSync(p).mtimeMs;
  await state(); await state(); await state();
  const m2 = fs.statSync(p).mtimeMs;
  assert.equal(m1, m2, 'sidecar rewritten on read with no changes');
});

test('reject settles without touching the file', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug5', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'item two', occurrence: 0 }, replacement: 'item 2' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/reject', { path: 'doc.md', id: 'sug5' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('format bold wraps the selection at its anchor', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item one', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /\*\*item one\*\*/);
});

test('format bold is a toggle — re-applying unwraps', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item one', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.doesNotMatch(md, /\*\*item one\*\*/);
  assert.match(md, /- item one/);
});

test('format link wraps the selection as a markdown link', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item two', occurrence: 0,
    op: 'link', url: 'https://example.org' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /\[item two\]\(https:\/\/example\.org\)/);
});

test('format occurrence targets the right duplicate', async () => {
  const s = await state();  // fixture is mutated by earlier tests — seed our own duplicate pair
  await put('/api/save', { path: 'doc.md', content: s.markdown + '\nDUPX marker.\n\nDUPX marker.\n', baseHash: s.hash });
  const r = await post('/api/format', { path: 'doc.md', quote: 'DUPX marker.', occurrence: 1, op: 'italic' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const first = md.indexOf('DUPX marker.');           // first copy still plain
  const second = md.indexOf('_DUPX marker._');         // second copy italicized
  assert.ok(first !== -1 && second !== -1 && first < second, 'first plain, second italic');
});

test('format on a vanished anchor 409s and leaves the file untouched', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await post('/api/format', { path: 'doc.md', quote: 'NO SUCH TEXT ANYWHERE', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('path traversal is refused with a JSON 4xx (not an HTML stack trace)', async () => {
  const r = await fetch(`${BASE}/api/state?path=${encodeURIComponent('../../../etc/passwd')}`);
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.match(r.headers.get('content-type') || '', /json/);
  assert.ok((await j(r)).error, 'error must be JSON');
});

test('path traversal via sibling-prefix dir is refused with a JSON 4xx', async () => {
  // BASE_DIR is `dir`; a sibling `dir + suffix` string-prefix-matches BASE_DIR but is a different tree.
  const rel = `../${path.basename(dir)}-evil/x.md`;
  const r = await fetch(`${BASE}/api/state?path=${encodeURIComponent(rel)}`);
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.match(r.headers.get('content-type') || '', /json/, 'error must be JSON, not an HTML stack trace');
  assert.ok((await j(r)).error, 'error must be JSON');
});

test('host allowlist: disallowed Host is 403, allowed host works', async () => {
  const bad = await rawGet('/api/files', 'evil.example.com');
  assert.equal(bad.status, 403);
  const good = await rawGet('/api/files', `127.0.0.1:${PORT}`);
  assert.equal(good.status, 200);
});

test('accept is guarded against double-apply: second accept 409s, no double mutation', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  const s = await state();
  // seed a unique target line whose anchor survives its own replacement (so a *missing* guard would re-splice)
  await put('/api/save', { path: 'doc.md', content: s.markdown + '\nA DBLX here.\n', baseHash: s.hash });
  const review = JSON.parse(fs.readFileSync(p, 'utf8'));
  review.items.push({ id: 'dbl1', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'DBLX', occurrence: 0 }, replacement: 'DBLX-done' });
  fs.writeFileSync(p, JSON.stringify(review));
  const r1 = await post('/api/accept', { path: 'doc.md', id: 'dbl1' });
  assert.equal(r1.status, 200);
  const r2 = await post('/api/accept', { path: 'doc.md', id: 'dbl1' });
  assert.equal(r2.status, 409);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(md, /DBLX-done/);
  assert.doesNotMatch(md, /DBLX-done-done/, 'replacement must be applied exactly once');
});

test('corrupt sidecar is surfaced, not silently clobbered by a review write', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  const good = fs.readFileSync(p, 'utf8');           // snapshot valid sidecar
  fs.writeFileSync(p, '{ not valid json ');           // corrupt it
  const r = await put('/api/review', { path: 'doc.md',
    review: { schema: 1, items: [{ id: 'x1', kind: 'comment', by: 'alex',
      anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  assert.notEqual(r.status, 200);                     // refused rather than overwriting a subset
  assert.equal(fs.readFileSync(p, 'utf8'), '{ not valid json ', 'corrupt sidecar left untouched');
  fs.writeFileSync(p, good);                          // restore for any later reads
});

test('review PUT rejects a non-word item id (stored-XSS guard)', async () => {
  const r = await put('/api/review', { path: 'doc.md',
    review: { schema: 1, items: [{ id: '<img src=x onerror=alert(1)>', kind: 'comment',
      anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  assert.equal(r.status, 400);
});

test('lexer round-trip: token.raw concatenation reconstructs the source (block-splice safety)', () => {
  const { marked } = require('marked');
  for (const src of [DOC, fs.readFileSync(path.join(dir, 'doc.md'), 'utf8')]) {
    const tokens = marked.lexer(src);
    const rebuilt = tokens.map(t => t.raw).join('');
    assert.equal(rebuilt, src, 'lexer raw does not reconstruct source — splicing would corrupt');
  }
});

// ---- client-side serialize round-trip (marked -> turndown) ----
// pageTd rebuilds the SAME TurndownService config the page constructs (escape off, GFM rules, tight-list).
// It's what index.html passes to serialize() and what the jsdom serialize tests below pass to the real
// public/serialize.js — one config, exercised by both the page and the tests.
function pageTd({ gfm = true } = {}) {
  const TurndownService = require('turndown');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-',
    codeBlockStyle: 'fenced', emDelimiter: '_', hr: '---' });
  td.escape = (s) => s;
  if (gfm) td.use(require('turndown-plugin-gfm').gfm);   // must run BEFORE the li rule, as index.html does
  td.addRule('tightList', {
    filter: 'li',
    replacement: (content, node) => {
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      const parent = node.parentNode;
      let prefix = '- ';
      if (parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const idx = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + idx : idx + 1) + '. ';
      }
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });
  return td;
}

// ---- shared anchor module (public/anchor.js): the SAME code the server requires and the browser
// loads via <script>. Requiring it here proves findNth/occurrenceAt agree with the server behaviour,
// which is what makes the client highlight and /api/accept resolve to the same occurrence. ----
const Anchor = require('./public/anchor.js');

test('shared matcher: soft-line-break quote resolves to the same span, and occurrence round-trips', () => {
  // "beta gamma" exists only across a soft newline — the old raw-byte matcher (no ws normalization)
  // would miss it entirely and orphan the card, while the client (which normalized) found it.
  const raw = 'alpha beta\ngamma delta. alpha beta\ngamma delta.';
  const h0 = Anchor.findNth(raw, 'beta gamma', 0);
  assert.ok(h0, 'soft-line-break quote must match (ws normalized)');
  assert.equal(raw.slice(h0.start, h0.end), 'beta\ngamma', 'span maps back to the exact raw bytes');
  // occurrenceAt is the inverse: a hit at that offset is occurrence 0; the second copy is occurrence 1.
  assert.equal(Anchor.occurrenceAt(raw, 'beta gamma', h0.start), 0);
  const h1 = Anchor.findNth(raw, 'beta gamma', 1);
  assert.ok(h1 && h1.start > h0.start, 'second copy is a distinct, later span');
  assert.equal(Anchor.occurrenceAt(raw, 'beta gamma', h1.start), 1, 'occurrenceAt round-trips findNth');
});

test('shared matcher: word-boundary quote does not anchor inside a longer word (M1)', () => {
  const raw = 'The category. My cat.';
  const hit = Anchor.findNth(raw, 'cat', 0);
  assert.ok(hit, 'must resolve');
  assert.equal(raw.slice(hit.start, hit.end), 'cat');
  assert.ok(hit.start > raw.indexOf('category'), 'anchored the standalone "cat", not the one in "category"');
  // A deliberately mid-word quote has no boundary-clean hit, so it falls back to the substring match.
  const midword = Anchor.findNth(raw, 'ategor', 0);
  assert.ok(midword && raw.slice(midword.start, midword.end) === 'ategor', 'mid-word quote still resolves');
});

test('shared matcher: occurrenceAt distinguishes duplicates within one block (M2)', () => {
  const raw = 'foo and foo';
  assert.equal(Anchor.occurrenceAt(raw, 'foo', 0), 0, 'first foo');
  assert.equal(Anchor.occurrenceAt(raw, 'foo', raw.lastIndexOf('foo')), 1, 'second foo');
});

test('gfm round-trip: table + task list + strikethrough all survive turndown', () => {
  const { marked } = require('marked');
  const md = [
    '| a | b |', '| - | - |', '| 1 | 2 |', '',
    '- [ ] todo one', '- [x] done two', '',
    'Some ~~struck~~ text.', '',
  ].join('\n');
  const back = pageTd().turndown(marked.parse(md));
  assert.match(back, /\|\s*1\s*\|\s*2\s*\|/, 'table row flattened — data loss');
  assert.match(back, /\[ \]/, 'unchecked task box lost');
  assert.match(back, /\[x\]/, 'checked task box lost');
  assert.match(back, /~+struck~+/, 'strikethrough stripped');
  // Guard: core turndown (no plugin) would flatten all three — proves the plugin is what saves them.
  const bare = pageTd({ gfm: false }).turndown(marked.parse(md));
  assert.doesNotMatch(bare, /\|\s*1\s*\|\s*2\s*\|/, 'baseline: bare turndown should flatten the table');
});

test('input-rule transforms serialize to the correct markdown (block round-trip target)', () => {
  // index.html's input rules rewrite a <p> into these elements in the DOM; save runs them back through
  // the SAME turndown config. This asserts each transformed element emits the marker we intend — so
  // typing `## Foo` saves `## Foo`, not `\#\# Foo` or a stray paragraph. (Caret behavior needs a browser.)
  const td = pageTd();
  assert.equal(td.turndown('<h1>Hello world</h1>'), '# Hello world');
  assert.equal(td.turndown('<h2>Foo</h2>'), '## Foo');
  assert.equal(td.turndown('<h3>Bar</h3>'), '### Bar');
  assert.equal(td.turndown('<ul><li>item</li></ul>'), '- item');
  assert.equal(td.turndown('<ol><li>first</li></ol>'), '1. first');
  assert.equal(td.turndown('<ol start="3"><li>third</li></ol>'), '3. third');   // `3. ` honored
  assert.equal(td.turndown('<blockquote><p>quote me</p></blockquote>'), '> quote me');
  assert.equal(td.turndown('<pre><code class="language-js">const x = 1;</code></pre>'), '```js\nconst x = 1;\n```');
  // inline: <strong>/<em>/<code> emit **…**/_…_/`…`
  assert.equal(td.turndown('<p>a <strong>bold</strong> b</p>'), 'a **bold** b');
  assert.equal(td.turndown('<p>a <em>ital</em> b</p>'), 'a _ital_ b');
  assert.equal(td.turndown('<p>a <code>snip</code> b</p>'), 'a `snip` b');
});

test('editing a paragraph adjacent to a table leaves the table intact (whole-doc turndown path)', () => {
  const { marked } = require('marked');
  // Worst case: the OLD destructive fallback re-serialized the ENTIRE doc through turndown on any
  // block-count change. Even down that path, the GFM rules must keep an untouched table byte-safe.
  const edited = [
    '# Title', '',
    'Intro paragraph EDITED with more words merged in.', '',
    '| col1 | col2 |', '| - | - |', '| x | y |', '',
    'Closing paragraph.', '',
  ].join('\n');
  const back = pageTd().turndown(marked.parse(edited));
  assert.match(back, /\|\s*x\s*\|\s*y\s*\|/, 'adjacent-edit flattened the untouched table');
  assert.match(back, /\|\s*col1\s*\|\s*col2\s*\|/, 'table header lost on adjacent edit');
  // Stable: a second pass must not progressively corrupt it.
  const twice = pageTd().turndown(marked.parse(back));
  assert.match(twice, /\|\s*x\s*\|\s*y\s*\|/, 'table degraded on re-serialize');
});

// ---- the REAL serialize() / reindex() / toMd() from public/serialize.js, under a jsdom #doc ----
// The tests above prove the turndown *config* is right; these prove the actual save-path logic in
// public/serialize.js — the tight-diff (untouched blocks emit token.raw verbatim) and the reworked
// non-destructive fallback (block-count change aligns surviving blocks by md0, never re-serializing an
// untouched one). We build a #doc + block model EXACTLY as index.html's renderDoc does, so this is the
// same code the browser runs, not a re-implementation.
const Serialize = require('./public/serialize.js');   // the SAME file index.html loads via <script>
const Flow = require('./public/flow.js');             // ditto — the ```flow renderer

// A multi-block fixture: headings, paragraphs, a GFM table (non-canonical spacing so a re-serialize
// would visibly differ from the raw), a nested list, and a fenced code block. Built as a byte-exact
// array join so the round-trip assertions can compare against these exact source bytes.
const RT_DOC = [
  '# Heading One', '',
  'Intro paragraph with **bold** text.', '',
  '## Heading Two', '',
  'A second paragraph here.', '',
  '- item one', '  - nested a', '  - nested b', '- item two', '',
  '| Name | Value |', '|------|-------|', '| x    | y     |', '',
  '```js', 'const x = 1;', '```', '',
  'Closing paragraph.', '',
].join('\n');
const TABLE_SRC = '| Name | Value |\n|------|-------|\n| x    | y     |';   // non-canonical: turndown would reflow this
const LIST_SRC = '- item one\n  - nested a\n  - nested b\n- item two';
const CODE_SRC = '```js\nconst x = 1;\n```';

// Build a live #doc DOM + block model from a markdown fixture EXACTLY as index.html's renderDoc does:
// lex → one .block div per non-space token (innerHTML = marked.parser of that single token, DOMPurify-
// scrubbed like the page), recording each block's md0 baseline via the real Serialize.toMd. Returns the
// doc element, the blocks array (space tokens included, matching renderDoc), and the shared td+marked —
// exactly the inputs serialize()/reindex() take.
function buildDoc(md) {
  const { marked } = require('marked');
  const { window } = new JSDOM('<!doctype html><div id="doc"></div>');
  const DOMPurify = require('dompurify')(window);
  const doc = window.document.getElementById('doc');
  const td = pageTd();
  const renderMd = (tokens) => DOMPurify.sanitize(marked.parser(tokens));
  const tokens = marked.lexer(md);
  const blocks = []; let off = 0;
  for (const t of tokens) { const start = off; off += t.raw.length; blocks.push({ token: t, start, end: off }); }
  blocks.forEach((b, i) => {
    if (b.token.type === 'space') return;
    const el = window.document.createElement('div');
    el.className = 'block'; el.dataset.i = i;
    // renderDoc's atomic branch, mirrored: a ```flow fence and a raw-HTML block become uneditable
    // islands whose md0 is the ORIGINAL markdown, so they never reach turndown. Kept in step with the
    // page on purpose — a helper that skipped this would test a document shape the browser never builds.
    const isFlow = b.token.type === 'code' && (b.token.lang || '').trim().toLowerCase() === 'flow';
    if (isFlow || b.token.type === 'html') {
      el.innerHTML = isFlow ? Flow.render(b.token.text || '').svg : DOMPurify.sanitize(b.token.raw);
      if (isFlow) el.__flowNodes = Flow.render(b.token.text || '').nodes;
      el.dataset.atomic = '1';
      el.contentEditable = 'false';
      el.__md = b.token.raw.trim();
      b.md0 = el.__md;
      doc.appendChild(el);
      return;
    }
    el.innerHTML = renderMd([b.token]);
    doc.appendChild(el);
    b.md0 = Serialize.toMd(el, td);
  });
  return { window, doc, blocks, td, marked };
}
const blockByText = (doc, txt) => [...doc.querySelectorAll('.block')].find(el => el.textContent.trim() === txt);

test('serialize full round-trip: an unedited doc serializes byte-identically to the source', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'no block changed → tight path');
  assert.equal(md, RT_DOC, 'untouched doc must round-trip byte-for-byte (token.raw concat, through real serialize())');
});

test('serialize tight path: editing one paragraph changes only that block, every other stays byte-identical', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  const target = blockByText(doc, 'A second paragraph here.');
  assert.ok(target, 'fixture must contain the target paragraph');
  target.querySelector('p').textContent = 'A second paragraph here, now edited.';   // as contenteditable typing would
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'block count unchanged → tight path');
  // The ONLY byte difference across the whole doc is inside the edited block; every other block and the
  // inter-block gaps are emitted from token.raw verbatim. Asserting exact equality proves that.
  assert.equal(md, RT_DOC.replace('A second paragraph here.', 'A second paragraph here, now edited.'));
  // Spell the survivors out for regression clarity (the table's non-canonical spacing proves raw-emission).
  assert.ok(md.includes(TABLE_SRC), 'table survived byte-for-byte');
  assert.ok(md.includes(LIST_SRC), 'nested list survived byte-for-byte');
  assert.ok(md.includes(CODE_SRC), 'fenced code survived byte-for-byte');
  assert.ok(md.includes('now edited.'), 'the edit landed');
});

test('serialize structural fallback is non-destructive: an untouched table + nested list survive a block-count change', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  // Remove a whole block (the closing paragraph) so els.length !== rendered.length → the FALLBACK path.
  // This is the reported data-loss scenario: the old fallback re-ran every block (incl. the untouched
  // table three blocks away) through turndown. Lock the fix — surviving blocks emit their exact bytes.
  blockByText(doc, 'Closing paragraph.').remove();
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, false, 'block count changed → fallback path');
  assert.ok(md.includes(TABLE_SRC), 'untouched table must survive byte-for-byte (the data-loss bug)');
  assert.ok(md.includes(LIST_SRC), 'untouched nested list must survive byte-for-byte');
  assert.ok(md.includes(CODE_SRC), 'untouched fenced code must survive byte-for-byte');
  assert.ok(!md.includes('Closing paragraph.'), 'the removed block is gone');
});

test('reindex refreshes baselines after a tight save so the next diff measures against current state', () => {
  const { doc, blocks, td, marked } = buildDoc(RT_DOC);
  blockByText(doc, 'A second paragraph here.').querySelector('p').textContent = 'A second paragraph here, now edited.';
  const { md } = Serialize.serialize(doc, blocks, td);
  const next = Serialize.reindex(doc, blocks, md, marked, td);
  assert.equal(next.filter(b => b.token.type !== 'space').length,
    [...doc.querySelectorAll('.block')].length, 'reindex keeps one non-space block per element');
  // With baselines refreshed, re-serializing the same (unchanged) DOM is a no-op that reproduces `md`.
  const again = Serialize.serialize(doc, next, td);
  assert.equal(again.md, md, 'after reindex the edited block reads as untouched → emits its new raw');
  assert.equal(again.tight, true);
});

// ---------- P1: turn/session, threaded suggestions, the wait loop ----------

test('review PUT preserves top-level session — last-writer-wins by `at` (no regress of a decision)', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
  const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
  cur.session = { state: 'idle', at: '2026-07-19T03:00:00Z', done: true };   // a fresh decision on disk
  fs.writeFileSync(p, JSON.stringify(cur));
  // a STALE client PUT (older session.at) echoes back the whole review — must not regress done:true.
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1,
    session: { state: 'watching', at: '2026-07-19T02:00:00Z', done: false },
    items: [{ id: 'sess-c', kind: 'comment', by: 'alex', anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  const b1 = await j(r);
  assert.equal(b1.review.session.done, true, 'older client session cannot regress a newer done');
  assert.equal(b1.review.session.at, '2026-07-19T03:00:00Z');
  // a FRESHER client PUT (newer at) wins.
  const r2 = await put('/api/review', { path: 'doc.md', review: { schema: 1,
    session: { state: 'watching', at: '2026-07-19T04:00:00Z', done: false }, items: [] } });
  const b2 = await j(r2);
  assert.equal(b2.review.session.at, '2026-07-19T04:00:00Z', 'newer session wins');
  assert.equal(b2.review.session.done, false);
});

test('accept of a replyTo suggestion applies the edit AND resolves its parent comment', async () => {
  // Hermetic: its own file so it can't collide with the shared doc's accumulated edits.
  const f = path.join(dir, 'replydoc.md');
  fs.writeFileSync(f, '# R\n\nRESOLVEME target line.\n');
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'par1', kind: 'comment', by: 'alex', status: 'open', anchor: { quote: 'RESOLVEME target line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T05:00:00Z', text: 'rewrite this' }] },
    { id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending', replyTo: 'par1',
      anchor: { quote: 'RESOLVEME target line.', occurrence: 0 }, replacement: 'RESOLVED replacement line.' }] }));
  const r = await post('/api/accept', { path: 'replydoc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(f + '.sidecar.json', 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
  assert.equal(after.items.find(i => i.id === 'par1').status, 'resolved', 'parent comment resolves on accept');
  assert.match(fs.readFileSync(f, 'utf8'), /RESOLVED replacement line\./);
});

test('sidecar wait wakes on a new alex comment and exits 0 with a digest', async () => {
  const wf = path.join(dir, 'waitdoc.md');
  fs.writeFileSync(wf, '# W\n\nSome content here.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at a dead port so the best-effort presence ping just errors out harmlessly.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'wc1', kind: 'comment', by: 'alex', anchor: { quote: 'Some content here.', occurrence: 0 }, status: 'open',
      thread: [{ by: 'alex', at: '2026-07-19T06:00:00Z', text: 'MAKE-IT-CONCRETE' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 once Alex acts');
  assert.match(out, /your turn/);
  assert.match(out, /MAKE-IT-CONCRETE/, 'digest names the new comment');
  assert.match(out, /DONE: false/);
});

test('sidecar wait --timeout exits non-zero when nothing happens', async () => {
  const wf = path.join(dir, 'waitdoc2.md');
  fs.writeFileSync(wf, '# W2\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '1'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 1, 'timeout exits non-zero');
  assert.match(out, /still watching/);
});

// ---------- flag action: a comment carrying `flag: true` ("look here") ----------
// sidecar stores and surfaces the flag; it never interprets the anchored text. These tests assert exactly
// that scope: the flag round-trips, the digest calls it out, and everything else (threading, resolution,
// orphaning) behaves like the ordinary comment it is. (The retired `run` concept was tested here before.)

test('flag item round-trips through review PUT with flag:true intact', async () => {
  const f = path.join(dir, 'flagdoc.md');
  fs.writeFileSync(f, '# Flag\n\nDo the thing on this line.\n');
  const item = { id: 'r1', kind: 'comment', by: 'alex', flag: true, status: 'open',
    anchor: { quote: 'Do the thing on this line.', occurrence: 0 },
    thread: [{ by: 'alex', at: '2026-07-19T07:00:00Z', text: '🚩 Flagged for review.' }] };
  const r = await put('/api/review', { path: 'flagdoc.md', review: { schema: 1, items: [item] } });
  assert.equal(r.status, 200);
  const stored = (await j(r)).review.items.find(i => i.id === 'r1');
  assert.equal(stored.flag, true, 'flag must survive the merge');
  assert.equal(stored.kind, 'comment', 'flag is a comment — no new kind');
  assert.equal(stored.status, 'open');
});

test('sidecar wait digests a flag as a NEW flag line, distinct from a plain comment', async () => {
  const wf = path.join(dir, 'flagwait.md');
  fs.writeFileSync(wf, '# RW\n\nShip the newsletter draft.\n\nSome other prose.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rw1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Ship the newsletter draft.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T07:10:00Z', text: '🚩 Flagged for review.' }] },
    { id: 'rw2', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Some other prose.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T07:10:00Z', text: 'JUST-DISCUSSING' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /- NEW flag @ “Ship the newsletter draft\.”: 🚩 Flagged for review\./, 'a flag gets a NEW flag line');
  assert.match(out, /- NEW comment @ “Some other prose\.”: JUST-DISCUSSING/, 'a plain comment stays a NEW comment line');
});

test('agent reply threads into a flag item like any comment', async () => {
  const f = path.join(dir, 'flagthread.md');
  fs.writeFileSync(f, '# RT\n\nRebuild the index page.\n');
  const anchor = { quote: 'Rebuild the index page.', occurrence: 0 };
  const alexMsg = { by: 'alex', at: '2026-07-19T08:00:00Z', text: '🚩 Flagged for review.' };
  await put('/api/review', { path: 'flagthread.md', review: { schema: 1, items: [
    { id: 'rt1', kind: 'comment', by: 'alex', flag: true, status: 'open', anchor, thread: [alexMsg] }] } });
  // the agent answers in-thread (its own read-modify-write of the sidecar, as AGENTS.md prescribes)
  const p = path.join(dir, 'flagthread.md.sidecar.json');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  onDisk.items.find(i => i.id === 'rt1').thread.push(
    { by: 'claude', at: '2026-07-19T08:05:00Z', text: 'Done — rebuilt and pushed.' });
  fs.writeFileSync(p, JSON.stringify(onDisk));
  // a stale client PUT (pre-reply copy) must neither drop the answer nor the flag
  const r = await put('/api/review', { path: 'flagthread.md', review: { schema: 1, items: [
    { id: 'rt1', kind: 'comment', by: 'alex', flag: true, status: 'open', anchor, thread: [alexMsg] }] } });
  const rt1 = (await j(r)).review.items.find(i => i.id === 'rt1');
  assert.equal(rt1.flag, true);
  assert.deepEqual(rt1.thread.map(m => m.by), ['alex', 'claude'], 'agent reply survives, in order');
});

test('flag item resolves like a comment (reject settles it, file untouched)', async () => {
  const f = path.join(dir, 'flagresolve.md');
  fs.writeFileSync(f, '# RR\n\nArchive the old posts.\n');
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rr1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Archive the old posts.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T09:00:00Z', text: '🚩 Flagged for review.' }] }] }));
  const before = fs.readFileSync(f, 'utf8');
  const r = await post('/api/reject', { path: 'flagresolve.md', id: 'rr1' });
  assert.equal(r.status, 200);
  const rr1 = JSON.parse(fs.readFileSync(f + '.sidecar.json', 'utf8')).items.find(i => i.id === 'rr1');
  assert.equal(rr1.status, 'resolved', 'a flag comment resolves, it does not "reject"');
  assert.ok(rr1.decidedAt);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'settling a flag never touches the doc');
});

test('flag item orphans when its anchored text changes', async () => {
  const f = path.join(dir, 'flagorphan.md');
  fs.writeFileSync(f, '# RO\n\nPublish the RUNANCHOR line.\n');
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'ro1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Publish the RUNANCHOR line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T10:00:00Z', text: '🚩 Flagged for review.' }] }] }));
  const s = await fetch(`${BASE}/api/state?path=flagorphan.md`).then(j);
  assert.equal(s.review.items.find(i => i.id === 'ro1').status, 'open', 'anchored text is present → open');
  await put('/api/save', { path: 'flagorphan.md', content: '# RO\n\nThe line went away.\n', baseHash: s.hash });
  const after = await fetch(`${BASE}/api/state?path=flagorphan.md`).then(j);
  const ro1 = after.review.items.find(i => i.id === 'ro1');
  assert.equal(ro1.status, 'orphaned', 'a flag whose anchor vanished must orphan like any item');
  assert.equal(ro1.anchor.quote, 'Publish the RUNANCHOR line.', 'original quote preserved, never re-pointed');
  assert.equal(ro1.flag, true, 'still a flag while orphaned');
});

test('presence: watching/working surface in /api/state; idle reads as not-here', async () => {
  await post('/api/presence', { path: 'doc.md', state: 'watching' });
  assert.equal((await state()).presence?.state, 'watching');
  await post('/api/presence', { path: 'doc.md', state: 'working' });
  assert.equal((await state()).presence?.state, 'working');
  await post('/api/presence', { path: 'doc.md', state: 'idle' });
  assert.equal((await state()).presence, null, 'idle presence reads as not-here');
});

test('presence keys by realpath — a ping via a symlinked path surfaces on the real path', async () => {
  // The same file reached two ways (an alias symlink, mirroring /tmp vs /private/tmp on macOS): the
  // ping arrives via the alias, the browser reads via the real name. Without realpath-keying they land
  // in different buckets and the dot silently never lights.
  const alias = path.join(dir, 'aliasdoc.md');
  fs.symlinkSync(path.join(dir, 'doc.md'), alias);
  try {
    const r = await post('/api/presence', { path: 'aliasdoc.md', state: 'watching' });
    assert.equal((await r.json()).ok, true);
    const s = await state();   // reads ?path=doc.md — the real file
    assert.ok(s.presence, 'a ping via the symlinked alias must surface when reading the real path');
    assert.equal(s.presence.state, 'watching');
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle' });   // leave presence clean for later reads
    fs.rmSync(alias, { force: true });
  }
});

test('presence is per-agent: items merge, working outranks a later watching, one agent cannot clear another', async () => {
  try {
    // Agent a1 exits its wait holding two threads.
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'a1', items: ['t1', 't2'] });
    let p = (await state()).presence;
    assert.equal(p.state, 'working');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['t1', 't2']);
    assert.equal(p.items[0].agent, 'a1', 'each mark names the agent that holds it');
    assert.ok(p.until > Date.now(), 'readout carries its staleness horizon');
    // Agent b2's watching heartbeat lands AFTER a1's working ping: the header must not flap and
    // a1's marks must survive — the case the per-file store got wrong by construction.
    await post('/api/presence', { path: 'doc.md', state: 'watching', agent: 'b2', items: [] });
    p = (await state()).presence;
    assert.equal(p.state, 'working', 'working outranks a more recent watching');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['t1', 't2'], "b2's empty heartbeat must not clear a1's marks");
    // a1 re-arms its wait (watching, empty-handed): its own marks clear, header falls back to watching.
    await post('/api/presence', { path: 'doc.md', state: 'watching', agent: 'a1', items: [] });
    p = (await state()).presence;
    assert.equal(p.state, 'watching');
    assert.deepEqual(p.items, [], "the agent's next ping with an explicit empty list clears the mark");
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'a1' });
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'b2' });
  }
});

test('presence: an ABSENT items field keeps the marks and refreshes the clock; an empty array clears', async () => {
  // The distinction the CLI re-ping rides on. A working record has no heartbeat, so a five-minute reply
  // used to outlive its own marks; a write verb pings with no `items` at all, which must read as "still
  // here, leave my threads alone" rather than as the clear an empty list means.
  try {
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1', items: ['t9'] });
    const first = (await state()).presence.until;
    await new Promise((r) => setTimeout(r, 20));   // so a refreshed `at` is visibly later
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1' });   // items ABSENT
    let p = (await state()).presence;
    assert.deepEqual(p.items.map(x => x.id), ['t9'], 'an absent items field keeps what the agent already holds');
    assert.ok(p.until > first, 'and pushes the staleness horizon out, which is the whole point');
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1', items: [] });
    p = (await state()).presence;
    assert.deepEqual(p.items, [], 'an explicit empty array is still the authoritative clear');
    // First contact with no items field creates the record empty-handed rather than failing.
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w2' });
    p = (await state()).presence;
    assert.equal(p.state, 'working');
    assert.deepEqual(p.items, [], 'a first ping with no items field holds nothing');
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'w1' });
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'w2' });
  }
});

test('a CLI write verb re-pings presence: the clock moves, the marks it did not set survive', async () => {
  const f = path.join(dir, 'clipres.md');
  fs.writeFileSync(f, '# CP\n\nThe line the agent will comment on.\n');
  const read = () => fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('clipres.md')).then(j);
  try {
    // Stand in for the wait exit: this agent came out of its wait holding two threads.
    await post('/api/presence', { path: 'clipres.md', state: 'working', agent: 'cliwriter', items: ['h1', 'h2'] });
    const first = (await read()).presence.until;
    await new Promise((r) => setTimeout(r, 20));
    // SIDECAR_PORT points at the REAL test server, so the write verb's ping lands where /api/state reads.
    execFileSync('node', [path.join(__dirname, 'server.js'), 'comment', 'clipres.md',
      '--quote', 'The line the agent will comment on.', '--text', 'still composing'],
      { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'cliwriter' } });
    const p = (await read()).presence;
    assert.equal(p.state, 'working', 'the write says the agent is still on this document');
    assert.ok(p.until > first, 'a write verb pushes the working window out');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['h1', 'h2'],
      'the threads still in hand keep their marks — the write verb never declares items');
  } finally {
    await post('/api/presence', { path: 'clipres.md', state: 'idle', agent: 'cliwriter' });
    fs.rmSync(f + '.sidecar.json', { force: true });
    fs.rmSync(f, { force: true });
  }
});

test('wait exit ping carries the woken item ids — news and replies mark, a decided item does not', async () => {
  const wf = path.join(dir, 'waitpres.md');
  fs.writeFileSync(wf, '# WP\n\nPresence target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at the REAL test server, so the exit ping lands where /api/state can read it.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'pwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'pc1', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Presence target line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-08-12T12:00:00Z', text: 'mark me' }] },
    { id: 'ps1', kind: 'suggestion', by: 'pwaiter', status: 'accepted',
      anchor: { quote: 'Presence target line.', occurrence: 0 }, replacement: 'x' }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 once Alex acts');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitpres.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items.map(x => x.id), ['pc1'],
    'only the new comment marks — the decided suggestion gets no "replying" light');
  assert.equal(s.presence.items[0].agent, 'pwaiter');
});

// A rejection carrying a reason is the one decided status that gets an answer: the reason says what to
// try instead, so the agent goes off to compose a retry and the card should say so. The board showed
// nothing through that whole window until the decided category started marking.
test('wait exit ping marks a rejection that carries a reason', async () => {
  const wf = path.join(dir, 'waitreject.md');
  fs.writeFileSync(wf, '# WR\n\nReject target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rs1', kind: 'suggestion', by: 'rwaiter', status: 'pending',
      anchor: { quote: 'Reject target line.', occurrence: 0 }, replacement: 'Rewritten target line.' }] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'rwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rs1', kind: 'suggestion', by: 'rwaiter', status: 'rejected', decidedAt: '2026-08-13T00:00:00Z',
      anchor: { quote: 'Reject target line.', occurrence: 0 }, replacement: 'Rewritten target line.',
      thread: [{ by: 'alex', at: '2026-08-13T00:00:01Z', text: 'wrong tense, try the imperative' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 on the decision');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitreject.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items.map(x => x.id), ['rs1'],
    'a reasoned rejection marks the card, because a retry is coming');
});

// The other half of the rule. "Just no" usually ends the thread, so a light promising a reply would be
// lying, and a lying status light is worse than a dark one.
test('wait exit ping leaves a bare rejection dark', async () => {
  const wf = path.join(dir, 'waitbare.md');
  fs.writeFileSync(wf, '# WB\n\nBare target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'bs1', kind: 'suggestion', by: 'bwaiter', status: 'pending',
      anchor: { quote: 'Bare target line.', occurrence: 0 }, replacement: 'Rewritten bare line.' }] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'bwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'bs1', kind: 'suggestion', by: 'bwaiter', status: 'rejected', decidedAt: '2026-08-13T00:00:00Z',
      anchor: { quote: 'Bare target line.', occurrence: 0 }, replacement: 'Rewritten bare line.' }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'the rejection still wakes the wait');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitbare.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items, [], 'a rejection with no reason marks nothing');
});

test('SIDECAR_USER / SIDECAR_AGENT are surfaced in /api/state (default and override)', async () => {
  const boot = (env) => new Promise((res, rej) => {
    const p = spawn('node', [path.join(__dirname, 'server.js'), dir], { env, stdio: 'pipe' });
    p.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(p); });
    p.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
  const read = (port) => fetch(`http://127.0.0.1:${port}/api/state?path=doc.md`).then(j);

  // default: no env set → user 'you', agent 'claude'
  const defEnv = { ...process.env }; delete defEnv.SIDECAR_USER; delete defEnv.SIDECAR_AGENT;
  const p1 = await boot({ ...defEnv, SIDECAR_PORT: String(PORT + 11) });
  try {
    const s = await read(PORT + 11);
    assert.equal(s.user, 'you', 'default human name is "you"');
    assert.equal(s.agent, 'claude', 'default agent name is "claude"');
  } finally { p1.kill(); }

  // override: SIDECAR_USER=pat, SIDECAR_AGENT=robo
  const p2 = await boot({ ...process.env, SIDECAR_PORT: String(PORT + 12), SIDECAR_USER: 'pat', SIDECAR_AGENT: 'robo' });
  try {
    const s = await read(PORT + 12);
    assert.equal(s.user, 'pat', 'SIDECAR_USER overrides the human name in /api/state');
    assert.equal(s.agent, 'robo', 'SIDECAR_AGENT is surfaced too');
  } finally { p2.kill(); }
});

/* ---------------------------------------------------------------------------
   CLI — `sidecar <verb> <file>` (lib/cli.js)

   These run the real binary against a real temp repo with NO SERVER RUNNING, which is the point:
   the filesystem is the sync layer, and the agent's whole interface has to work without one.
   --------------------------------------------------------------------------- */

const CLI_DOC = `# Plan

We will ship all six features in week one.

Success metrics are not defined yet.

1. **Read** the sidecar.
2. **Merge** by id.
3. **Write** it back.

Repeated line here.

Repeated line here.
`;

function cliDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cli-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: d });
  return d;
}
const BIN = path.join(__dirname, 'server.js');
const cli = (d, ...args) => execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const cliStdin = (d, input, ...args) => execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', input });
// Returns the error (with .status and .stderr) instead of throwing, for the refusal paths.
function cliFails(d, ...args) {
  try { execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); return null; }
  catch (e) { return e; }
}
// Same, but feeds stdin — for the `add` refusal paths, which take a JSON payload on stdin.
function cliFailsStdin(d, input, ...args) {
  try { execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }); return null; }
  catch (e) { return e; }
}
const sc = (d) => JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));

test('CLI comment: flat input expands to a full item — id, by, at, status, nested anchor', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'No targets yet?');
  const [it] = sc(d).items;
  assert.equal(it.kind, 'comment');
  assert.equal(it.by, 'claude');
  assert.equal(it.status, 'open');
  assert.equal(it.anchor.quote, 'Success metrics');
  assert.equal(it.anchor.occurrence, 0);
  assert.equal(it.thread.length, 1);
  assert.equal(it.thread[0].text, 'No targets yet?');
  // The agent never writes `at` — a guessed timestamp once put a reply above the comment it answered.
  assert.ok(!Number.isNaN(Date.parse(it.thread[0].at)), 'at is a real timestamp');
  assert.match(it.id, /^[\w-]+$/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI suggest: card carries replacement + note, status pending', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.',
       '--replacement', 'Week one ships three.', '--note', 'Overcommit.');
  const [it] = sc(d).items;
  assert.equal(it.kind, 'suggestion');
  assert.equal(it.status, 'pending');
  assert.equal(it.replacement, 'Week one ships three.');
  assert.equal(it.note, 'Overcommit.');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses a quote that matches nothing, and writes NOTHING', () => {
  const d = cliDir();
  const e = cliFails(d, 'comment', 'doc.md', '--quote', 'text that is absent', '--text', 'x');
  assert.ok(e, 'command should fail');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /matched nothing/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'no sidecar written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses an ambiguous quote and names the occurrence range', () => {
  const d = cliDir();
  const e = cliFails(d, 'comment', 'doc.md', '--quote', 'Repeated line here.', '--text', 'x');
  assert.ok(e);
  assert.match(e.stderr, /ambiguous — 2 matches/);
  assert.match(e.stderr, /--occurrence 0\.\.1/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI --occurrence disambiguates and is recorded', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Repeated line here.', '--occurrence', '1', '--text', 'the second one');
  assert.equal(sc(d).items[0].anchor.occurrence, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI add: batch seeding, kind inferred from the presence of a replacement', () => {
  const d = cliDir();
  cliStdin(d, JSON.stringify([
    { quote: 'Success metrics', text: 'No targets?' },
    { quote: 'We will ship all six features in week one.', replacement: 'Week one ships three.' },
  ]), 'add', 'doc.md');
  const items = sc(d).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'comment');
  assert.equal(items[1].kind, 'suggestion');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI write merges — a human item and their thread reply survive an agent write', () => {
  const d = cliDir();
  // Human's comment lands first (as the browser would write it).
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', anchor: { quote: 'Success metrics' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'what about these?' }] },
  ] }, null, 2));
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  const items = sc(d).items;
  assert.equal(items.length, 2);
  const human = items.find(i => i.id === 'c-human');
  assert.equal(human.by, 'alex');
  assert.equal(human.thread[0].text, 'what about these?');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI reply appends to a thread without disturbing earlier messages; --resolve settles it', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'first');
  const id = sc(d).items[0].id;
  cli(d, 'reply', 'doc.md', id, 'second');
  assert.deepEqual(sc(d).items[0].thread.map(m => m.text), ['first', 'second']);
  cli(d, 'reply', 'doc.md', id, 'third', '--resolve');
  const it = sc(d).items[0];
  assert.deepEqual(it.thread.map(m => m.text), ['first', 'second', 'third']);
  assert.equal(it.status, 'resolved');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI answer inherits the parent anchor and sets replyTo', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'make this concrete');
  const parent = sc(d).items[0];
  cli(d, 'answer', 'doc.md', parent.id, '--replacement', 'Target: 200 signups.');
  const card = sc(d).items.find(i => i.kind === 'suggestion');
  assert.equal(card.replyTo, parent.id);
  assert.deepEqual(card.anchor, parent.anchor, 'anchor is inherited, not re-specified');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI drop refuses an item owned by someone else, removes its own', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', anchor: { quote: 'Success metrics' }, status: 'open', thread: [] },
  ] }, null, 2));
  const e = cliFails(d, 'drop', 'doc.md', 'c-human');
  assert.ok(e, 'should refuse');
  assert.match(e.stderr, /belongs to "alex"/);
  assert.equal(sc(d).items.length, 1, 'nothing removed');

  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'mine');
  const mine = sc(d).items.find(i => i.by === 'claude');
  cli(d, 'drop', 'doc.md', mine.id);
  assert.deepEqual(sc(d).items.map(i => i.id), ['c-human']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI reanchor repoints an orphan back onto live text', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  const id = sc(d).items[0].id;
  // Human edits the anchored text away.
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('Success metrics', 'Outcome measures'));
  cli(d, 'show', 'doc.md');                       // show runs annotateOrphans, as /api/state does
  assert.equal(sc(d).items[0].status, 'orphaned');
  cli(d, 'reanchor', 'doc.md', id, '--quote', 'Outcome measures');
  const it = sc(d).items[0];
  assert.equal(it.status, 'open');
  assert.equal(it.anchor.quote, 'Outcome measures');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI show --needs-reply selects only threads whose last word is the human’s', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'mine, awaiting them');
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    ...sc(d).items,
    { id: 'c-theirs', kind: 'comment', by: 'alex', anchor: { quote: 'week one' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'answer me' }] },
  ] }, null, 2));
  const out = cli(d, 'show', 'doc.md', '--needs-reply');
  assert.match(out, /c-theirs/);
  assert.ok(!/awaiting them/.test(out), 'the agent’s own unanswered comment is not "needs reply"');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI show reports full state and the done flag', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  const out = cli(d, 'show', 'doc.md');
  assert.match(out, /1 item/);
  assert.match(out, /DONE: false/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI check --quote pre-flights a candidate and bisects a failure', () => {
  const d = cliDir();
  const ok = cli(d, 'check', 'doc.md', '--quote', 'Success metrics');
  assert.match(ok, /unambiguous/);
  const e = cliFails(d, 'check', 'doc.md', '--quote', 'Success metrics are measured in bananas');
  assert.ok(e);
  assert.match(e.stderr, /longest matching prefix/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI check (bare) lints every anchor and fails when one cannot resolve', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  assert.match(cli(d, 'check', 'doc.md'), /^ok /m);
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('Success metrics', 'Outcome measures'));
  const e = cliFails(d, 'check', 'doc.md');
  assert.ok(e);
  assert.match(e.stderr, /cannot resolve/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI rejects an unknown flag rather than silently writing a malformed item', () => {
  const d = cliDir();
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacment', 'typo');
  assert.ok(e);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /unknown flag --replacment/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI fails loudly on a path that does not resolve (never silently addresses nothing)', () => {
  const d = cliDir();
  const e = cliFails(d, 'show', 'nope.md');
  assert.ok(e);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /no file at/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('anchor: a quote spanning two list items matches (block markers are not rendered text)', () => {
  const Anchor = require('./public/anchor.js');
  const raw = '1. **Read** the sidecar.\n2. **Merge** by id.';
  assert.equal(Anchor.findAll(raw, 'Read the sidecar. Merge by id.').length, 1);
  assert.equal(Anchor.findAll('## Heading\n\nBody text', 'Heading Body text').length, 1);
  assert.equal(Anchor.findAll('- alpha\n- beta', 'alpha beta').length, 1);
  assert.equal(Anchor.findAll('> quoted\n> second', 'quoted second').length, 1);
  // Precision must not regress: these are not line-start block markers.
  assert.equal(Anchor.findAll('a well-known thing', 'well-known').length, 1);
  assert.equal(Anchor.findAll('see section 2. it says', 'section 2. it says').length, 1);
});

test('orphan reason distinguishes never-matched from text-changed', () => {
  const { annotateOrphans } = require('./lib/review.js');
  const raw = 'Alpha beta gamma.';
  const born_bad = { items: [{ id: 'x', kind: 'comment', status: 'open', anchor: { quote: 'nowhere in here' } }] };
  annotateOrphans(raw, born_bad);
  assert.equal(born_bad.items[0].orphanReason, 'never-matched');

  const was_good = { items: [{ id: 'y', kind: 'comment', status: 'open', anchor: { quote: 'Alpha' } }] };
  annotateOrphans(raw, was_good);                       // resolves → stamps matchedAt
  assert.equal(was_good.items[0].status, 'open');
  annotateOrphans('Delta epsilon.', was_good);          // human edits it away
  assert.equal(was_good.items[0].status, 'orphaned');
  assert.equal(was_good.items[0].orphanReason, 'text-changed');
});

test('a CLI write and a browser PUT each survive the other (sequential, not racing)', async () => {
  // The CLI merges in-process; the server merges on PUT. Both go through lib/review.js mergeItem, so
  // an interleaved pair ends with both items present. NOTE this is sequential by construction — it
  // proves merge-on-load, NOT concurrency. Both writers are unlocked read-modify-write, so genuinely
  // simultaneous writes can still lose an item; that window is one synchronous tick and predates the
  // CLI. Don't read this test as covering it.
  fs.writeFileSync(path.join(dir, 'concurrent.md'), 'Alpha line.\n\nBeta line.\n');
  execFileSync('node', [BIN, 'comment', 'concurrent.md', '--quote', 'Alpha line.', '--text', 'from the CLI'],
    { cwd: dir, encoding: 'utf8' });
  await put('/api/review', { path: 'concurrent.md', review: { schema: 1, items: [
    { id: 'c-browser', kind: 'comment', by: 'alex', anchor: { quote: 'Beta line.' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'from the browser' }] },
  ] } });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'concurrent.md.sidecar.json'), 'utf8'));
  const texts = after.items.flatMap(i => (i.thread || []).map(m => m.text));
  assert.ok(texts.includes('from the CLI'), 'CLI item survived the browser PUT');
  assert.ok(texts.includes('from the browser'), 'browser item survived');
});

/* ---------------------------------------------------------------------------
   Splice safety — the gap an audit of 0fda7d2 found.

   Making the matcher block-tolerant (so a quote taken from the rendered document can span list items)
   silently widened what `accept` would SPLICE. A suggestion quoting across two list items resolved to
   a raw span starting inside `**` and swallowing the `2. `, so accepting wrote corrupted markdown that
   the word-diff never showed. Match loosely, splice strictly.
   --------------------------------------------------------------------------- */

test('spliceRisk: rejects spans that cross block structure, allows ordinary ones', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const list = '1. **Read** the sidecar.\n2. **Merge** by id.\n';
  const hit = Anchor.findNth(list, 'Read the sidecar. Merge by id.', 0);
  assert.ok(hit, 'the matcher still finds it (comments need that)');
  assert.match(spliceRisk(list, hit.start, hit.end), /crosses a block boundary/);

  // A soft line break inside one paragraph stays splice-safe — that has always been supported.
  const para = 'One sentence that\nwraps softly here.\n';
  const soft = Anchor.findNth(para, 'sentence that wraps softly', 0);
  assert.equal(spliceRisk(para, soft.start, soft.end), null);

  // Balanced inline markup inside the span is fine; a span ending mid-`**` is not.
  const bold = 'Some **bold text** here.\n';
  const whole = Anchor.findNth(bold, '**bold text**', 0);
  assert.equal(spliceRisk(bold, whole.start, whole.end), null);
  assert.match(spliceRisk(bold, bold.indexOf('bold'), bold.indexOf(' here')), /unbalanced/);

  // Crossing a blank line is two blocks.
  const two = 'Alpha para.\n\nBeta para.\n';
  const across = Anchor.findNth(two, 'Alpha para. Beta para.', 0);
  assert.match(spliceRisk(two, across.start, across.end), /blank line/);
});

/* `2)` opens an ordered list exactly as `2.` does, and CommonMark treats the delimiter as part of the
   list's identity. replacementRisk was widened to `\d{1,9}[.)]` in fda64d8 and spliceRisk was left
   matching `\d+\.`, so a span that swallowed a `2)` marker read as safe and accept would have written
   the same destroyed list the `2.` case exists to prevent. */
test('spliceRisk: a span crossing a `2)` ordered-list marker is refused', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');

  const paren = '1) **Read** the sidecar.\n2) **Merge** by id.\n';
  const hit = Anchor.findNth(paren, '1) **Read** the sidecar. 2) **Merge** by id.', 0);
  assert.ok(hit, 'the matcher still finds it');
  const risk = spliceRisk(paren, hit.start, hit.end);
  assert.match(risk, /crosses a block boundary/);
  assert.match(risk, /"2\)"/, 'and names the marker it found');

  // Mixed delimiters reach the same span from the other side: the matcher strips the `1. ` it already
  // knows, and the `2)` rides along inside the quote.
  const mixed = '1. Read the sidecar.\n2) Merge by id.\n';
  const m = Anchor.findNth(mixed, 'Read the sidecar. 2) Merge by id.', 0);
  assert.ok(m);
  assert.match(spliceRisk(mixed, m.start, m.end), /crosses a block boundary/);

  // Ten digits is past CommonMark's ordered-marker limit, so `\d{1,9}` leaves real prose alone and
  // the widened pattern refuses nothing it did not already refuse.
  const num = 'Order line\n1234567890) shipped.\n';
  assert.equal(spliceRisk(num, 0, num.length - 1), null);
});

test('CLI suggest refuses a cross-block span; comment on the same quote is allowed', () => {
  const d = cliDir();
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Read the sidecar. Merge by id.', '--replacement', 'One step.');
  assert.ok(e, 'suggestion should be refused');
  assert.match(e.stderr, /crosses a block boundary/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
  // The same quote is fine as a comment — comments anchor, they never splice.
  cli(d, 'comment', 'doc.md', '--quote', 'Read the sidecar. Merge by id.', '--text', 'anchoring is fine');
  assert.equal(sc(d).items.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('accept refuses to splice a cross-block span, and the file is untouched', async () => {
  const md = '# T\n\n1. **Read** the sidecar.\n2. **Merge** by id.\n3. Write it back.\n';
  fs.writeFileSync(path.join(dir, 'splice.md'), md);
  // Written with --force so the card exists despite the CLI's own refusal: accept is the last line of
  // defence and has to hold on its own, for items that reached the sidecar by any route.
  execFileSync('node', [BIN, 'add', 'splice.md', '--force'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ quote: 'Read the sidecar. Merge by id.', replacement: 'REPLACED.' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const scId = JSON.parse(fs.readFileSync(path.join(dir, 'splice.md.sidecar.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'splice.md', id: scId });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /refusing to apply/);
  assert.equal(fs.readFileSync(path.join(dir, 'splice.md'), 'utf8'), md, 'file must be byte-identical');
});

test('accept still applies a normal single-block suggestion', async () => {
  fs.writeFileSync(path.join(dir, 'ok.md'), '# T\n\nWe ship all six features.\n');
  execFileSync('node', [BIN, 'suggest', 'ok.md', '--quote', 'We ship all six features.',
    '--replacement', 'We ship three features.'], { cwd: dir, encoding: 'utf8' });
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'ok.md.sidecar.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'ok.md', id });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'ok.md'), 'utf8'), /We ship three features\./);
});

test('CLI requires --quote rather than crashing with a stack trace', () => {
  const d = cliDir();
  for (const verb of ['comment', 'flag']) {
    const e = cliFails(d, verb, 'doc.md', '--text', 'no quote given');
    assert.equal(e.status, 2, `${verb} should exit 2`);
    assert.match(e.stderr, /usage:/);
    assert.ok(!/TypeError|at Object/.test(e.stderr), `${verb} must not dump a stack`);
  }
  const e = cliFails(d, 'suggest', 'doc.md', '--replacement', 'x');
  assert.equal(e.status, 2);
  assert.ok(!/TypeError/.test(e.stderr));
  fs.rmSync(d, { recursive: true, force: true });
});

test('suggest --id revises an existing card, inheriting its anchor', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'first try');
  const before = sc(d).items[0];
  cli(d, 'suggest', 'doc.md', '--id', before.id, '--replacement', 'second try');
  const after = sc(d).items[0];
  assert.equal(sc(d).items.length, 1, 'revises in place, does not add');
  assert.equal(after.replacement, 'second try');
  assert.deepEqual(after.anchor, before.anchor, 'anchor inherited, not blanked');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add refuses `by` outright — it cannot author items as the human', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([
    { by: 'alex', quote: 'Success metrics', text: 'pretending to be them' },
  ]), 'add', 'doc.md');
  assert.ok(e, 'add with a `by` key is refused');
  assert.match(e.stderr, /"by"/);
  assert.match(e.stderr, /whoever ran the command/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

/* Both halves of the splice problem, found by a second audit pass: spliceRisk validated the bytes
   being REMOVED and only caught doubled markers, so single-character emphasis slipped through — and
   nothing at all validated the bytes being INSERTED. */

test('spliceRisk catches single-character marker runs without refusing arithmetic', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q) => { const h = Anchor.findNth(raw, q, 0); return h && spliceRisk(raw, h.start, h.end); };

  assert.match(risk('*ital* text here', 'ital text here'), /dangling marker/);
  assert.match(risk('_under_ text here', 'under text here'), /dangling marker/);
  assert.match(risk('~~struck~~ text', 'struck text'), /dangling marker/);

  // Must NOT refuse: replacing the interior of a marked run, arithmetic, a whole marked span.
  assert.equal(risk('a **b** c', 'b'), null, 'replacing inside a bold run is fine');
  assert.equal(risk('2 * 3 equals 6', '2 * 3'), null, 'an unpaired * is multiplication, not emphasis');
  assert.equal(risk('with **bold** text', '**bold** text'), null);
  assert.equal(risk('snake_case here', 'snake_case here'), null);
});

test('replacementRisk refuses structure injected mid-block, allows a whole-block rewrite', () => {
  const { replacementRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q, rep) => { const h = Anchor.findNth(raw, q, 0); return replacementRisk(raw, h.start, h.end, rep); };

  const list = 'Intro para.\n\n- item one\n- item two\n';
  assert.match(risk(list, 'item one', 'one\n\n## Injected\n\nmore'), /list item|split/);

  const para = 'Alpha paragraph here.\n\nBeta.\n';
  assert.equal(risk(para, 'Alpha paragraph here.', 'One.\n\nTwo.'), null,
    'a whole paragraph may become two — this is the documented heredoc case');
  assert.match(risk(para, 'paragraph', 'x\n\n- a\n- b'), /part of a line/);
  assert.match(risk(para, 'Alpha paragraph here.', 'has **one opener'), /unbalanced/);
});

/* The one block-structured replacement a list can take safely, and the reason the rule above grew a
   second branch: "add a bullet here" is the most common suggestion an agent writes about a list, and
   an item-for-items splice at the same level leaves the same list behind. Everything else stays
   refused, so these pin both sides of that line. */
test('replacementRisk allows list items spliced over a whole list item, and refuses the rest', () => {
  const { replacementRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q, rep) => { const h = Anchor.findNth(raw, q, 0); return replacementRisk(raw, h.start, h.end, rep); };

  const list = 'Intro para.\n\n- alpha item\n- beta item\n- gamma item\n';
  assert.equal(risk(list, '- beta item', '- new item\n- beta item'), null, 'insert a bullet before');
  assert.equal(risk(list, '- gamma item', '- gamma item\n- new item'), null, 'append after the last item');
  assert.equal(risk(list, '- beta item', '- beta item\n- new item\n  wrapped onto a second line'), null);
  assert.equal(risk(list, '- beta item', '- beta item\n  - nested under it'), null);

  // The quote has to cover the marker. Without it the span is part of a line, the old marker stays
  // put, and the first new item lands behind it.
  assert.match(risk(list, 'beta item', '- new item\n- beta item'), /part of a line/);
  // A different bullet character opens a SECOND list in CommonMark, and a different indent moves the
  // item to another level, so both are refused instead of guessed at.
  assert.match(risk(list, '- beta item', '* new item\n- beta item'), /same indentation/);
  assert.match(risk(list, '- beta item', '  - deeper item\n- beta item'), /own marker/);
  assert.match(risk(list, '- beta item', '- beta item\n\n## Heading'), /blank line/);
  assert.match(risk(list, '- beta item', '- beta item\n- new item\nloose paragraph'), /not a list item/);

  // Ordered lists: the first marker is kept verbatim, since CommonMark takes the list's start number
  // from the first item alone. Later numbers may be anything, and `1)` is a different list from `1.`.
  const ord = '1. first\n2. second\n3. third\n';
  assert.equal(risk(ord, '2. second', '2. second\n3. inserted'), null);
  assert.equal(risk(ord, '2. second', '2. second\n9. renumbering does not reach the render'), null);
  assert.match(risk(ord, '2. second', '5. second\n6. inserted'), /own marker/);
  assert.match(risk(ord, '2. second', '2. second\n3) inserted'), /not a list item/);

  // A continuation line left outside the span would reparent onto whichever item the replacement
  // ends with, so the span has to cover the whole item.
  const wrap = '- one item\n  wraps to here\n- two\n';
  assert.match(risk(wrap, '- one item', '- one item\n- new item'), /continues it/);
  assert.equal(risk(wrap, '- one item wraps to here', '- one item\n  wraps to here\n- new item'), null);

  // Blockquotes stay refused: every injected line would need its own `>` prefix to stay in the quote,
  // and one line of a quote is not a whole block the way a list item is.
  assert.match(risk('> quoted line\n', '> quoted line', '> quoted line\n> more'), /blockquote/);
});

test('accept splices a new bullet into a list at the same level', async () => {
  const md = '# T\n\nIntro.\n\n- alpha item\n- beta item\n';
  fs.writeFileSync(path.join(dir, 'bullet.md'), md);
  // No --force: this one passes the write-time check too, which is half the point.
  execFileSync('node', [BIN, 'add', 'bullet.md'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ quote: '- beta item', replacement: '- inserted item\n- beta item' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'bullet.md.sidecar.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'bullet.md', id });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'bullet.md'), 'utf8'),
    '# T\n\nIntro.\n\n- alpha item\n- inserted item\n- beta item\n');
});

test('accept refuses a replacement that would inject a heading into a list item', async () => {
  const md = '# T\n\nIntro.\n\n- item one\n- item two\n';
  fs.writeFileSync(path.join(dir, 'inject.md'), md);
  execFileSync('node', [BIN, 'add', 'inject.md', '--force'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ quote: 'item one', replacement: 'one\n\n## Injected\n\nmore' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const injId = JSON.parse(fs.readFileSync(path.join(dir, 'inject.md.sidecar.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'inject.md', id: injId });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'inject.md'), 'utf8'), md, 'file untouched');
});

test('CLI suggest refuses the same replacement at write time', () => {
  const d = cliDir();
  // A PART of a line — replacing it with block structure would split the paragraph around it.
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Success metrics',
    '--replacement', 'Metrics.\n\n## New Section\n\nBody.');
  assert.ok(e);
  assert.match(e.stderr, /block structure/);
  // The whole line, on the other hand, may legitimately become several blocks.
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.',
    '--replacement', 'Metrics.\n\n## Targets\n\n200 signups by March.');
  assert.equal(sc(d).items.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI suggest writes a new list item, and still refuses a mismatched one', () => {
  const d = cliDir();
  // The heredoc case from the skill: a whole ordered item becomes itself plus a new step.
  cliStdin(d, '1. **Read** the sidecar.\n2. **Check** the anchor.', 'suggest', 'doc.md',
    '--quote', '1. **Read** the sidecar.', '--replacement', '-');
  assert.equal(sc(d).items.length, 1);
  assert.equal(sc(d).items[0].kind, 'suggestion');
  // Same shape, wrong marker style: refused at write time rather than at accept time.
  const e = cliFailsStdin(d, '- **Merge** by id.\n- **New step.** Added here.', 'suggest', 'doc.md',
    '--quote', '2. **Merge** by id.', '--replacement', '-');
  assert.ok(e);
  assert.match(e.stderr, /own marker/);
  assert.equal(sc(d).items.length, 1, 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses non-markdown files', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'code.js'), 'const x = 1;\n# not a heading\n- not a list\n');
  const e = cliFails(d, 'show', 'code.js');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /reviews markdown/);
  // .markdown and friends are still accepted.
  fs.writeFileSync(path.join(d, 'other.markdown'), '# Doc\n\nText here.\n');
  cli(d, 'comment', 'other.markdown', '--quote', 'Text here.', '--text', 'ok');
  assert.ok(fs.existsSync(path.join(d, 'other.markdown.sidecar.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('a partial update never erases the status of the item it merges into', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'first');
  const id = sc(d).items[0].id;
  cli(d, 'reply', 'doc.md', id, 'a plain reply, no --resolve');
  assert.equal(sc(d).items[0].status, 'open', 'reply must not blank the status');
  assert.equal(sc(d).items[0].thread.length, 2);
  // …and `show` has to survive whatever is on disk regardless.
  assert.match(cli(d, 'show', 'doc.md'), /OPEN/);

  // Same at the merge layer, directly: incoming carries no opinion about status.
  const { mergeItem } = require('./lib/review.js');
  const merged = mergeItem(
    { id: 'x', kind: 'comment', status: 'resolved', decidedAt: '2026-01-01T00:00:00Z', thread: [] },
    { id: 'x', thread: [{ by: 'claude', at: '2026-01-02T00:00:00Z', text: 'late reply' }] });
  assert.equal(merged.status, 'resolved', 'a partial update must not regress a decided status');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Matcher pinning — the block-tolerant matcher has secondary match surfaces the 2026-07-23 audit
   found (prose+code, table cells, spaced rules). The decision record chose to PIN these with tests
   rather than make the matcher fence-aware — adding fence-state tracking to normalize(), which also
   maintains the offset map accept splices against, is complexity in the single most safety-critical
   function to fix a cosmetic ambiguity count. Behaviour that is accidental AND untested is how a
   matcher silently changes under you. These lock HEAD's behaviour so a future edit has to face it.
   Pure Anchor.findAll / spliceRisk units — no server, no matcher change.
   --------------------------------------------------------------------------- */

test('matcher pin: a quote spans prose into an indented code block, and spliceRisk refuses that splice', () => {
  const Anchor = require('./public/anchor.js');
  const { spliceRisk } = require('./lib/review.js');
  // Indented code block after a prose line: the 4-space indent is whitespace, collapsed like any run,
  // so the tolerant pass matches across it. Match loosely — but the span crosses the blank line, so a
  // suggestion over it is refused before accept can splice structure away.
  const raw = 'Prose start.\n\n    not a list, code\n';
  const hits = Anchor.findAll(raw, 'Prose start. not a list, code');
  assert.equal(hits.length, 1, 'prose+indented-code matches (pinned)');
  const hit = Anchor.findNth(raw, 'Prose start. not a list, code', 0);
  assert.match(spliceRisk(raw, hit.start, hit.end), /blank line/, 'and a splice over it is refused');
});

test('matcher pin: a quote does NOT span prose into a FENCED code block', () => {
  const Anchor = require('./public/anchor.js');
  // HEAD behaviour, run before pinning: the ``` fence lines strip to nothing on the tolerant pass, but
  // the two collapsed whitespace runs around them leave a DOUBLE space in the haystack that the
  // single-spaced needle can't match. Fence-crossing quotes miss — the same "accident" as the spaced
  // rule below. Pinned so the accident becomes a contract; a fence-aware matcher was rejected.
  const raw = 'Prose line.\n\n```\ncode line\n```\n';
  assert.equal(Anchor.findAll(raw, 'Prose line. code line').length, 0, 'no cross-fence match (pinned)');
});

test('matcher pin: `- -` matches the delimiter cells of a table row', () => {
  const Anchor = require('./public/anchor.js');
  // The tolerant pass is fence/table-unaware, so `| - | - |` exposes two `- ` "matches" the human
  // can neither see nor select. Verified count, not assumed: two hits, one per delimiter cell.
  const row = '| - | - |';
  assert.equal(Anchor.findAll(row, '- -').length, 2, 'two delimiter-cell hits (verified)');
  const table = '| a | b |\n| - | - |\n| c | d |\n';
  assert.equal(Anchor.findAll(table, '- -').length, 2, 'same inside a full table');
});

test('matcher pin: a quote does NOT match across a spaced horizontal rule `- - -`', () => {
  const Anchor = require('./public/anchor.js');
  // Audit 1: the stacked block-marker loop strips `- - -` down to a single leftover `-`, so text on
  // either side of the rule stays separated by that `-` and a cross-rule quote misses. Called an
  // "accident" in the audit; the decision record pins it as a contract.
  const raw = 'Alpha text\n\n- - -\n\nBeta text\n';
  assert.equal(Anchor.findAll(raw, 'Alpha text Beta text').length, 0, 'no cross-rule match (pinned)');
});

test('matcher pin: a comment can still anchor to text inside a fenced code block', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'fence.md'), '# Doc\n\nIntro.\n\n```js\nconst x = 1;\n```\n');
  // Match-loosely stays half intact: the code content is selectable text, so a COMMENT (which only
  // anchors, never splices) resolves and writes. This is what the "restrict, don't rewrite the matcher"
  // call preserves — highlighting a fence is fine; only splicing across one is refused.
  cli(d, 'comment', 'fence.md', '--quote', 'const x = 1;', '--text', 'anchoring into a fence is allowed');
  const it = JSON.parse(fs.readFileSync(path.join(d, 'fence.md.sidecar.json'), 'utf8')).items[0];
  assert.equal(it.kind, 'comment');
  assert.equal(it.anchor.quote, 'const x = 1;');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Safety guards — the 2026-07-23 decision record's "the one that matters": accept/reject are absent
   from the CLI on purpose (the human decides), but three commands routed around it — `add` passing a
   status/thread wholesale, and `resolve` / `reply --resolve` settling a suggestion. Each forged a
   decision the human never made. These close all three and prove the happy paths are unchanged.
   --------------------------------------------------------------------------- */

test('add refuses a fabricated decision (status + thread) and writes nothing', () => {
  const d = cliDir();
  // The decision record's probe, generalised: an agent tries to seed a card already "accepted", with a
  // human-looking thread. Both keys are the human's; add refuses by name and leaves no sidecar.
  const e = cliFailsStdin(d, JSON.stringify([
    { quote: 'Success metrics', text: 'looks settled', status: 'accepted',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'forged approval' }] },
  ]), 'add', 'doc.md');
  assert.ok(e, 'refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /status/);
  assert.match(e.stderr, /thread/);
  assert.match(e.stderr, /belong to the human/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'sidecar untouched — nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add refuses the decision-record heredoc verbatim (id + status:"accepted")', () => {
  const d = cliDir();
  // The exact payload from the audit disposition. It forges an id AND a decision; both are refused.
  const e = cliFailsStdin(d,
    '[{"id":"s-fake","quote":"Alpha line here.","replacement":"Beta.","status":"accepted"}]',
    'add', 'doc.md');
  assert.ok(e, 'refused');
  assert.match(e.stderr, /"id"/);
  assert.match(e.stderr, /"status"/);
  assert.match(e.stderr, /suggest --id/, 'points the agent at the real revise path');
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'sidecar untouched');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add refuses `anchor` passthrough, naming the fields to use instead', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([
    { anchor: { quote: 'Success metrics', occurrence: 0 }, text: 'hi' },
  ]), 'add', 'doc.md');
  assert.ok(e);
  assert.match(e.stderr, /"anchor"/);
  assert.match(e.stderr, /quote/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add --force does NOT bypass the key allow-list (it is a boundary, not a warning)', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([{ quote: 'Success metrics', text: 'x', status: 'accepted' }]),
    'add', 'doc.md', '--force');
  assert.ok(e, 'still refused with --force');
  assert.match(e.stderr, /status/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolve refuses a suggestion, pointing at the browser and drop; still resolves a comment', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'Target: 200 signups.');
  const sug = sc(d).items[0];
  const e = cliFails(d, 'resolve', 'doc.md', sug.id);
  assert.ok(e, 'suggestion resolve refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /suggestion/);
  assert.match(e.stderr, /drop/);
  assert.equal(sc(d).items[0].status, 'pending', 'the card was not settled');

  // A comment resolve is unchanged.
  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'closing this');
  const com = sc(d).items.find(i => i.kind === 'comment');
  cli(d, 'resolve', 'doc.md', com.id);
  assert.equal(sc(d).items.find(i => i.id === com.id).status, 'resolved');
  fs.rmSync(d, { recursive: true, force: true });
});

test('reply --resolve refuses a suggestion; a plain reply on it stays legal', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'Target: 200 signups.');
  const id = sc(d).items[0].id;
  const e = cliFails(d, 'reply', 'doc.md', id, 'settling it', '--resolve');
  assert.ok(e, 'reply --resolve on a suggestion refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /suggestion/);
  assert.equal(sc(d).items[0].status, 'pending', 'not settled');
  assert.equal((sc(d).items[0].thread || []).length, 0, 'the refused message was not appended either');

  // A plain reply (a message, no status) is allowed on a suggestion.
  cli(d, 'reply', 'doc.md', id, 'one more thought');
  assert.equal(sc(d).items[0].status, 'pending');
  assert.equal(sc(d).items[0].thread[0].text, 'one more thought');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add happy paths unchanged: replyTo, flag, and kind inference all pass through', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'parent comment');
  const parent = sc(d).items[0];
  cliStdin(d, JSON.stringify([
    { quote: 'week one', text: 'a flagged concern', flag: true },
    { quote: 'Success metrics are not defined yet.', replacement: 'Target: 200 signups.', replyTo: parent.id },
  ]), 'add', 'doc.md');
  const items = sc(d).items;
  const flagged = items.find(i => i.flag);
  assert.ok(flagged, 'flag passes through');
  assert.equal(flagged.kind, 'comment', 'no replacement → comment');
  const answer = items.find(i => i.replyTo === parent.id);
  assert.ok(answer, 'replyTo passes through');
  assert.equal(answer.kind, 'suggestion', 'replacement present → suggestion');
  assert.equal(answer.by, 'claude');
  fs.rmSync(d, { recursive: true, force: true });
});

// SIDECAR_PORT points at a dead port so doctor takes its no-server path and never reaches whatever the
// developer happens to be running on the default one.
const doctorIn = (d, ...args) => execFileSync('node', [BIN, 'doctor', ...args],
  { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SIDECAR_PORT: '4990' } });

test('doctor warns when the digest state files are not gitignored, and goes quiet once they are', () => {
  const d = cliDir();   // a git repo with no .gitignore, which is the state a host repo starts in
  assert.match(doctorIn(d, 'doc.md'), /\*\.sidecar\.seen\*/, 'the warning names the exact pattern to add');
  assert.match(doctorIn(d, 'doc.md'), /\.gitignore/, 'and says where it goes');
  fs.writeFileSync(path.join(d, '.gitignore'), '*.sidecar.seen*\n');
  assert.doesNotMatch(doctorIn(d, 'doc.md'), /\.seen/, 'ignored → nothing extra to say');
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor says nothing about gitignore outside a git work tree', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-nogit-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  assert.doesNotMatch(doctorIn(d, 'doc.md'), /\.seen/, 'no repo, nothing to ignore');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   The .review.* → .sidecar.* rename (1.7.0). A load migrates; doctor reports
   what a load has not reached yet.
   --------------------------------------------------------------------------- */

// stdout AND stderr: the rename notice goes to stderr on purpose, so it can never land in the middle
// of `show --json`.
const cliBoth = (d, ...args) => {
  const r = spawnSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
};

// A complete pre-1.7 sibling set: the review, the cursor, one agent's doc baseline, an asset dir.
function legacySet(d, doc = 'doc.md') {
  const at = path.join(d, doc);
  fs.writeFileSync(at + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'legacy1', kind: 'comment', by: 'you', status: 'open',
      anchor: { quote: 'Success metrics are not defined yet.' },
      thread: [{ by: 'you', at: '2026-08-01T10:00:00Z', text: 'from before the rename' }] }] }));
  fs.writeFileSync(at + '.review.seen.json', JSON.stringify({ claude: { docHash: 'abc', items: {}, at: '2026-08-01T10:00:00Z' } }));
  fs.writeFileSync(at + '.review.seen.base.claude', CLI_DOC);
  fs.mkdirSync(at + '.review.assets', { recursive: true });
  fs.writeFileSync(path.join(at + '.review.assets', 'ab12cd34ef56.png'), 'not really a png');
}

test('a load renames the whole pre-1.7 sibling set, items and all, and says so once', () => {
  const d = cliDir();
  legacySet(d);
  const { out, err } = cliBoth(d, 'show', 'doc.md');
  for (const suffix of ['.sidecar.json', '.sidecar.seen.json', '.sidecar.seen.base.claude',
                        '.sidecar.assets', '.sidecar.assets/ab12cd34ef56.png'])
    assert.ok(fs.existsSync(path.join(d, 'doc.md' + suffix)), `${suffix} moved across`);
  const left = fs.readdirSync(d).filter(n => n.includes('.review.'));
  assert.deepEqual(left, [], 'nothing keeps the old name');
  assert.match(out, /legacy1/, 'the review still reads, through its new name');
  assert.equal(err.trim().split('\n').length, 1, 'one line about the rename, not one per file');
  assert.match(err, /\.sidecar\./);
  fs.rmSync(d, { recursive: true, force: true });
});

test('both names present: the new one wins, the old one is left alone and warned about', () => {
  const d = cliDir();
  legacySet(d);
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'current1', kind: 'comment', by: 'you', status: 'open',
      anchor: { quote: 'Success metrics are not defined yet.' },
      thread: [{ by: 'you', at: '2026-08-13T10:00:00Z', text: 'after the rename' }] }] }));
  const { out, err } = cliBoth(d, 'show', 'doc.md');
  assert.match(out, /current1/, 'the .sidecar.json is what gets read');
  assert.doesNotMatch(out, /legacy1/, 'the two item sets are never merged');
  assert.match(err, /both/i, 'and the ambiguity is said out loud');
  assert.ok(fs.existsSync(path.join(d, 'doc.md.review.json')), 'the old file is left for a human to decide about');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the server migrates on load as well — the rename sits in the shared load path', async () => {
  const f = path.join(dir, 'renamed.md');
  fs.writeFileSync(f, DOC);
  fs.writeFileSync(f + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'srv1', kind: 'comment', by: 'you', status: 'open', anchor: { quote: 'Closing paragraph.' }, thread: [] }] }));
  const s = await fetchRetry(`${BASE}/api/state?path=renamed.md`).then(j);
  assert.deepEqual(s.review.items.map(i => i.id), ['srv1'], 'the review arrives, read from its new name');
  assert.ok(fs.existsSync(f + '.sidecar.json'));
  assert.ok(!fs.existsSync(f + '.review.json'));
});

// Rolling a current sibling set back to the old names, which is what a pre-1.7 install left behind.
const unrename = (d) => { for (const n of fs.readdirSync(d).filter(n => n.includes('.sidecar.')))
  fs.renameSync(path.join(d, n), path.join(d, n.replace('.sidecar.', '.review.'))); };

test('the migrated cursor is still a cursor — no spurious full replay after the rename', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  unrename(d);
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new/, 'the cursor came across with the review');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a wait armed on pre-1.7 names still surfaces the backlog its cursor was holding', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');   // the cursor knows about that card, and about nothing after it
  patchReview(d, (r) => r.items.push({ id: 'human1', kind: 'comment', by: 'you', status: 'open',
    anchor: { quote: 'Repeated line here.', occurrence: 0 },
    thread: [{ by: 'you', at: '2026-08-13T10:00:00Z', text: 'and this one?' }] }));
  unrename(d);
  // The load is what renames, so it has to run before the cursor is read: an unrenamed cursor reads as
  // no cursor, the baseline falls back to current state, and this card sleeps until the timeout.
  const { code, out } = await spawnWait(d, { timeout: 3 });
  assert.equal(code, 0, 'it wakes on the backlog instead of sleeping through it');
  assert.match(out, /and this one\?/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor reports files still on the .review.* names, and the command that renames them', () => {
  const d = cliDir();
  legacySet(d);
  const out = doctorIn(d, 'doc.md');
  assert.match(out, /still on the pre-1\.7 \.review\.\* names/);
  assert.match(out, /doc\.md\.review\.json/, 'it names what it found');
  assert.match(out, /sidecar show/, 'and how to fix it');
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor treats a *.review.seen* gitignore pattern as stale, covered or not', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, '.gitignore'), '*.review.seen*\n');
  const before = doctorIn(d, 'doc.md');
  assert.match(before, /\*\.sidecar\.seen\*/, 'the pattern that would actually cover the state');
  assert.match(before, /\.gitignore:1:\*\.review\.seen\*.*pre-1\.7/, 'and the line holding the dead one');
  fs.writeFileSync(path.join(d, '.gitignore'), '*.sidecar.seen*\n*.review.seen*\n');
  const after = doctorIn(d, 'doc.md');
  assert.match(after, /dead \.gitignore line/, 'covered, and the old line is still worth deleting');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   P2 — the persistent last-seen cursor: `sidecar digest` and `wait` over it
   (lib/digest.js). Same real-binary + temp-fixture pattern as the CLI block.
   --------------------------------------------------------------------------- */

// env-passing variant of cli() — the cursor is keyed by SIDECAR_AGENT.
const cliE = (d, env, ...args) => execFileSync('node', [BIN, ...args],
  { cwd: d, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
// Patch the on-disk review the way the browser/server would (add a human item, a reply, a decision).
const patchReview = (d, fn) => { const p = path.join(d, 'doc.md.sidecar.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8')); fn(r); fs.writeFileSync(p, JSON.stringify(r, null, 2)); };
const seen = (d) => { const p = path.join(d, 'doc.md.sidecar.seen.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
// Run `sidecar wait` as a real background process; `onReady` fires once the watcher is up so a test
// can trigger an fs event. No server on SIDECAR_PORT here — presence pings just fail fast (400ms).
function spawnWait(d, { agent = 'claude', timeout = 10, onReady, readyDelay = 800 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [BIN, 'wait', 'doc.md', '--timeout', String(timeout)],
      { cwd: d, env: { ...process.env, SIDECAR_AGENT: agent, SIDECAR_PORT: '4993' } });
    let out = ''; p.stdout.on('data', c => (out += c));
    p.on('exit', (code) => resolve({ code, out }));
    if (onReady) setTimeout(() => onReady(p), readyDelay);
  });
}

test('digest: no cursor → flagged full summary, cursor written; second digest says nothing new', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  const first = cli(d, 'digest', 'doc.md');
  assert.match(first, /no last-seen marker/, 'first look is flagged as a full replay');
  assert.match(first, /NEW suggestion @ .*Week one ships three|NEW suggestion @/, 'the seeded card shows');
  assert.ok(seen(d).claude, 'cursor written under the agent key');
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'second look is empty');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: comment + reply + accept stacked between two looks → ONE digest reports all three', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');                       // establish the cursor
  // Human, off-screen: accepts the suggestion (doc spliced + status), replies to the comment, adds a new one.
  fs.writeFileSync(path.join(d, 'doc.md'),
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
  patchReview(d, (r) => {
    const sug = r.items.find(i => i.kind === 'suggestion'); sug.status = 'accepted'; sug.decidedAt = '2026-07-23T00:00:00Z';
    const com = r.items.find(i => i.kind === 'comment'); com.by = 'alex';
    com.thread.push({ by: 'alex', at: '2026-07-23T00:00:01Z', text: 'yes, three concrete ones' });
    r.items.push({ id: 'c-new-human', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Repeated line here.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-23T00:00:02Z', text: 'is this duplicated on purpose?' }] });
  });
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /ACCEPTED/, 'the accept');
  assert.match(out, /REPLY .*yes, three concrete ones/, 'the reply, in full');
  assert.match(out, /NEW comment .*is this duplicated on purpose\?/, 'the new comment, in full');
  fs.rmSync(d, { recursive: true, force: true });
});

/* The gap that made suggestion threads unsafe to ship. A card the agent creates AFTER its last look is
   outside the cursor, and the "not news to me, I wrote it" branch used to skip the whole item, taking
   any message someone else had already put on it down with it. `suggest` then `wait` is the normal
   order, so Alex's first reply on a fresh suggestion landed in that gap and `wait` slept to its timeout.
   Reachable on a comment too; threaded suggestion cards just make it the common path. */
test('digest: a reply on the agent’s OWN new card surfaces as a REPLY', () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');                       // cursor established while the review is empty
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  const sug = sc(d).items[0].id;
  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'is this the right scope?');
  const com = sc(d).items.find(i => i.kind === 'comment').id;
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', sug, 'why drop that word?');
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', com, 'scope is fine, ship it');
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /REPLY .*why drop that word\?/, 'the reply on the agent’s own suggestion');
  assert.match(out, /REPLY .*scope is fine, ship it/, 'and on its own comment');
  fs.rmSync(d, { recursive: true, force: true });
});

// The guard on that fix: it keys on WHO wrote the message, never on "this card has a thread". An agent
// reporting its own replies back to itself would make every `reply` wake its own `wait`.
test('digest: the agent’s own fresh card stays silent when only the agent has written on it', () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'reply', 'doc.md', sc(d).items[0].id, 'a second thought of my own');
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'nothing here is addressed to me');
  fs.rmSync(d, { recursive: true, force: true });
});

// A full replay has no cursor, so the card itself is news and its last message is the text shown. The
// reply must not ALSO be listed separately, or the first look double-reports every discussed card.
test('digest: a discussed agent card reports once on a full replay, as NEW', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', sc(d).items[0].id, 'say more about this');
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /no last-seen marker/, 'this is the full-replay path');
  assert.match(out, /NEW suggestion .*say more about this/, 'reported as the new card');
  assert.equal(out.match(/say more about this/g).length, 1, 'reported exactly once, not as NEW and REPLY');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --peek reports the delta but does NOT advance the cursor', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');                       // cursor at pending
  patchReview(d, (r) => { const s = r.items[0]; s.status = 'rejected'; s.decidedAt = '2026-07-23T00:00:00Z'; });
  const before = JSON.stringify(seen(d));
  assert.match(cli(d, 'digest', 'doc.md', '--peek'), /REJECTED/, 'peek still reports the change');
  assert.equal(JSON.stringify(seen(d)), before, 'peek left the cursor untouched');
  assert.match(cli(d, 'digest', 'doc.md', '--peek'), /REJECTED/, 'so a second peek reports it again');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --json emits the structured delta and round-trips', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  const parsed = JSON.parse(cli(d, 'digest', 'doc.md', '--json'));
  assert.ok(parsed.snapshot && parsed.snapshot.items, 'carries the snapshot to advance to');
  assert.equal(parsed.noMarker, true, 'first look, no marker');
  assert.ok(Array.isArray(parsed.news), 'structured sections present');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: two SIDECAR_AGENT values hold independent cursors', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md');   // advances claude only
  const s = seen(d);
  assert.ok(s.claude && !s.gpt, 'only claude has a cursor so far');
  assert.match(cliE(d, { SIDECAR_AGENT: 'gpt' }, 'digest', 'doc.md'), /no last-seen marker/, 'gpt still sees a full replay');
  assert.match(cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md'), /nothing new/, 'claude is caught up');
  assert.ok(seen(d).claude && seen(d).gpt, 'both cursors coexist in one file');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: corrupt or deleted seen file → no crash, treated as a full replay', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.seen.json'), '{ this is not json');
  const out = cli(d, 'digest', 'doc.md');            // must not throw
  assert.match(out, /no last-seen marker/, 'corrupt cursor degrades to full replay');
  fs.rmSync(path.join(d, 'doc.md.sidecar.seen.json'));
  assert.match(cli(d, 'digest', 'doc.md'), /no last-seen marker/, 'a deleted cursor replays too');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: reject + human reply carries the reason text IN FULL', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'digest', 'doc.md');
  const reason = 'no — leadership already committed to six externally, keep it';
  patchReview(d, (r) => { const s = r.items[0]; s.status = 'rejected'; s.decidedAt = '2026-07-23T00:00:00Z';
    s.thread = [{ by: 'alex', at: '2026-07-23T00:00:01Z', text: reason }]; });
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /REJECTED/);
  assert.ok(out.includes(reason), 'the full rejection reason is present, unclipped');
  fs.rmSync(d, { recursive: true, force: true });
});

/* The removed list had no authorship check, so `sidecar drop` on the agent's own card came back at that
   same agent as REMOVED and woke its own `wait` one turn later (reproduced 2026-08-13). The news path
   had filtered on authorship since the start; removals never did. */
test('digest: the agent dropping its own card wakes nothing', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');                        // cursor holds the card, authored by claude
  cli(d, 'drop', 'doc.md', sc(d).items[0].id);
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'I withdrew it, so it is not news to me');
  fs.rmSync(d, { recursive: true, force: true });
});

// The guard on that fix: it scopes by author, never by "a removal is boring". Someone else's card
// disappearing is a real change to the review and has to keep reporting.
test('digest: a card someone else authored still reports when it is removed', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Success metrics', occurrence: 0 }, thread: [] }] }, null, 2));
  cli(d, 'digest', 'doc.md');                        // cursor records it as alex's
  patchReview(d, (r) => { r.items = r.items.filter(i => i.id !== 'c-human'); });
  assert.match(cli(d, 'digest', 'doc.md'), /REMOVED c-human/, "the human's card vanishing is still news");
  fs.rmSync(d, { recursive: true, force: true });
});

// A cursor written before `by` existed cannot say who owned the card. It reports rather than staying
// silent, so the change fails noisy: one stale wake, and the next cursor advance heals it. No migration.
test('digest: a legacy cursor entry with no author still reports the removal', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');
  const id = sc(d).items[0].id;
  const sp = path.join(d, 'doc.md.sidecar.seen.json');
  const all = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete all.claude.items[id].by;                    // as an older sidecar would have written it
  fs.writeFileSync(sp, JSON.stringify(all, null, 2));
  cli(d, 'drop', 'doc.md', id);                      // the agent's OWN card, but the cursor cannot know
  assert.match(cli(d, 'digest', 'doc.md'), new RegExp('REMOVED ' + id), 'an unattributable removal reports');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: a pre-existing unseen backlog exits immediately and advances the cursor', async () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'digest', 'doc.md');                        // cursor at threadLen 0
  patchReview(d, (r) => { r.items[0].thread = [{ by: 'alex', at: '2026-07-23T00:00:00Z', text: 'why only three?' }]; });
  const t0 = Date.now();
  const { code, out } = await spawnWait(d, { timeout: 30 });   // no onReady — must exit on its own
  assert.ok(Date.now() - t0 < 5000, 'returned well before the 30s timeout');
  assert.equal(code, 0, 'digest-emitting exit');
  assert.match(out, /REPLY .*why only three\?/, 'reports the backlog it had not seen');
  assert.equal(seen(d).claude.items[Object.keys(seen(d).claude.items)[0]].threadLen, 1, 'cursor advanced past the reply');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: a timeout exit does NOT advance the cursor', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');                        // cursor == current state
  const before = JSON.stringify(seen(d));
  const { code, out } = await spawnWait(d, { timeout: 1 });   // nothing happens → times out
  assert.equal(code, 1, 'timeout exit code');
  assert.match(out, /still watching/);
  assert.equal(JSON.stringify(seen(d)), before, 'a timeout must not move the cursor');
  fs.rmSync(d, { recursive: true, force: true });
});

// The end of the loop the digest fix exists to close: the agent suggests, arms `wait`, and Alex asks a
// question on the card instead of deciding it. Before the fix this slept to the timeout (exit 1) with
// the reply sitting on disk, leaving the agent silent on a direct question.
test('wait: wakes on a reply to a suggestion the agent made after its last look', async () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');                        // cursor established before the card exists
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  const id = sc(d).items[0].id;
  const { code, out } = await spawnWait(d, { timeout: 10, onReady: () =>
    cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', id, 'talk me through this one first') });
  assert.equal(code, 0, 'woke and emitted, rather than timing out');
  assert.match(out, /REPLY .*talk me through this one first/, 'the question is in the digest');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: an accept prints the digest exactly once (double-print regression)', async () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  // No cursor → baseline is current state → wait sleeps until a real change.
  const { code, out } = await spawnWait(d, { timeout: 10, onReady: () => {
    // An accept touches BOTH files (doc splice + status write) → two chokidar events in quick succession.
    fs.writeFileSync(path.join(d, 'doc.md'),
      fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
    patchReview(d, (r) => { r.items[0].status = 'accepted'; r.items[0].decidedAt = '2026-07-23T00:00:00Z'; });
  } });
  assert.equal(code, 0);
  assert.equal((out.match(/## sidecar — your turn/g) || []).length, 1, 'exactly one digest header');
  assert.equal((out.match(/ACCEPTED/g) || []).length, 1, 'exactly one ACCEPTED line');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Doc baseline — the digest's own copy of the document (lib/digest.js basePath).
   The doc half of the digest diffs against the agent's last look, not git HEAD:
   untracked docs, non-git dirs, and mid-review commits must all produce real
   hunks, and nothing may be re-sent across looks.
   --------------------------------------------------------------------------- */

const basefile = (d, agent = 'claude', doc = 'doc.md') => path.join(d, doc + '.sidecar.seen.base.' + agent);
// The fixture without git — sidecar's serverless contract says this must work identically.
function cliDirNoGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cli-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  return d;
}

test('baseline: written on digest advance, not on --peek, not on a wait timeout', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md', '--peek');
  assert.ok(!fs.existsSync(basefile(d)), 'peek advances neither cursor nor baseline');
  cli(d, 'digest', 'doc.md');
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), CLI_DOC, 'advance writes the doc text as-of-this-look');
  const before = fs.readFileSync(basefile(d), 'utf8');
  const { code } = await spawnWait(d, { timeout: 1 });          // nothing happens → times out
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), before, 'a timeout must not move the baseline');
  fs.rmSync(d, { recursive: true, force: true });
});

test('baseline: two SIDECAR_AGENT values hold independent baselines', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md');
  assert.ok(fs.existsSync(basefile(d, 'claude')) && !fs.existsSync(basefile(d, 'gpt')), 'only claude has a baseline so far');
  cliE(d, { SIDECAR_AGENT: 'gpt' }, 'digest', 'doc.md');
  assert.ok(fs.existsSync(basefile(d, 'gpt')), 'both baselines coexist as separate files');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: a doc edit produces hunks in an UNTRACKED file (the empty-digest hole)', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'new.md'), CLI_DOC);            // never committed — git diff sees nothing
  cli(d, 'comment', 'new.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'new.md');                                   // cursor + baseline
  fs.writeFileSync(path.join(d, 'new.md'), CLI_DOC.replace('Success metrics are not defined yet.', 'Success metrics: 200 signups.'));
  const out = cli(d, 'digest', 'new.md');
  assert.match(out, /### doc changes \(since your last look\)/, 'the diff section renders');
  assert.match(out, /-Success metrics are not defined yet\./, 'the removed line');
  assert.match(out, /\+Success metrics: 200 signups\./, 'the added line');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: same, in a directory that is not a git repo at all', () => {
  const d = cliDirNoGit();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /-# Plan/, 'hunks with no git anywhere');
  assert.match(out, /\+# The Plan/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: hunks are since the LAST LOOK — an earlier, already-reported edit is not re-sent', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(path.join(d, 'doc.md'),                       // edit A, near the top
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
  assert.match(cli(d, 'digest', 'doc.md'), /\+Week one ships three\./, 'edit A reported once');
  fs.writeFileSync(path.join(d, 'doc.md'),                       // edit B, far from A
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('3. **Write** it back.', '3. **Write** it back, atomically.'));
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /\+3\. \*\*Write\*\* it back, atomically\./, 'edit B reported');
  assert.ok(!out.includes('Week one ships three'), 'edit A does NOT ride along again');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: a mid-review commit no longer blanks the diff channel', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm checkpoint', { cwd: d });
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');                        // git diff vs HEAD would show this too — but
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm edit', { cwd: d });
  const out2Setup = fs.readFileSync(path.join(d, 'doc.md'), 'utf8');   // now HEAD == worktree: git diff is EMPTY
  fs.writeFileSync(path.join(d, 'doc.md'), out2Setup.replace('Repeated line here.\n\nRepeated line here.', 'One line here.'));
  const out2 = cli(d, 'digest', 'doc.md');
  assert.match(out, /\+# The Plan/, 'hunks after a checkpoint commit');
  assert.match(out2, /\+One line here\./, 'hunks even when the worktree is clean at HEAD');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: missing or stale baseline with a live cursor → flagged, no crash, self-heals', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(basefile(d), 'some other version entirely');  // hash no longer matches cursor.docHash
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');                        // must not throw, must not diff the wrong text
  assert.match(out, /doc changed \(no baseline/, 'stale baseline degrades loudly');
  assert.ok(!out.includes('some other version'), 'and never diffs against the wrong version');
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), fs.readFileSync(path.join(d, 'doc.md'), 'utf8'),
    'the advance rewrote the baseline');
  fs.writeFileSync(path.join(d, 'doc.md'), fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('# The Plan', '# The Real Plan'));
  assert.match(cli(d, 'digest', 'doc.md'), /\+# The Real Plan/, 'next look diffs normally again');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------------------------
   VISUALS — ```flow diagrams, raw-HTML islands, and the /assets image route.

   The load-bearing property is that a rendered block never reaches turndown: turndown cannot round-
   trip an <svg> (it comes back as the bare label text) so an editable diagram would be destroyed by
   the first stray keystroke. Atomic blocks make that path unreachable rather than unlikely, and the
   tests below pin it on BOTH serialize paths — the tight one and the block-count-changed fallback
   that produced the original data-loss bug.
   --------------------------------------------------------------------------------------------- */

const FLOW_SRC = '```flow\nSign up --> Verify email\nVerify email --> {Valid?}\n{Valid?} -->|yes| Done\n{Valid?} -->|no| Verify email\n```';
const HTML_SRC = '<div style="display:flex">\n  <span>before</span>\n  <span>after</span>\n</div>';
const VIS_DOC = [
  '# Visuals', '',
  'Intro paragraph mentioning Done in prose.', '',
  FLOW_SRC, '',
  'Middle paragraph.', '',
  HTML_SRC, '',
  'Closing paragraph.', '',
].join('\n');

test('flow parse: nodes, edges, labels, decisions and direction', () => {
  const m = Flow.parse('LR\n%% a comment\nA --> B\nB -->|yes| {C?}\n{C?} --> A');
  assert.equal(m.dir, 'LR', 'a bare LR line sets direction');
  assert.deepEqual(m.nodes.map(n => n.label), ['A', 'B', 'C?'], '%% comments are skipped, nodes dedupe by label');
  assert.equal(m.nodes.find(n => n.label === 'C?').decision, true, '{…} marks a decision');
  assert.equal(m.edges.length, 3);
  assert.equal(m.edges[1].label, 'yes', 'the |label| rides the arrow it follows');
  assert.deepEqual(m.errors, []);
});

test('flow parse: a chained line is several edges, and a node offset points at its own label', () => {
  const src = 'Draft --> Review --> Ship';
  const m = Flow.parse(src);
  assert.equal(m.edges.length, 2, 'A --> B --> C is two edges');
  // `at` is what makes a node comment anchor to ITS mention rather than to some earlier line that
  // happens to share the word — so it has to index the label exactly.
  for (const n of m.nodes) assert.equal(src.substr(n.at, n.label.length), n.label, `offset for ${n.label}`);
});

test('flow parse: a malformed line is reported, not silently dropped', () => {
  const m = Flow.parse('A --> \nB --> C');
  assert.deepEqual(m.errors, ['A -->'], 'the unreadable line is surfaced');
  assert.ok(m.nodes.some(n => n.label === 'C'), 'the readable lines still parse');
});

test('flow layout: a cycle does not inflate ranks, and the back edge is routed around', () => {
  const m = Flow.layout(Flow.parse('A --> B\nB --> C\nC --> A'));
  // Ranking THROUGH a cycle walks every node down a level per pass, leaving a tall ladder with empty
  // rows; the empty rows then read as holes and Math.max over a hole is NaN — a blank diagram.
  const ys = [...new Set(m.nodes.map(n => n.y))];
  assert.equal(ys.length, 3, 'three nodes, three rows — no ladder');
  assert.ok(Number.isFinite(m.width) && Number.isFinite(m.height), 'no NaN in the canvas size');
  assert.equal(m.edges.filter(e => e.back).length, 1, 'exactly the cycle-closing edge is a back edge');
  assert.ok(m.loop > 0, 'the canvas reserves room for the loop, or it clips');
});

test('flow render: an empty fence renders without a negative canvas', () => {
  const m = Flow.layout(Flow.parse(''));
  assert.equal(m.width, 0); assert.equal(m.height, 0);
  const { svg } = Flow.render('');
  assert.ok(!/NaN|undefined/.test(svg), 'no NaN/undefined leaks into the SVG');
});

test('flow render: labels are escaped and data-node carries an index, never flow source', () => {
  const { svg } = Flow.render('<script>x</script> --> B');
  assert.ok(!svg.includes('<script>'), 'a label is escaped, never live markup');
  assert.ok(svg.includes('&lt;script&gt;'));
  // DOMPurify's SAFE_FOR_XML strips any attribute whose value contains `-->`, which is exactly the
  // arrow syntax — so an attribute carrying raw flow source would silently vanish.
  assert.ok(/data-node="\d+"/.test(svg), 'data-node is an index');
  assert.ok(!/data-\w+="[^"]*--&gt;/.test(svg) && !/data-\w+="[^"]*-->/.test(svg), 'no attribute carries an arrow');
});

test('flow render: the canvas states its own width, which is what the page sizes it by', () => {
  // index.html's sizeFlow sets a min-width from this, so the diagram stops shrinking before its labels
  // stop being readable and the box scrolls instead (.fl-scroll). It reads the width attribute and
  // falls back to the viewBox, so both have to be there and both have to say the same thing.
  const { svg } = Flow.render('LR\nSign up --> Verify email --> Pick a plan --> Start the trial');
  const w = Number((svg.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/) || [])[1]);
  const vb = (svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/) || []).slice(1).map(Number);
  assert.ok(w > 0, 'a numeric width');
  assert.equal(vb[0], w, 'and the viewBox agrees with it');
  assert.ok(w > 500, 'a four-node chain across is wider than a phone, which is the case this exists for');
});

// ---------- the directory panel's ordering (public/navsort.js) ----------
// The SAME file index.html loads via <script>, so what the panel draws is what these assert.
const Nav = require('./public/navsort.js');
const docsOf = (names) => names.map((n, i) => ({ rel: 'p/' + n, name: n, mtime: 1000 + i }));
const namesOf = (list) => list.map(d => d.name);

test('spine sort: summary first, brief second, the rest alphabetical', () => {
  const out = Nav.sort(docsOf(['market-research.md', 'brief.md', 'zeta.md', 'summary.md', 'business-case.md']), 'spine');
  assert.deepEqual(namesOf(out), ['summary.md', 'brief.md', 'business-case.md', 'market-research.md', 'zeta.md']);
});

test('spine sort: a folder with neither summary nor brief is plain alphabetical', () => {
  const out = Nav.sort(docsOf(['zeta.md', 'alpha.md', 'middle.md']), 'spine');
  assert.deepEqual(namesOf(out), ['alpha.md', 'middle.md', 'zeta.md']);
});

test('spine sort: brief leads when there is no summary, and neither name is hoisted from a longer one', () => {
  const out = Nav.sort(docsOf(['design-brief.md', 'automated-pursuit-brief.md', 'brief.md', 'a-summary.md']), 'spine');
  // Only the exact filenames are the spine — `design-brief.md` is an ordinary document, and a folder
  // full of *-brief.md (the grant-developer one) must not have one of them promoted at random.
  assert.deepEqual(namesOf(out), ['brief.md', 'a-summary.md', 'automated-pursuit-brief.md', 'design-brief.md']);
});

test('spine sort: an .html asset sits in the same order as markdown, by name', () => {
  const out = Nav.sort(docsOf(['poster.html', 'notes.md', 'summary.md']), 'spine');
  assert.deepEqual(namesOf(out), ['summary.md', 'notes.md', 'poster.html']);
});

test('spine sort: names collate numerically, so slice2 comes before slice10', () => {
  const out = Nav.sort(docsOf(['slice10-walkthrough.md', 'slice2-walkthrough.md']), 'spine');
  assert.deepEqual(namesOf(out), ['slice2-walkthrough.md', 'slice10-walkthrough.md']);
});

test('spine sort is total and repeatable — case never leaves two names tied to readdir order', () => {
  const a = Nav.sort(docsOf(['Beta.md', 'beta.md', 'Alpha.md']), 'spine');
  const b = Nav.sort(docsOf(['beta.md', 'Alpha.md', 'Beta.md']), 'spine');
  assert.deepEqual(namesOf(a), namesOf(b), 'the same set sorts the same way whatever order it arrives in');
  assert.equal(namesOf(a)[0], 'Alpha.md');
});

test('sort does not mutate the list it is given', () => {
  const input = docsOf(['zeta.md', 'summary.md']);
  Nav.sort(input, 'spine');
  assert.deepEqual(namesOf(input), ['zeta.md', 'summary.md'], 'the caller keeps its own order');
});

test('updated sort: newest first, and equal timestamps fall back to spine order', () => {
  const docs = [
    { rel: 'p/old.md', name: 'old.md', mtime: 10 },
    { rel: 'p/new.md', name: 'new.md', mtime: 90 },
    { rel: 'p/zeta.md', name: 'zeta.md', mtime: 50 },
    { rel: 'p/summary.md', name: 'summary.md', mtime: 50 },
  ];
  assert.deepEqual(namesOf(Nav.sort(docs, 'updated')), ['new.md', 'summary.md', 'zeta.md', 'old.md']);
});

test('updated sort: a document with no mtime sorts last rather than throwing', () => {
  const docs = [{ rel: 'p/a.md', name: 'a.md' }, { rel: 'p/b.md', name: 'b.md', mtime: 5 }];
  assert.deepEqual(namesOf(Nav.sort(docs, 'updated')), ['b.md', 'a.md']);
});

test('waiting-on-you sort: turn counts descending, and with none it IS spine order', () => {
  const plain = docsOf(['zeta.md', 'brief.md', 'summary.md']);
  // A folder where nothing is open (or where no document has a sidecar at all) carries no counts, and
  // the mode has to resolve to the spine order rather than to whatever readdir returned.
  assert.deepEqual(namesOf(Nav.sort(plain, 'turn')), namesOf(Nav.sort(plain, 'spine')));
  const counted = [
    { rel: 'p/summary.md', name: 'summary.md', turn: 0 },
    { rel: 'p/zeta.md', name: 'zeta.md', turn: 3 },
    { rel: 'p/brief.md', name: 'brief.md', turn: 1 },
  ];
  assert.deepEqual(namesOf(Nav.sort(counted, 'turn')), ['zeta.md', 'brief.md', 'summary.md']);
});

test('an unknown sort mode falls back to spine rather than to nothing', () => {
  const docs = docsOf(['zeta.md', 'summary.md']);
  assert.deepEqual(namesOf(Nav.sort(docs, 'nonsense')), ['summary.md', 'zeta.md']);
  assert.deepEqual(namesOf(Nav.sort(docs, undefined)), ['summary.md', 'zeta.md']);
  assert.deepEqual(Nav.sort(undefined, 'spine'), [], 'and no list at all is an empty one');
});

test('every sort mode the panel offers is one the sorter answers to', () => {
  // The switcher renders straight off MODES/LABELS, so a mode with no label would draw as `undefined`.
  for (const m of Nav.MODES) assert.equal(typeof Nav.LABELS[m], 'string', `${m} has a label`);
  assert.deepEqual(Nav.MODES, ['spine', 'updated', 'turn']);
});

// ---------- whose turn is it: the panel's badges and the inbox (public/turn.js) ----------
// The SAME file index.html loads via <script> AND server.js requires — the badge the panel draws and
// the count /api/dir computes are this function, once. Every case below is therefore a case both
// sides answer identically, which is the whole reason it is one module.
const Turn = require('./public/turn.js');
const AGENT = 'claude', HUMAN = 'alex';
let seq = 0;
const msg = (by, text) => ({ by, at: new Date(Date.UTC(2026, 7, 15, 12, 0, seq++)).toISOString(), text });
const comment = (id, status, ...thread) =>
  ({ id, kind: 'comment', by: thread[0] ? thread[0].by : AGENT, anchor: { quote: 'the ' + id + ' span' }, status, thread });
const sug = (id, status) => ({ id, kind: 'suggestion', by: AGENT, anchor: { quote: 'the ' + id + ' span' }, replacement: 'x', status });

test('a doc with two agent-last threads and one pending suggestion badges 3', () => {
  // The acceptance case from the plan, stated as arithmetic.
  const review = { schema: 1, items: [
    comment('c1', 'open', msg(HUMAN, 'what about this'), msg(AGENT, 'here is why')),
    comment('c2', 'open', msg(AGENT, 'this paragraph contradicts the one above')),
    sug('s1', 'pending'),
    comment('c3', 'open', msg(AGENT, 'a question'), msg(HUMAN, 'answered')),   // the agent's move now
    comment('c4', 'resolved', msg(AGENT, 'settled')),                           // not live at all
    sug('s2', 'accepted'),
  ] };
  const t = Turn.of(review, AGENT);
  assert.equal(t.turn, 3, 'two agent-last comments and one pending suggestion');
  assert.equal(t.open, 4, 'the human-last comment is open too, just not yours');
  assert.deepEqual(t.items.filter(i => i.turn).map(i => i.id), ['c1', 'c2', 's1']);
});

test('turn is keyed off the agent NAME, so any other author reads as the human', () => {
  const review = { schema: 1, items: [comment('c1', 'open', msg('gemini', 'hello'))] };
  assert.equal(Turn.of(review, 'gemini').turn, 1, 'a differently named agent still holds the turn');
  assert.equal(Turn.of(review, AGENT).turn, 0, 'and to claude it is someone else speaking');
  // The default SIDECAR_USER, a legacy `alex`, and a custom name all read as the human — the same rule
  // index.html's whoCls uses to colour the chip.
  for (const who of ['you', 'alex', 'Alexandra']) {
    assert.equal(Turn.of({ items: [comment('c1', 'open', msg(who, 'hi'))] }, AGENT).turn, 0, who);
  }
});

test('a comment with no thread falls back to its author', () => {
  // `sidecar comment` always writes a thread, but an item hand-written into the JSON may not have one,
  // and an agent's unanswered comment is the clearest "your turn" there is.
  const bare = { id: 'c1', kind: 'comment', by: AGENT, anchor: { quote: 'x' }, status: 'open' };
  assert.equal(Turn.of({ items: [bare] }, AGENT).turn, 1);
  assert.equal(Turn.of({ items: [{ ...bare, by: HUMAN }] }, AGENT).turn, 0);
});

test('an orphaned suggestion is open but is the AGENT\'s move; an orphaned comment keeps the thread rule', () => {
  // Repairing a broken anchor is `sidecar reanchor`, which the human cannot run — so it gets the
  // neutral dot. A comment on a broken anchor is still a conversation, and whoever spoke last owns it.
  const t = Turn.of({ items: [
    sug('s1', 'orphaned'),
    comment('c1', 'orphaned', msg(AGENT, 'still asking')),
    comment('c2', 'orphaned', msg(HUMAN, 'still answering')),
  ] }, AGENT);
  assert.equal(t.open, 3);
  assert.deepEqual(t.items.filter(i => i.turn).map(i => i.id), ['c1']);
});

test('a settled item counts for nothing, whatever it used to be', () => {
  const t = Turn.of({ items: [
    comment('c1', 'resolved', msg(AGENT, 'x')), sug('s1', 'accepted'), sug('s2', 'rejected'),
  ] }, AGENT);
  assert.deepEqual(t, { turn: 0, open: 0, items: [] });
});

test('a missing, empty or malformed review is zero badges rather than a throw', () => {
  // The renamed-file case: a document whose sidecar is still `.review.json` has no `.sidecar.json` for
  // the panel to read, and one truncated by a crashed write parses to nothing useful. Neither may take
  // the folder listing down with it — every OTHER document in that folder still has to draw.
  for (const bad of [undefined, null, {}, { items: null }, { items: [] }, { items: [{}] },
                     { items: [{ id: 'x', status: 'open' }] }]) {
    const t = Turn.of(bad, AGENT);
    assert.equal(t.turn, 0, JSON.stringify(bad));
  }
  // An item with no anchor and no kind is still LIVE and still counts as open — it is a real card in
  // the rail. It just has no quote to show, and the inbox says so rather than rendering "undefined".
  assert.equal(Turn.of({ items: [{ id: 'x', status: 'open' }] }, AGENT).open, 1);
  assert.equal(Turn.of({ items: [{ id: 'x', status: 'open' }] }, AGENT).items[0].quote, '');
});

test('an inbox item carries enough to be recognised, with the quote cut to one line', () => {
  const long = 'word '.repeat(80).trim();
  const it = Turn.of({ items: [{ id: 'c1', kind: 'comment', by: HUMAN, status: 'open',
    anchor: { quote: 'a\n  quote   across\nlines' }, thread: [msg(AGENT, 'hi')] }] }, AGENT).items[0];
  assert.equal(it.by, AGENT, 'who spoke LAST, which is who the row is waiting on');
  assert.equal(it.kind, 'comment');
  assert.equal(it.quote, 'a quote across lines', 'whitespace collapsed to one line');
  assert.ok(it.at, 'and when it last moved');
  const cut = Turn.of({ items: [comment('c1', 'open', msg(AGENT, long))] }, AGENT).items[0];
  assert.ok(cut.quote.length <= Turn.QUOTE_MAX, 'never longer than the cap');
  const big = Turn.of({ items: [{ id: 'c1', kind: 'comment', status: 'open', anchor: { quote: long } }] }, AGENT);
  assert.equal(big.items[0].quote.length, Turn.QUOTE_MAX);
  assert.ok(big.items[0].quote.endsWith('…'), 'and says it was cut');
});

test('a flag reads as its own kind, so the inbox does not call it a comment', () => {
  const t = Turn.of({ items: [{ id: 'f1', kind: 'comment', flag: true, by: AGENT, status: 'open',
    anchor: { quote: 'x' }, thread: [msg(AGENT, 'blocking')] }] }, AGENT);
  assert.equal(t.items[0].kind, 'flag');
  assert.equal(t.turn, 1, 'and it is still the human\'s turn');
});

test('inbox: grouped by document, your turn first, newest first inside a group', () => {
  const docs = [
    { rel: 'p/summary.md', name: 'summary.md', turn: 0,
      items: Turn.of({ items: [comment('c1', 'open', msg(HUMAN, 'mine'))] }, AGENT).items },
    { rel: 'p/brief.md', name: 'brief.md', turn: 2, items: Turn.of({ items: [
      comment('b1', 'open', msg(AGENT, 'older')),
      comment('b2', 'open', msg(AGENT, 'newer')),
    ] }, AGENT).items },
    { rel: 'p/quiet.md', name: 'quiet.md', turn: 0, items: [] },
  ];
  const groups = Turn.inbox(docs);
  assert.deepEqual(groups.map(g => g.name), ['brief.md', 'summary.md'],
    'the document waiting on you leads, and one with nothing open is not in the inbox at all');
  assert.deepEqual(groups[0].items.map(i => i.id), ['b2', 'b1'], 'newest first inside a group');
  assert.equal(groups[0].turn, 2);
  assert.equal(groups[0].open, 2);
});

test('inbox: with no turns anywhere, the most recently moved document leads', () => {
  const older = { rel: 'p/a.md', name: 'a.md', turn: 0, items: [{ id: 'a1', at: '2026-08-01T00:00:00Z' }] };
  const newer = { rel: 'p/z.md', name: 'z.md', turn: 0, items: [{ id: 'z1', at: '2026-08-14T00:00:00Z' }] };
  assert.deepEqual(Turn.inbox([older, newer]).map(g => g.name), ['z.md', 'a.md']);
  assert.deepEqual(Turn.inbox([]), [], 'and an empty folder is an empty inbox');
});

test('inbox: items with no timestamp fall back to the order they were written in', () => {
  // A suggestion is born as a diff with no thread and so has no `at` at all. Two of them must not
  // shuffle between renders — insertion order in the file IS chronological, so it is the tiebreak.
  const items = Turn.of({ items: [sug('s1', 'pending'), sug('s2', 'pending'), sug('s3', 'pending')] }, AGENT).items;
  const once = Turn.inbox([{ rel: 'p/a.md', name: 'a.md', turn: 3, items }]);
  const again = Turn.inbox([{ rel: 'p/a.md', name: 'a.md', turn: 3, items: items.slice().reverse() }]);
  assert.deepEqual(once[0].items.map(i => i.id), ['s3', 's2', 's1'], 'last written, first shown');
  assert.deepEqual(again[0].items.map(i => i.id), once[0].items.map(i => i.id), 'whatever order it arrives in');
});

test('inbox does not mutate the documents it is given', () => {
  const items = Turn.of({ items: [comment('c1', 'open', msg(AGENT, 'a')), comment('c2', 'open', msg(AGENT, 'b'))] }, AGENT).items;
  const docs = [{ rel: 'p/a.md', name: 'a.md', turn: 2, items }];
  Turn.inbox(docs);
  assert.deepEqual(items.map(i => i.id), ['c1', 'c2'], 'the caller keeps its own order');
});

// ---------- which links open IN sidecar (public/doclink.js) ----------
// The SAME file index.html loads via <script>. Three callers ask it the question — the document's two
// click handlers and the asset frame's pick — so every case below is a case all three follow.
const DocLink = require('./public/doclink.js');
const cliAllow = require('./lib/cli.js');
const BRIEF = 'vault/projects/ccdc-portal/brief.md';

test('a relative link to a sibling document opens in sidecar, however it is written', () => {
  for (const href of ['market-research.md', './market-research.md', './/market-research.md',
                      'sub/../market-research.md']) {
    assert.deepEqual(DocLink.route(href, BRIEF),
      { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' }, href);
  }
  assert.deepEqual(DocLink.route('slices/slice1.md', BRIEF),
    { rel: 'vault/projects/ccdc-portal/slices/slice1.md', hash: '' }, 'and one a folder down');
  assert.deepEqual(DocLink.route('../grant-developer/brief.md', BRIEF),
    { rel: 'vault/projects/grant-developer/brief.md', hash: '' }, 'and one a folder up');
});

test('an .html asset is a document too, and both extension lists are the CLI\'s', () => {
  assert.deepEqual(DocLink.route('./poster.html', BRIEF),
    { rel: 'vault/projects/ccdc-portal/poster.html', hash: '' });
  assert.deepEqual(DocLink.route('./NOTES.MD', BRIEF),
    { rel: 'vault/projects/ccdc-portal/NOTES.MD', hash: '' }, 'the extension is matched case-blind');
  // lib/cli.js cannot be require'd from a browser, so this file carries its own copy of the two
  // allowlists. A document kind the CLI reviews and this one does not know about is a link that
  // reloads the whole page instead of switching in place.
  assert.deepEqual(DocLink.MARKDOWN, cliAllow.MARKDOWN);
  assert.deepEqual(DocLink.ASSETS, cliAllow.ASSETS);
});

test('a link that is not a document in this root is left exactly as it is', () => {
  const native = [
    'https://example.com/doc.md', 'http://other.host/x.md',   // another host
    'mailto:alex@example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/x.md',
    '//example.com/x.md',                                     // protocol-relative
    '/absolute/x.md', '/?f=other.md',                         // a URL on this origin, not a path in the root
    '#a-heading', '#',                                        // an anchor within this document
    'notes.txt', 'script.js', 'photo.png', 'README',          // not a kind sidecar reviews
    'folder/', '', '   ', './',
    '../../../../../../etc/passwd.md',                        // out of the served root
    'research.md?raw=1',                                      // a query is not part of any path in the root
  ];
  for (const href of native) assert.equal(DocLink.route(href, BRIEF), null, JSON.stringify(href));
});

test('climbing out of the served root is refused, and climbing back in is not', () => {
  // The root is implicit: every path is relative to it, so a link that runs out of segments to pop has
  // walked out of everything sidecar serves. The server would refuse it (safePath) and the page must
  // not ask.
  assert.equal(DocLink.route('../../../../other.md', BRIEF), null);
  assert.equal(DocLink.route('../x.md', 'top.md'), null, 'a document at the root has nowhere above it');
  assert.deepEqual(DocLink.route('./x.md', 'top.md'), { rel: 'x.md', hash: '' });
  assert.deepEqual(DocLink.route('../../people/alex.md', BRIEF),
    { rel: 'vault/people/alex.md', hash: '' }, 'two up and along is still inside');
});

test('a fragment rides along, and a fragment alone is an anchor in this document', () => {
  assert.deepEqual(DocLink.route('./market-research.md#the-bet', BRIEF),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: 'the-bet' });
  assert.equal(DocLink.route('#the-bet', BRIEF), null, 'same document: the browser already does this');
});

test('a written link is percent-encoded and a path on disk is not', () => {
  assert.deepEqual(DocLink.route('./market%20research.md', BRIEF),
    { rel: 'vault/projects/ccdc-portal/market research.md', hash: '' });
  assert.equal(DocLink.route('./%E0%A4%A.md', BRIEF), null, 'and a malformed escape is left alone');
});

test('a link to the open document itself still resolves to it', () => {
  // openDoc no-ops on the document already showing, so the answer here is "yes, that one" rather than
  // a special case this file has to know about.
  assert.deepEqual(DocLink.route('./brief.md', BRIEF), { rel: BRIEF, hash: '' });
});

// ---------- anchor stability while an agent edits (public/stability.js) ----------
// The SAME file index.html loads via <script>. Everything here is a pure function of arguments plus
// recorded state, with the clock passed in, so the whole edit → orphan → reanchor sequence can be run
// in milliseconds. The scenario throughout: a human is reading a card, an agent rewrites the sentence
// it is anchored to, and `sidecar reanchor` follows a few seconds later.
const Stability = require('./public/stability.js');
const GRACE = Stability.GRACE_MS;

test('a card that was live holds its normal face until the grace window expires', () => {
  const s = Stability.create();
  let t = 1000;
  s.observe('c1', true, t);                                  // the anchor matched on load
  t += 500;
  s.observe('c1', false, t);                                 // the agent rewrote the sentence
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t), false, 'not the instant it breaks');
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + GRACE - 1), false, 'nor a millisecond early');
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + GRACE), true, 'and then it admits it');
});

test('a reanchor inside the window means the card never flips at all', () => {
  const s = Stability.create();
  let t = 1000;
  s.observe('c1', true, t);
  s.observe('c1', false, t + 100);                           // edit lands
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 3000), false);
  s.observe('c1', true, t + 3500);                           // `sidecar reanchor` lands
  assert.equal(s.showOrphaned('c1', false, undefined, t + 3600), false, 'and the file agrees');
  // The clock is reset by the match, so a LATER break gets a full window of its own rather than the
  // remains of the first one.
  s.observe('c1', false, t + 4000);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 4000 + GRACE - 1), false);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 4000 + GRACE), true);
});

test('never-matched and element-changed skip the window, for opposite reasons', () => {
  const s = Stability.create();
  s.observe('bad', true, 1000);                              // even with a live observation behind it
  s.observe('bad', false, 1100);
  // A bad anchor from birth: there is nothing to protect and the whole point of surfacing it is that
  // somebody has to fix it.
  assert.equal(s.showOrphaned('bad', true, 'never-matched', 1100), true);
  // An element anchor: the browser picker has a DOM and has already done its own deferring.
  assert.equal(s.showOrphaned('bad', true, 'element-changed', 1100), true);
  assert.deepEqual(Stability.IMMEDIATE, ['never-matched', 'element-changed']);
});

test('a cold load of an already-orphaned item shows it at once', () => {
  // Nothing was ever remembered about it, so there is no "last position" to hold it at and no reason to
  // pretend it is fine. This is the pre-existing behaviour, and it is the default.
  const s = Stability.create();
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), true, 'never observed at all');
  s.observe('c1', false, 1000);                              // observed, and it has never matched
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), true);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000 + GRACE * 10), true);
});

test('the file calling it orphaned while our own matcher still finds it is not a flash', () => {
  // The two can disagree for a moment in either direction: the review file and the document arrive as
  // two separate fs events. The card follows what the page can see.
  const s = Stability.create();
  s.observe('c1', true, 1000);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), false);
  assert.equal(s.showOrphaned('c1', false, undefined, 1000), false, 'and a live item is never orphaned');
});

test('one timer ends the window, armed at the earliest card that needs it', () => {
  // Nothing re-renders once the file stops changing, so without this a grace that expires between
  // events would leave a card open forever on a dead anchor.
  const s = Stability.create();
  assert.equal(s.nextFlip(1000), null, 'nothing pending, no timer');
  s.observe('a', true, 1000); s.observe('b', true, 1000);
  s.observe('a', false, 2000);
  s.observe('b', false, 3000);
  assert.equal(s.nextFlip(3000), GRACE - 1000, 'the earlier break is the one that decides');
  s.observe('a', true, 4000);
  assert.equal(s.nextFlip(4000), GRACE - 1000, 'a repaired anchor drops out of the reckoning');
  // A window that has already expired is NOT pending. Reporting 0 for one asks for an immediate
  // render, the record survives it (the anchor is still broken), and the next arm asks again: a card
  // nobody repairs spins the rail for as long as the tab is open. Live testing found exactly that.
  assert.equal(s.nextFlip(3000 + GRACE), null, 'a card that has already flipped wants no more timers');
  s.observe('a', false, 3000 + GRACE);
  assert.equal(s.nextFlip(3000 + GRACE), GRACE, 'and a fresh break still gets its own');
});

test('a text-changed orphan keeps the rank and the pixel it last held', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);              // where it docked while its anchor matched
  // The anchor stops matching: docRank hands over -1 and dockCards has no mark to measure.
  assert.equal(s.rankFor('c1', -1, 'text-changed'), 4200, 'it does not float to the top');
  assert.equal(s.topFor('c1', null, 'text-changed'), 318, 'it does not take the next free slot');
  // A live mark always wins: the reanchor lands and the card goes where the document says.
  assert.equal(s.rankFor('c1', 9100, 'text-changed'), 9100);
  assert.equal(s.topFor('c1', 640, null), 640);
});

test('a never-matched anchor still floats to the top of the rail', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);
  assert.equal(s.rankFor('c1', -1, 'never-matched'), -1);
  assert.equal(s.topFor('c1', null, 'never-matched'), null, 'null → dockCards gives it the next slot');
  assert.equal(s.rankFor('c1', -1, 'element-changed'), -1, 'and so does an element that is gone');
});

test('an item with nothing remembered behaves exactly as it always did', () => {
  const s = Stability.create();
  assert.equal(s.rankFor('c1', -1, 'text-changed'), -1);
  assert.equal(s.topFor('c1', null, 'text-changed'), null);
  s.noteRank('c1', -1); s.noteTop('c1', null);               // a non-position is not a memory
  assert.equal(s.rankFor('c1', -1, 'text-changed'), -1);
  assert.equal(s.topFor('c1', null, 'text-changed'), null);
});

test('a frozen card outranks the document itself, and releasing hands it back', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);
  s.pin('c1', 318, 4200);                                    // the caret entered its reply box
  assert.equal(s.isPinned('c1'), true);
  assert.equal(s.pinnedTop('c1'), 318);
  // Everything the document could say while a reply is being typed: the anchor moved, the anchor died,
  // the anchor came back somewhere else. The card does not move for any of it.
  assert.equal(s.topFor('c1', 950, null), 318, 'not even for a live mark somewhere else');
  assert.equal(s.rankFor('c1', 9100, null), 4200);
  assert.equal(s.topFor('c1', null, 'text-changed'), 318);
  assert.equal(s.rankFor('c1', -1, 'never-matched'), 4200, 'nor for the float-to-top rule');
  // Pinning is idempotent: syncFreeze runs on every dock, and a second pin would re-baseline the card
  // to wherever it had drifted instead of holding the position the caret arrived on.
  s.pin('c1', 999, 8888);
  assert.equal(s.pinnedTop('c1'), 318);
  s.unpin('c1');
  assert.equal(s.topFor('c1', 950, null), 950, 'blurred and empty: the document has it back');
});

test('a pin with no rank behind it falls back to the last one, then to the top', () => {
  const s = Stability.create();
  s.noteRank('c1', 77);
  assert.equal(s.pin('c1', 100).rank, 77);
  const s2 = Stability.create();
  assert.equal(s2.pin('fresh', 100).rank, -1, 'a card that has never ranked pins where it is, at the top');
});

test('the position memory is evicted with the item and cleared with the document', () => {
  const s = Stability.create();
  for (const id of ['a', 'b', 'c']) { s.observe(id, true, 1000); s.noteRank(id, 10); s.noteTop(id, 20); }
  s.keep(['a', 'c']);                                        // b was resolved, so it leaves the rail
  assert.equal(s.size(), 2);
  assert.equal(s.rankFor('b', -1, 'text-changed'), -1, 'and takes its remembered position with it');
  assert.equal(s.rankFor('a', -1, 'text-changed'), 10, 'while the survivors keep theirs');
  // The document swap. A position measured in one document says nothing true about the next one, which
  // is why resetDocState calls this.
  s.reset();
  assert.equal(s.size(), 0);
  assert.equal(s.showOrphaned('a', true, 'text-changed', 1000), true, 'a cold rail again');
});

test('the page loads the stability module from the server, not a copy of it', async () => {
  // Same contract as the other shared modules: one file, loaded by the browser and required by these
  // tests, so the rules cannot drift into two versions.
  const served = await fetchRetry(`${BASE}/`).then(r => r.text());
  assert.match(served, /<script src="\/stability\.js">/, 'the page asks for it');
  const js = await fetchRetry(`${BASE}/stability.js`);
  assert.equal(js.status, 200, 'and the server hands it over');
  assert.match(await js.text(), /GRACE_MS/);
});

test('showOrphaned records nothing, so a card that is never docked is never evicted', () => {
  // A nested reply-suggestion renders inside its parent's thread: it is never ranked and never docked,
  // so it is never observed. Asking about it must not create a record that keep() would then evict,
  // which would make the answer depend on how recently the rail happened to render.
  const s = Stability.create();
  assert.equal(s.showOrphaned('nested', true, 'text-changed', 1000), true);
  assert.equal(s.size(), 0);
});

test('atomic blocks: a flow fence and an HTML island survive an edit elsewhere, byte-for-byte', () => {
  const { doc, blocks, td } = buildDoc(VIS_DOC);
  blockByText(doc, 'Middle paragraph.').querySelector('p').textContent = 'Middle paragraph, edited.';
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'block count unchanged → tight path');
  assert.equal(md, VIS_DOC.replace('Middle paragraph.', 'Middle paragraph, edited.'));
  assert.ok(md.includes(FLOW_SRC), 'the flow fence survived byte-for-byte');
  assert.ok(md.includes(HTML_SRC), 'the HTML island survived byte-for-byte');
});

test('atomic blocks survive the block-count-changed fallback path', () => {
  const { doc, blocks, td } = buildDoc(VIS_DOC);
  blockByText(doc, 'Closing paragraph.').remove();
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, false, 'block count changed → fallback path');
  assert.ok(md.includes(FLOW_SRC), 'flow fence survived the fallback (turndown would flatten it to labels)');
  assert.ok(md.includes(HTML_SRC), 'HTML island survived the fallback');
  assert.ok(!md.includes('Closing paragraph.'), 'the removed block is gone');
});

test('atomic blocks are not editable, so the turndown path is unreachable for them', () => {
  const { doc } = buildDoc(VIS_DOC);
  const atomic = [...doc.querySelectorAll('.block[data-atomic]')];
  assert.equal(atomic.length, 2, 'the flow fence and the HTML block are both atomic');
  for (const el of atomic) assert.equal(el.contentEditable, 'false');
});

test('toMd on an atomic block with no source THROWS rather than flattening it', () => {
  const { doc, td } = buildDoc(VIS_DOC);
  const el = doc.querySelector('.block[data-atomic]');
  delete el.__md;
  // A silent turndown fallback here IS the data-loss bug: the diagram would come back as its bare
  // label text and the fence would be gone from the file, with nothing logged.
  assert.throws(() => Serialize.toMd(el, td), /missing its __md/);
});

test('a comment can anchor to a diagram node label inside a flow fence', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-flow-'));
  fs.writeFileSync(path.join(d, 'f.md'), VIS_DOC);
  // A node label appears once per EDGE that names it, so from the CLI a node comment is ambiguous by
  // construction and the existing guard refuses it without --occurrence. That guard is right — this
  // pins the shape agents actually have to use.
  assert.throws(() => cli(d, 'comment', 'f.md', '--quote', 'Verify email', '--text', 'x'),
    /ambiguous — 3 matches/, 'a bare node label is refused, not silently anchored to the first mention');
  cli(d, 'comment', 'f.md', '--quote', 'Verify email', '--occurrence', '0', '--text', 'is this step needed?');
  const it = JSON.parse(fs.readFileSync(path.join(d, 'f.md.sidecar.json'), 'utf8')).items[0];
  assert.equal(it.status, 'open', 'a node label anchors like any other quote — not orphaned');
  const hit = Anchor.findNth(VIS_DOC, it.anchor.quote, it.anchor.occurrence || 0);
  assert.ok(hit, 'the anchor resolves in the document');
  assert.ok(VIS_DOC.slice(hit.start, hit.end) === 'Verify email');
  fs.rmSync(d, { recursive: true, force: true });
});

test('assets: a relative image beside the document is served with a locked-down type', async () => {
  fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./pic.svg')}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  // An SVG is a document, and this origin carries the file read/write API — so nothing it references
  // may load, and the type may not be sniffed into something executable.
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('assets refuses traversal, absolute paths, URLs and non-images', async () => {
  const cases = [
    ['../../../../etc/hosts', 'traversal to a non-image'],
    ['../../../../tmp/evil.png', 'traversal to an image extension outside the root'],
    ['/etc/hosts', 'an absolute path'],
    ['https://example.com/a.png', 'a remote URL'],
    ['./doc.md', 'a non-image inside the root'],
  ];
  for (const [src, why] of cases) {
    const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(src)}`);
    assert.ok(r.status >= 400 && r.status < 500, `${why} must be refused, got ${r.status}`);
    assert.match(r.headers.get('content-type') || '', /json/, `${why}: error must be JSON`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   IMAGES IN COMMENTS — a pasted screenshot becomes a file in `<doc>.sidecar.assets/`
   and a markdown link in the comment body. The review JSON never holds bytes, and
   the reference is the same doc-relative form /assets already serves.
   ──────────────────────────────────────────────────────────────────────────── */
// A real 1×1 PNG. The upload sniffs magic bytes, so a fake buffer wouldn't get through — which is
// the point of having it here rather than asserting against a stub.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const postBytes = (url, buf, type = 'application/octet-stream') =>
  fetchRetry(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': type }, body: buf });

test('asset upload writes a content-hashed file beside the review and returns doc-relative markdown', async () => {
  const r = await postBytes('/api/asset?doc=doc.md', PNG_1x1);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.match(out.src, /^doc\.md\.sidecar\.assets\/[0-9a-f]{12}\.png$/);
  assert.equal(out.markdown, `![](${out.src})`);
  assert.ok(fs.existsSync(path.join(dir, out.src)), 'the bytes landed on disk');
  assert.deepEqual(fs.readFileSync(path.join(dir, out.src)), PNG_1x1, 'byte-identical, not re-encoded');
  // The whole design rests on this: the reference a comment stores is exactly what /assets resolves,
  // so an attachment needs no serving code of its own. If this 404s, images render as broken icons.
  const served = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(out.src)}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') || '', /image\/png/);
});

test('the same image twice is one file — content-addressed, so re-pasting does not litter', async () => {
  const a = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  const b = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  assert.equal(a.src, b.src);
  const files = fs.readdirSync(path.join(dir, 'doc.md.sidecar.assets'));
  assert.equal(files.filter(f => f.endsWith('.png')).length, 1);
  assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0, 'no temp file left behind');
});

test('asset upload refuses non-images by their BYTES, not their claimed type', async () => {
  // Content-Type says PNG and it is HTML. The extension decides how /assets serves it, so a file that
  // lies about itself must never get one — sniffing is what keeps the two honest.
  const r = await postBytes('/api/asset?doc=doc.md', Buffer.from('<html><script>alert(1)</script>'), 'image/png');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not an image/);
});

test('asset upload refuses an unknown document — an attachment is not a write primitive', async () => {
  // Without the existence check this would create `<anything>.sidecar.assets/` anywhere under the root.
  const r = await postBytes('/api/asset?doc=nope.md', PNG_1x1);
  assert.equal(r.status, 404);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.md.sidecar.assets')), 'no directory created for a doc that is not there');
  const esc = await postBytes(`/api/asset?doc=${encodeURIComponent('../../../../tmp/evil.md')}`, PNG_1x1);
  assert.equal(esc.status, 403);
});

test('an image in a comment body survives the review round-trip as a path, never as bytes', async () => {
  const up = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  const s = await state();
  s.review.items.push({ id: 'cimg1', kind: 'comment', by: 'you', anchor: { quote: 'Closing paragraph.' },
    status: 'open', thread: [{ by: 'you', at: new Date().toISOString(), text: `look:\n\n${up.markdown}` }] });
  await put('/api/review', { path: 'doc.md', review: s.review });
  const raw = fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8');
  assert.match(raw, /doc\.md\.sidecar\.assets\//);
  assert.doesNotMatch(raw, /base64|data:image/, 'the sidecar stays a small text file');
});

test('CLI --image copies the file in and appends a markdown link to the comment', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'shot.png'), PNG_1x1);
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'see this', '--image', 'shot.png');
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));
  const body = review.items[0].thread[0].text;
  assert.match(body, /^see this\n\n!\[\]\(doc\.md\.sidecar\.assets\/[0-9a-f]{12}\.png\)$/);
  const rel = body.match(/\(([^)]+)\)/)[1];
  // Copied, not referenced: the agent's screenshot usually sits in a scratch dir that gets cleaned up,
  // and a review that renders only until then is a review that silently rots.
  assert.deepEqual(fs.readFileSync(path.join(d, rel)), PNG_1x1);
  fs.rmSync(path.join(d, 'shot.png'));
  assert.ok(fs.existsSync(path.join(d, rel)), 'the attachment outlives the source file');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI --image is repeatable, and refuses a path that is not there', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'a.png'), PNG_1x1);
  fs.writeFileSync(path.join(d, 'b.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]));
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'two', '--image', 'a.png', '--image', 'b.gif');
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));
  const links = [...review.items[0].thread[0].text.matchAll(/!\[\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.equal(links.length, 2);
  assert.match(links[0], /\.png$/); assert.match(links[1], /\.gif$/);

  const e = cliFails(d, 'reply', 'doc.md', review.items[0].id, 'here', '--image', 'ghost.png');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /no image at/);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   `sidecar skill` / `sidecar help` — how an agent that has the package finds
   out what the package can do. npx unpacks into ~/.npm/_npx/<hash>/, which no
   agent harness scans, so shipping SKILL.md is only half of delivering it.
   ──────────────────────────────────────────────────────────────────────────── */

test('CLI skill: prints SKILL.md verbatim, so the protocol matches the code that is running', () => {
  const d = cliDir();
  const out = cli(d, 'skill');
  assert.equal(out, fs.readFileSync(path.join(__dirname, 'skills', 'sidecar', 'SKILL.md'), 'utf8'));
  assert.match(out, /^---\nname: sidecar\n/, 'frontmatter intact — the output is installable as a skill');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI help: --help, -h and help all reach the banner, and it names both routes to the skill', () => {
  const d = cliDir();
  const out = cli(d, 'help');
  assert.equal(cli(d, '--help'), out);
  assert.equal(cli(d, '-h'), out);
  assert.match(out, /npx skills add smithavt14\/sidecar/, 'the install-where-the-agent-looks route');
  assert.match(out, /sidecar skill/, 'the no-install route');
  // Every verb the dispatcher knows should be discoverable from the banner, so a new one cannot be
  // added without documenting it. `help` is excluded: a usage screen listing itself is noise.
  const { COMMANDS } = require('./lib/cli.js');
  for (const c of COMMANDS.filter(c => c !== 'help'))
    assert.ok(out.includes(c), `help omits the ${c} verb`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the published tarball carries SKILL.md — `files` dropping skills/ would silently break `sidecar skill`', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills/'), 'package.json files must ship skills/');
  const { SKILL_PATH } = require('./lib/cli.js');
  assert.ok(fs.existsSync(SKILL_PATH), 'the path the CLI reads must exist in the package layout');
});

test('--version prints the package version and exits, instead of trying to serve "--version" as a dir', () => {
  const d = cliDir();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(cli(d, '--version').trim(), pkg.version);
  assert.equal(cli(d, '-v').trim(), pkg.version);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an unknown --flag is a typo, not a directory to serve — refuse instead of booting a server', () => {
  const d = cliDir();
  const e = cliFails(d, '--bogus');
  assert.ok(e, 'must exit non-zero');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /unknown option "--bogus"/);
  // The bug this guards: falling through meant `sidecar --version` booted a server on a taken port
  // and died with an unhandled 'error' stack dump.
  assert.doesNotMatch(e.stderr, /EADDRINUSE|Unhandled 'error'/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('/api/state ships codeDir + version, so doctor can tell a stale server from a different install', async () => {
  // doctor compared its own code stamp against the server's blind. For anyone who installed from npm
  // those are different installations by construction, so it reported STALE at every such user forever.
  const d = cliDir();
  const port = PORT + 13;
  const srv = await new Promise((res, rej) => {
    const p = spawn('node', [BIN, d], { env: { ...process.env, SIDECAR_PORT: String(port) }, stdio: 'pipe' });
    p.stdout.on('data', (b) => { if (b.toString().includes('ready')) res(p); });
    p.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
  try {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/state?path=doc.md`)).json();
    assert.equal(typeof s.codeDir, 'string');
    assert.equal(path.resolve(s.codeDir), path.resolve(__dirname), 'codeDir is the server installation');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(s.version, pkg.version);
  } finally {
    srv.kill();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   ASSETS — an .html file reviewed as a rendered visual (1.7.0). A second
   document kind, and with it a second anchor kind: an item pins to an ELEMENT
   instead of to quoted text. The sandboxed frame that renders one arrives in
   phase 3; what is covered here is the store, the CLI, and the Node-side
   resolution rule that decides whether an element anchor is still live.
   ──────────────────────────────────────────────────────────────────────────── */

const Element = require('./lib/element.js');

const POSTER = `<!doctype html>
<html>
<head><style>h1 { font-size: 64px }</style></head>
<body>
  <main class="wrap">
    <h1 data-sc="headline">Train your own image gen model</h1>
    <p id="sub">Ten minutes, no GPU required.</p>
    <a data-sc='cta' href="/start">Get started</a>
    <img data-sc="shot" src="./pic.svg">
    <footer>© 2026 spktr</footer>
  </main>
</body>
</html>
`;

// An empty repo, not a committed one: `show` shells out to `git diff` and a temp dir that happens to
// sit inside someone's checkout would otherwise report that repo's changes.
function assetDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-asset-'));
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  execSync('git init -q', { cwd: d });
  return d;
}
const scAt = (d, name) => JSON.parse(fs.readFileSync(path.join(d, name + '.sidecar.json'), 'utf8'));

// ---------- the document kind, at the server's door ----------

test('/api/state classifies the document and refuses anything in neither allowlist', async () => {
  fs.writeFileSync(path.join(dir, 'poster.html'), POSTER);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a document\n');
  const asset = await fetchRetry(`${BASE}/api/state?path=poster.html`).then(j);
  assert.equal(asset.kind, 'asset');
  assert.equal(asset.markdown, POSTER, 'an asset arrives as its raw HTML');
  const md = await state();
  assert.equal(md.kind, 'markdown');
  // The seam this closes: `?f=notes.txt` loaded unguarded and rendered through the markdown path.
  const r = await fetchRetry(`${BASE}/api/state?path=notes.txt`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /markdown and html assets/);
});

test('save and format refuse an asset — it is read-only in the viewer', async () => {
  const before = fs.readFileSync(path.join(dir, 'poster.html'), 'utf8');
  const saved = await put('/api/save', { path: 'poster.html', content: '<h1>rewritten</h1>' });
  assert.equal(saved.status, 400);
  assert.match((await saved.json()).error, /read-only/);
  const formatted = await post('/api/format', { path: 'poster.html', quote: 'Get started', op: 'bold' });
  assert.equal(formatted.status, 400);
  assert.equal(fs.readFileSync(path.join(dir, 'poster.html'), 'utf8'), before, 'the file is untouched');
});

test('the file picker walk lists assets beside markdown', async () => {
  const { files } = await fetchRetry(`${BASE}/api/files`).then(j);
  const rels = files.map(f => f.rel);
  assert.ok(rels.includes('poster.html'), 'the asset is offered for review');
  assert.ok(rels.includes('doc.md'), 'markdown still is');
  assert.ok(!rels.includes('notes.txt'), 'and a file in neither allowlist is not');
});

test('the directory listing is one folder of documents: no recursion, no directories, no non-documents', async () => {
  fs.mkdirSync(path.join(dir, 'folder', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'folder', 'summary.md'), '# summary\n');
  fs.writeFileSync(path.join(dir, 'folder', 'card.html'), '<h1>card</h1>');
  fs.writeFileSync(path.join(dir, 'folder', 'notes.txt'), 'not a document');
  fs.writeFileSync(path.join(dir, 'folder', '.hidden.md'), '# hidden\n');
  fs.writeFileSync(path.join(dir, 'folder', 'deeper', 'buried.md'), '# buried\n');
  const d = await fetchRetry(`${BASE}/api/dir?path=folder`).then(j);
  assert.deepEqual(d.docs.map(x => x.name).sort(), ['card.html', 'summary.md']);
  assert.ok(d.docs.every(x => typeof x.mtime === 'number' && x.mtime > 0), 'each carries an mtime to sort by');
  assert.equal(d.docs[0].rel.startsWith('folder/'), true, 'rel is relative to the served root');
  assert.equal(d.dir, 'folder');
  assert.equal(d.parent, '', 'the parent of a top-level folder is the root itself');
});

test('the directory listing at the served root has no parent to walk up to', async () => {
  const d = await fetchRetry(`${BASE}/api/dir?path=`).then(j);
  assert.equal(d.dir, '');
  assert.equal(d.parent, null, 'null, not a path outside the root');
  assert.ok(d.docs.some(x => x.name === 'doc.md'));
  assert.ok(!d.docs.some(x => x.name === 'folder'), 'a directory is not a document');
});

test('the directory listing carries each document\'s turn count and its open items', async () => {
  // The badge's data path end to end: a review on disk → /api/dir → what the panel draws. The counting
  // is public/turn.js, asserted directly above; this is that the server runs it, per document, per
  // folder, and hands back the items the Inbox lists.
  const folder = path.join(dir, 'badges');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'brief.md'), '# brief\n\nA sentence to anchor to.\n');
  fs.writeFileSync(path.join(folder, 'quiet.md'), '# quiet\n\nNothing open here.\n');
  fs.writeFileSync(path.join(folder, 'brief.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'claude', anchor: { quote: 'A sentence' }, status: 'open',
      thread: [{ by: 'claude', at: '2026-08-15T10:00:00Z', text: 'asking' }] },
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'to anchor to' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-08-15T11:00:00Z', text: 'over to you' }] },
    { id: 's1', kind: 'suggestion', by: 'claude', anchor: { quote: 'sentence' }, replacement: 'line', status: 'pending' },
    { id: 'c3', kind: 'comment', by: 'alex', anchor: { quote: 'brief' }, status: 'resolved',
      thread: [{ by: 'alex', at: '2026-08-15T09:00:00Z', text: 'done' }] },
  ] }));
  const d = await fetchRetry(`${BASE}/api/dir?path=badges`).then(j);
  const brief = d.docs.find(x => x.name === 'brief.md'), quiet = d.docs.find(x => x.name === 'quiet.md');
  assert.equal(brief.turn, 2, 'the agent-last comment and the pending suggestion');
  assert.equal(brief.open, 3, 'the human-last one is open too');
  assert.deepEqual(brief.items.map(i => i.id), ['c1', 'c2', 's1'], 'and the settled one is gone');
  assert.equal(brief.items.find(i => i.id === 'c1').quote, 'A sentence', 'each item carries its span');
  assert.equal(quiet.turn, 0, 'a document with no sidecar at all');
  assert.equal(quiet.open, 0);
  assert.deepEqual(quiet.items, []);
});

test('a legacy or unreadable sidecar is zero badges, and the rest of the folder still lists', async () => {
  // The renamed-file case (pre-1.7 `.review.json`) and the crashed-write case, which must not take the
  // listing down with them. The panel counts only; migrating on a listing nobody asked to migrate would
  // rename a whole folder's siblings as a side effect of scrolling past it.
  const folder = path.join(dir, 'legacy');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'old.md'), '# old\n\nStill here.\n');
  fs.writeFileSync(path.join(folder, 'old.md.review.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'claude', anchor: { quote: 'Still here' }, status: 'open',
      thread: [{ by: 'claude', at: '2026-08-15T10:00:00Z', text: 'from before the rename' }] },
  ] }));
  fs.writeFileSync(path.join(folder, 'broken.md'), '# broken\n');
  fs.writeFileSync(path.join(folder, 'broken.md.sidecar.json'), '{"schema":1,"items":[{"id":"c1"');
  fs.writeFileSync(path.join(folder, 'fine.md'), '# fine\n');
  const d = await fetchRetry(`${BASE}/api/dir?path=legacy`).then(j);
  assert.deepEqual(d.docs.map(x => x.name).sort(), ['broken.md', 'fine.md', 'old.md'],
    'every document still lists');
  for (const x of d.docs) { assert.equal(x.turn, 0, x.name); assert.equal(x.open, 0, x.name); }
  assert.ok(fs.existsSync(path.join(folder, 'old.md.review.json')), 'and the listing renamed nothing');
});

test('the directory listing is confined to the served root, and refuses a file', async () => {
  const escaped = await fetchRetry(`${BASE}/api/dir?path=../..`);
  assert.equal(escaped.status, 400);
  assert.match((await escaped.json()).error, /escapes root/);
  const notADir = await fetchRetry(`${BASE}/api/dir?path=doc.md`);
  assert.equal(notADir.status, 404, 'a document is not a folder');
  const missing = await fetchRetry(`${BASE}/api/dir?path=nope`);
  assert.equal(missing.status, 404);
});

// A live /events subscription, resolved once the stream is open so a write made after it cannot slip
// through before the client is listening.
function sse(match, timeoutMs = 6000) {
  return new Promise((open) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET' }, (res) => {
      let buf = '';
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { req.destroy(); reject(new Error('no matching SSE event')); }, timeoutMs);
        res.on('data', (c) => {
          buf += c;
          for (const line of buf.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let d; try { d = JSON.parse(line.slice(6)); } catch { continue; }
            if (match(d)) { clearTimeout(timer); req.destroy(); resolve(d); }
          }
        });
      });
      open({ got });
    });
    req.on('error', () => {});
    req.end();
  });
}

test('the watcher fires on an asset, so an agent edit reloads the frame', async () => {
  const sub = await sse((e) => e.rel === 'watched.html');
  fs.writeFileSync(path.join(dir, 'watched.html'), POSTER);
  const ev = await sub.got;
  assert.equal(ev.rel, 'watched.html');
});

test('review PUT refuses an element sel that is not a plain name (the id guard, for the other anchor)', async () => {
  const r = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'cbad', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { sel: '[data-sc=x" onload=alert(1)]' }, quote: 'x' }, thread: [] }] } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /invalid element sel/);
});

// ---------- the Node-side resolution rule (lib/element.js) ----------

test('an element reference normalizes from all three forms an agent might type', () => {
  for (const ref of ['headline', '[data-sc=headline]', '[data-sc="headline"]', "[data-sc='headline']"])
    assert.equal(Element.parseRef(ref).sel, '[data-sc=headline]', `${ref} names the data-sc element`);
  assert.equal(Element.parseRef('#sub').sel, '#sub');
  // An id and a data-sc value that read alike are two different attributes, so the sel keeps them apart.
  assert.notEqual(Element.parseRef('#headline').sel, Element.parseRef('headline').sel);
  for (const bad of ['a b', '.cls', 'x"onload=1', '', '[class=x]'])
    assert.ok(Element.parseRef(bad).error, `${JSON.stringify(bad)} is refused`);
});

test('element liveness is textual in Node: the attribute, or the signature after tag-stripping', () => {
  assert.equal(Element.isLive(POSTER, { sel: '[data-sc=headline]' }), true, 'a double-quoted attribute');
  assert.equal(Element.isLive(POSTER, { sel: '[data-sc=cta]' }), true, 'a single-quoted one');
  assert.equal(Element.isLive(POSTER, { sel: '#sub' }), true, 'an id');
  assert.equal(Element.isLive('<h1 id=hero>x</h1>', { sel: '#hero' }), true, 'an unquoted one');
  assert.equal(Element.isLive('<h1 id=heroic>x</h1>', { sel: '#hero' }), false, 'and not a longer name that starts the same');
  assert.equal(Element.isLive('<p data-id="sub">x</p>', { sel: '#sub' }), false, 'nor a different attribute holding the value');
  assert.equal(Element.isLive('<p id="sub">x</p>', { sel: '[data-sc=sub]' }), false, 'an id is not a data-sc value');

  // The signature half: the attribute is gone, the content is not. Tags become spaces and the shared
  // matcher does the rest, so a signature spanning the source's line breaks still resolves.
  const relabelled = POSTER.replace('data-sc="headline"', 'class="big"');
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]' }), false, 'attribute gone, no signature');
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]', sig: 'Train your own image gen model' }), true);
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]', sig: 'Train your own text model' }), false);
  const wrapped = '<div>\n  <h1 class="big">Train your own\n  image gen model</h1>\n</div>';
  assert.equal(Element.isLive(wrapped, { sel: '[data-sc=headline]', sig: 'Train your own image gen model' }), true,
    'the signature goes through public/anchor.js, so whitespace normalizes exactly as a quote does');
});

test('mergeItem backfills path and sig onto an element anchor without clobbering the rest', () => {
  const { mergeItem } = require('./lib/review.js');
  const stored = { id: 'c1', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element: { sel: '[data-sc=headline]' }, quote: 'headline · Train your own image gen model' },
    thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'too long' }] };
  // What the picker sends once it has resolved the same element in a real DOM: the anchor alone.
  const merged = mergeItem(stored, { id: 'c1', anchor: { element: { path: 'main>h1', sig: 'Train your own image gen model' } } });
  assert.deepEqual(merged.anchor.element,
    { sel: '[data-sc=headline]', path: 'main>h1', sig: 'Train your own image gen model' });
  assert.equal(merged.anchor.quote, stored.anchor.quote, 'the synthesized quote every surface reads survives');
  assert.equal(merged.thread.length, 1);
  assert.equal(merged.status, 'open');
});

test('a text anchor still REPLACES on merge — reanchor must not inherit the old occurrence', () => {
  const { mergeItem } = require('./lib/review.js');
  const stored = { id: 'c1', kind: 'comment', status: 'open', anchor: { quote: 'old', occurrence: 3 }, thread: [] };
  const merged = mergeItem(stored, { id: 'c1', anchor: { quote: 'new' } });
  assert.deepEqual(merged.anchor, { quote: 'new' }, 'the element merge is scoped to element anchors');
});

// ---------- `sidecar elements` ----------

test('elements lists what an asset offers to anchor to: label, tag, and its text', () => {
  const d = assetDir();
  const out = cli(d, 'elements', 'poster.html');
  assert.match(out, /4 anchorable elements/);
  assert.match(out, /\[data-sc=headline\]\s+h1\s+Train your own image gen model/);
  assert.match(out, /#sub\s+p\s+Ten minutes, no GPU required\./);
  assert.match(out, /\[data-sc=cta\]\s+a\s+Get started/);
  assert.match(out, /\[data-sc=shot\]\s+img/, 'a void element is anchorable and simply has no text');
  assert.doesNotMatch(out, /footer/, 'an element carrying neither attribute is not anchorable');
  assert.match(out, /sidecar comment poster\.html --element headline/, 'and it names the command that uses one');
  fs.rmSync(d, { recursive: true, force: true });
});

test('elements is regex extraction, and these are its honest limits', () => {
  const d = assetDir();
  fs.writeFileSync(path.join(d, 'messy.html'), [
    '<!-- <div data-sc="commented">never rendered</div> -->',
    '<p data-sc="twin">first</p>',
    '<p data-sc="twin">second</p>',
    '<div data-sc="unclosed">open',
    '<p>the next paragraph</p>',
  ].join('\n'));
  const out = cli(d, 'elements', 'messy.html');
  // Nothing here knows what a comment is, so an attribute inside one is listed like any other.
  assert.match(out, /commented/);
  // Two elements sharing a label are both listed. The collision is real; hiding one would make
  // `elements` disagree with the file, and `check --element` says which way the frame will resolve it.
  assert.equal((out.match(/data-sc=twin/g) || []).length, 2);
  assert.match(cli(d, 'check', 'messy.html', '--element', 'twin'), /2 elements match .* not unique/);
  // A tag that never closes has no end to read to, so its snippet runs on into what follows.
  assert.match(out, /\[data-sc=unclosed\]\s+div\s+open the next paragraph/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('elements refuses a markdown document, and names the anchor kind that document does take', () => {
  const d = assetDir();
  const e = cliFails(d, 'elements', 'doc.md');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /is markdown/);
  assert.match(e.stderr, /--quote/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- comment / flag on an asset ----------

test('comment --element takes all three reference forms and stores one sel', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'bare data-sc value');
  cli(d, 'comment', 'poster.html', '--element', '[data-sc=cta]', '--text', 'selector form');
  cli(d, 'comment', 'poster.html', '--element', '#sub', '--text', 'id form');
  const sels = scAt(d, 'poster.html').items.map(i => i.anchor.element.sel);
  assert.deepEqual(sels, ['[data-sc=headline]', '[data-sc=cta]', '#sub']);
  const [first] = scAt(d, 'poster.html').items;
  assert.equal(first.anchor.quote, 'headline · Train your own image gen model',
    'the quote is synthesized from the label and the text, and is what every surface reads');
  assert.equal(first.anchor.element.path, undefined, 'path and sig stay absent until the picker resolves them');
  assert.equal(first.anchor.element.sig, undefined);
  assert.equal(first.status, 'open');
  assert.equal(first.kind, 'comment');
  fs.rmSync(d, { recursive: true, force: true });
});

test('flag works on an element too, and the anchor is validated before anything is written', () => {
  const d = assetDir();
  cli(d, 'flag', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  assert.equal(scAt(d, 'poster.html').items[0].flag, true);
  const e = cliFails(d, 'comment', 'poster.html', '--element', 'ghost', '--text', 'x');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /no element \[data-sc=ghost\] in the file/);
  assert.match(e.stderr, /sidecar elements/, 'and it names the command that would have shown the real ones');
  assert.equal(scAt(d, 'poster.html').items.length, 1, 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a sel that is not a plain name is refused at write time, as an item id is', () => {
  const d = assetDir();
  const e = cliFails(d, 'comment', 'poster.html', '--element', '[data-sc=a b]', '--text', 'x');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /plain name/);
  assert.ok(!fs.existsSync(path.join(d, 'poster.html.sidecar.json')), 'no sidecar written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the two cross-kind refusals: --quote on an asset, --element on markdown', () => {
  const d = assetDir();
  const onAsset = cliFails(d, 'comment', 'poster.html', '--quote', 'Get started', '--text', 'x');
  assert.equal(onAsset.status, 2);
  assert.match(onAsset.stderr, /is an asset/);
  assert.match(onAsset.stderr, /--element/);
  const onMarkdown = cliFails(d, 'comment', 'doc.md', '--element', 'headline', '--text', 'x');
  assert.equal(onMarkdown.status, 2);
  assert.match(onMarkdown.stderr, /is markdown/);
  assert.match(onMarkdown.stderr, /--quote/);
  assert.ok(!fs.existsSync(path.join(d, 'poster.html.sidecar.json')));
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('the verbs that rewrite the document refuse an asset outright', () => {
  const d = assetDir();
  for (const [verb, ...rest] of [['suggest', '--quote', 'Get started', '--replacement', 'x'],
                                 ['answer', 'c-nothing', '--replacement', 'x'],
                                 ['reanchor', 'c-nothing', '--quote', 'x']]) {
    const e = cliFails(d, verb, 'poster.html', ...rest);
    assert.equal(e.status, 2, `${verb} should refuse`);
    assert.match(e.stderr, /is an asset/);
    assert.match(e.stderr, /read-only/);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('add takes an element key, and refuses a suggestion anchored to one', () => {
  const d = assetDir();
  cliStdin(d, JSON.stringify([
    { element: 'headline', text: 'too long for one line' },
    { element: '#sub', text: 'is the GPU claim true?', flag: true },
  ]), 'add', 'poster.html');
  const items = scAt(d, 'poster.html').items;
  assert.deepEqual(items.map(i => i.anchor.element.sel), ['[data-sc=headline]', '#sub']);
  assert.equal(items[1].flag, true);
  // An accept splices raw bytes into the document, and an asset is read-only, so the pair cannot exist.
  const e = cliFailsStdin(d, JSON.stringify([{ element: 'headline', replacement: 'shorter' }]), 'add', 'poster.html');
  assert.match(e.stderr, /suggestion cannot anchor to an element/);
  assert.equal(scAt(d, 'poster.html').items.length, 2, 'nothing added');
  // And the cross-kind refusals reach `add` too, by the same one rule.
  assert.match(cliFailsStdin(d, JSON.stringify([{ quote: 'Get started', text: 'x' }]), 'add', 'poster.html').stderr, /is an asset/);
  assert.match(cliFailsStdin(d, JSON.stringify([{ element: 'headline', text: 'x' }]), 'add', 'doc.md').stderr, /is markdown/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- check, show, orphan, digest ----------

test('check --element pre-flights one element, and bare check lints the anchors already stored', () => {
  const d = assetDir();
  const ok = cli(d, 'check', 'poster.html', '--element', 'headline');
  assert.match(ok, /unambiguous, safe to anchor/);
  assert.match(ok, /<h1>\s+Train your own image gen model/);
  const miss = cliFails(d, 'check', 'poster.html', '--element', 'ghost');
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no element \[data-sc=ghost\]/);
  // --quote and --element check different anchor kinds, so each is refused on the other's document.
  assert.match(cliFails(d, 'check', 'poster.html', '--quote', 'Get started').stderr, /is an asset/);
  assert.match(cliFails(d, 'check', 'doc.md', '--element', 'headline').stderr, /is markdown/);

  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'x');
  assert.match(cli(d, 'check', 'poster.html'), /ok {3}c-headline.*\[data-sc=headline\]/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('show prints an element item like any other, and says why one orphaned', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  const before = cli(d, 'show', 'poster.html');
  assert.match(before, /1 item/);
  assert.match(before, /comment {2}OPEN/);
  assert.match(before, /@ "cta · Get started"/);
  assert.match(before, /claude: the link goes nowhere/);

  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace("data-sc='cta'", 'class="btn"'));
  const after = cli(d, 'show', 'poster.html');
  assert.match(after, /ORPHANED/);
  assert.match(after, /\[the element is gone\]/);
  assert.equal(scAt(d, 'poster.html').items[0].orphanReason, 'element-changed');
  fs.rmSync(d, { recursive: true, force: true });
});

test('an element item orphans when its element goes, and revives when it comes back', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'too long');
  const id = scAt(d, 'poster.html').items[0].id;
  const gone = POSTER.replace('<h1 data-sc="headline">Train your own image gen model</h1>', '<h1>Something else</h1>');
  fs.writeFileSync(path.join(d, 'poster.html'), gone);
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'orphaned');
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  cli(d, 'show', 'poster.html');
  const back = scAt(d, 'poster.html').items[0];
  assert.equal(back.id, id);
  assert.equal(back.status, 'open', 'revival works exactly as it does for a text anchor');
  assert.equal(back.orphanReason, undefined);
  assert.equal(back.orphanedAt, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an element item rides the digest and the cursor untouched', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'too long');
  cli(d, 'digest', 'poster.html');
  assert.match(cli(d, 'digest', 'poster.html'), /nothing new/, 'the cursor advanced over an element item');

  // The human answers on the card, exactly as they would on a text anchor.
  const id = scAt(d, 'poster.html').items[0].id;
  const review = scAt(d, 'poster.html');
  review.items[0].thread.push({ by: 'you', at: '2026-08-13T12:00:00Z', text: 'shorten it to four words' });
  fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'), JSON.stringify(review, null, 2));
  const reply = cli(d, 'digest', 'poster.html');
  assert.match(reply, /REPLY @ “headline · Train your own image gen model”: shorten it/);
  assert.match(cli(d, 'reply', 'poster.html', id, 'four words it is'), /updated /);

  // And an orphan reaches the digest with the reason the element rule gives it.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('data-sc="headline"', 'class="big"'));
  assert.match(cli(d, 'digest', 'poster.html'), /ORPHANED @ “headline · .*” \[the element is gone\]/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an asset keeps the same sibling files a markdown document does', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'x');
  cli(d, 'digest', 'poster.html');
  for (const suffix of ['.sidecar.json', '.sidecar.seen.json', '.sidecar.seen.base.claude'])
    assert.ok(fs.existsSync(path.join(d, 'poster.html' + suffix)), `poster.html${suffix} is written`);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   THE ASSET FRAME (1.7.0, phase 3) — an asset renders in a sandboxed iframe
   whose srcdoc the client assembles. Two properties hold the isolation
   guarantee up (docs/adr/0001-asset-frame-isolation.md) and both are pinned
   here: the asset's own scripts never run, and the sandbox is exactly
   `allow-scripts`. Below that, the picker's pure half — candidates, paths,
   signatures, resolution — exercised through require(), the way the shared
   matcher already is.
   ──────────────────────────────────────────────────────────────────────────── */

const AssetFrame = require('./public/assetframe.js');
const Picker = require('./public/picker.js');

// A DOMPurify bound to a jsdom window, which is exactly what the page hands buildFrame (its own
// global). Same library, same version, same profile — so what the suite asserts about the srcdoc is
// what the browser assembles.
function purifier() {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  return require('dompurify')(window);
}

// Everything an asset should NOT be able to smuggle into the frame, in one fixture.
const HOSTILE = `<!doctype html>
<html>
<head><style>@font-face { src: url(./face.woff2) } .b { background: url('shot.png') } .c { background: url(https://cdn.example.com/x.png) }</style></head>
<body onload="boom()">
  <h1 data-sc="hero" style="background:url(bg.jpg)" onclick="steal()">Headline</h1>
  <script>fetch('/api/state?path=doc.md')</script>
  <iframe src="./nested.html"></iframe><object data="./o.pdf"></object><embed src="./e.swf">
  <img src="./pic.png" srcset="small.png 1x, /abs.png 2x">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <a href="./page.html">a link</a><a href="javascript:alert(1)">js</a>
</body>
</html>`;

test('the served page pins the asset frame to sandbox="allow-scripts", and never allow-same-origin', async () => {
  // Read the file AND what the server hands the browser, because the guarantee is about what actually
  // reaches the page. The flag set lives in markup rather than being assembled in code precisely so it
  // can be asserted as one literal string.
  const onDisk = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const served = await fetchRetry(`${BASE}/`).then(r => r.text());
  for (const [what, html] of [['on disk', onDisk], ['as served', served]]) {
    assert.match(html, /<iframe class="asset-frame" sandbox="allow-scripts"/, `the frame is sandboxed ${what}`);
    // The permanent one, from the spec's "not in this release": no flag, no option, no escape hatch.
    // With it the frame would share this origin, which carries the file read/write API.
    assert.doesNotMatch(html, /allow-same-origin/, `allow-same-origin appears nowhere ${what}`);
  }
});

test('the asset profile strips everything that executes and keeps everything that styles', () => {
  const out = AssetFrame.buildFrame({ html: HOSTILE, docRel: 'poster.html', purify: purifier(), picker: 'PICKER_SOURCE' });
  // The asset's own script is gone, and so is every handler and javascript: URL that would run without one.
  assert.doesNotMatch(out, /fetch\('\/api\/state/, 'the asset script is gone');
  assert.doesNotMatch(out, /onload=|onclick=/, 'inline handlers are gone');
  assert.doesNotMatch(out, /javascript:/, 'javascript: URLs are gone');
  // Another browsing context inside the frame is a second thing to reason about, so there is none.
  for (const tag of ['iframe', 'object', 'embed']) assert.ok(!out.includes('<' + tag), `<${tag}> is stripped`);
  // …and the half that differs from the markdown profile: an asset's styling IS the document.
  assert.match(out, /<style>/, '<style> survives');
  assert.match(out, /@font-face/, 'and its contents');
  assert.match(out, /<h1 data-sc="hero" style="background:url/, 'the inline style survives');
  // Exactly one script, and it is ours. This pairs with the sandbox flags above: neither is alone.
  assert.equal((out.match(/<script/g) || []).length, 1, 'one script tag');
  assert.match(out, /<script>PICKER_SOURCE<\/script>/);
  assert.match(out, /^<!doctype html>/, 'and a doctype, or the frame parses in quirks mode');
});

test('relative references are rewritten to /assets; absolute, protocol-relative and data: are not', () => {
  const out = AssetFrame.buildFrame({ html: HOSTILE, docRel: 'brand/poster.html', purify: purifier(), picker: '' });
  const at = (src) => '/assets?doc=' + encodeURIComponent('brand/poster.html') + '&src=' + encodeURIComponent(src);
  assert.ok(out.includes(at('./pic.png').replace(/&/g, '&amp;')), 'an <img src>');
  assert.ok(out.includes(at('small.png').replace(/&/g, '&amp;')), 'the first srcset candidate');
  assert.ok(out.includes('/abs.png 2x'), 'and an absolute one in the same srcset is left alone');
  assert.ok(out.includes(at('./face.woff2')), 'a url() in a <style> block');
  assert.ok(out.includes(at('shot.png')), 'a single-quoted one');
  assert.ok(out.includes('url(https://cdn.example.com/x.png)'), 'an absolute url() is untouched');
  assert.match(out, /src="data:image\/gif/, 'a data: URL is untouched');
  assert.match(out, /<a href="\.\/page\.html"/, 'and an <a href> is a destination, not a subresource — untouched');
});

test('the url() rewriter reaches every spelling of a CSS reference, and only the relative ones', () => {
  const css = AssetFrame.rewriteCss(
    `a{background:url(one.png)} b{background:url("two.png")} c{background:url( 'three.png' )}
     d{background:url(/abs.png)} e{background:url(//cdn/x.png)} f{background:url(data:image/gif;base64,AA)}`, 'p.html');
  for (const n of ['one.png', 'two.png', 'three.png'])
    assert.ok(css.includes('src=' + encodeURIComponent(n)), `${n} is rewritten`);
  assert.ok(css.includes('url(/abs.png)'), 'an absolute path is left alone');
  assert.ok(css.includes('url(//cdn/x.png)'), 'so is a protocol-relative one');
  assert.ok(css.includes('url(data:image/gif;base64,AA)'), 'and so is a data: URL');
});

test('buildFrame refuses a picker source that could close its own script tag', () => {
  // Script content serializes raw, so this sequence would end the tag and spill the rest into the
  // document as markup. It has never appeared in picker.js; the guard is what keeps it that way.
  assert.throws(() => AssetFrame.buildFrame({ html: '<p>x</p>', docRel: 'p.html', purify: purifier(),
    picker: 'var s = "</script><img onerror=alert(1)>"' }), /<\/script/);
});

test('the real picker.js inlines cleanly and boots only inside a frame', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8');
  const out = AssetFrame.buildFrame({ html: '<p>x</p>', docRel: 'p.html', purify: purifier(), picker: src });
  assert.ok(out.includes('sidecar:'), 'the picker source made it into the srcdoc');
  assert.equal((out.match(/<script/g) || []).length, 1);
  // require()d, it must export and NOT touch a DOM — the Node tests below depend on that, and so does
  // a stray <script src="/picker.js"> in the page itself.
  assert.equal(typeof Picker.candidatesFor, 'function');
});

test('/assets serves the font types an asset needs, and still refuses anything unlisted', async () => {
  for (const name of ['face.woff2', 'face.woff', 'face.ttf', 'face.otf'])
    fs.writeFileSync(path.join(dir, name), 'not really a font');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red }');
  const types = { 'face.woff2': 'font/woff2', 'face.woff': 'font/woff', 'face.ttf': 'font/ttf', 'face.otf': 'font/otf' };
  for (const name in types) {
    const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./' + name)}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get('content-type'), types[name]);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', 'the type stays pinned');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    // The frame is an opaque origin and a CSS font fetch is CORS-mode, so without this the poster
    // renders in a fallback face. Images need none of it, and do not get it.
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  const img = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./pic.svg')}`);
  assert.equal(img.headers.get('access-control-allow-origin'), null, 'an image is not opened up');
  for (const bad of ['./style.css', './doc.md', './server.js'])
    assert.equal((await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(bad)}`)).status, 400, bad);
});

// ---------- the picker's pure half ----------

// A DOM to pick out of, built the way the frame's would be.
function pickerDom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('an asset reports the link a click would follow, from the element or from its ancestors', () => {
  // The frame never decides: it says what the href is and public/doclink.js, on the page's side of the
  // postMessage boundary, decides whether it names a document. An asset's <a href> survives the
  // sanitize profile unrewritten (only LINK/IMAGE/USE hrefs become /assets references), so what the
  // page routes is what the author wrote.
  const doc = pickerDom('<main><a href="./market-research.md"><span id="in">the research</span></a>'
    + '<a href="https://example.com"><em id="out">a site</em></a><p id="plain">no link</p></main>');
  assert.equal(Picker.linkHref(doc.querySelector('#in')), './market-research.md',
    'the link is found from the deepest element, which is what the outline lands on');
  assert.equal(Picker.linkHref(doc.querySelector('a')), './market-research.md');
  assert.equal(Picker.linkHref(doc.querySelector('#out')), 'https://example.com',
    'an outbound link is reported too; the page is what refuses it');
  assert.equal(Picker.linkHref(doc.querySelector('#plain')), '');
  assert.equal(Picker.linkHref(null), '');
  // And the two ends meet: what the frame reports of a sibling citation is what the page follows.
  assert.deepEqual(DocLink.route(Picker.linkHref(doc.querySelector('#in')), 'vault/projects/ccdc-portal/poster.html'),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' });
  assert.equal(DocLink.route(Picker.linkHref(doc.querySelector('#out')), 'vault/projects/ccdc-portal/poster.html'), null,
    'and an outbound one stays an ordinary pick');
});

test('a pick offers its candidates best-first: data-sc, then id, then the structural path', () => {
  const doc = pickerDom('<main><h1 data-sc="hero" id="top">Train your own image gen model</h1>'
    + '<p id="sub">Ten minutes.</p><p>bare</p><p>also bare</p></main>');
  const both = Picker.candidatesFor(doc.querySelector('h1'));
  assert.deepEqual(both.map(c => c.sel), ['[data-sc=hero]', '#top', undefined],
    'data-sc outranks id, and the path is always the last resort');
  assert.equal(both[0].label, 'hero');
  assert.ok(both.every(c => c.sig === 'Train your own image gen model'), 'every candidate carries the signature');
  assert.ok(both.every(c => c.path === 'main>h1'), 'and the same path');

  const idOnly = Picker.candidatesFor(doc.querySelector('#sub'));
  assert.deepEqual(idOnly.map(c => c.sel), ['#sub', undefined]);
  // An element carrying neither attribute is still reviewable — most real posters have no data-sc at
  // all, and refusing to anchor one would leave nothing to comment on.
  const bare = Picker.candidatesFor(doc.querySelectorAll('p')[1]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].sel, undefined);
  assert.equal(bare[0].label, 'p');
  assert.equal(bare[0].path, 'main>p:nth-of-type(2)');
});

test('the structural path is a tag chain, indexed only where a tag repeats, and stops at <body>', () => {
  const doc = pickerDom('<main><section><h2>One</h2></section><section><h2>Two</h2><h2>Three</h2></section></main>');
  const secs = doc.querySelectorAll('section');
  assert.equal(Picker.pathOf(secs[0].querySelector('h2')), 'main>section:nth-of-type(1)>h2',
    'the section repeats so it is indexed; its lone h2 is not');
  assert.equal(Picker.pathOf(secs[1].querySelectorAll('h2')[1]), 'main>section:nth-of-type(2)>h2:nth-of-type(2)');
  assert.equal(Picker.pathOf(doc.querySelector('main')), 'main', 'the chain stops before <body>');
  // Every step has to survive the store's own path rule, or the write is refused after the human typed
  // the comment.
  for (const p of ['main>section:nth-of-type(2)>h2:nth-of-type(2)', 'main', 'div>h1'])
    assert.ok(Element.validPath(p), p);
  for (const bad of ['', 'main h1', 'main>[x=1]', 'main>h1:nth-child(2)', 'a'.repeat(400)])
    assert.ok(!Element.validPath(bad), JSON.stringify(bad) + ' is refused');
});

test('the picker and lib/element.js agree on a sel, a snippet and a synthesized quote', () => {
  // selectorFor re-derives what parseRef knows, because the frame gets picker.js and nothing else.
  // These are the three forms an agent can type and the picker can store.
  for (const [ref, css] of [['[data-sc=hero]', '[data-sc="hero"]'], ['hero', '[data-sc="hero"]'], ['#sub', '[id="sub"]']]) {
    assert.equal(Picker.selectorFor(ref), css, ref);
    assert.ok(Element.validSel(ref), ref + ' is a sel the store holds');
  }
  assert.equal(Picker.selectorFor('a b'), null, 'and a value neither would store resolves to nothing');

  // The quote a picker comment writes and the quote `sidecar comment --element` writes have to be the
  // same string, or the same element reads two ways depending on who commented on it. The fixture nests
  // inline tags on purpose: Node reads the file with every tag replaced by a SPACE, so a picker reading
  // textContent would glue "your"+"own" into one word and agree with nothing.
  const html = '<h1 data-sc="headline">Train <b>your</b><i>own</i> image generation model in ten minutes flat, no GPU and no account and no waiting</h1>';
  const el = pickerDom(html).querySelector('h1');
  const fromNode = Element.extract(html)[0];
  assert.equal(Picker.textOf(el), Element.stripTags('Train <b>your</b><i>own</i> image generation model in ten minutes flat, no GPU and no account and no waiting'),
    'the picker reads an element the way the Node rule reads the file');
  assert.equal(Picker.snippet(Picker.textOf(el)), fromNode.text, 'the elided display snippet matches');
  assert.equal(Picker.synthQuote('headline', Picker.snippet(Picker.textOf(el))),
    Element.synthQuote(fromNode.label, fromNode.text), 'and so does the whole quote');
  assert.ok(fromNode.text.endsWith('…'), 'both elide at 80 characters');

  // The SIGNATURE is a different string on purpose: Node checks liveness by matching it against the
  // tag-stripped file, and an ellipsis appears nowhere in the source.
  const sig = Picker.candidatesFor(el)[0].sig;
  assert.ok(!sig.includes('…'), 'no ellipsis in a signature');
  assert.equal(sig.length, 80);
  assert.equal(Element.isLive(html.replace('data-sc="headline"', 'class="big"'), { sel: '[data-sc=headline]', sig }), true,
    'so a signature the picker wrote still resolves by the Node rule after the attribute is renamed');
});

test('the picker resolves sel first, then path checked against sig, then sig alone', () => {
  const doc = pickerDom('<main><h1 data-sc="headline">Train your own image gen model</h1>'
    + '<section><p>Ten minutes, no GPU required.</p></section></main>');
  const sig = 'Train your own image gen model';

  const bySel = Picker.resolve(doc, { sel: '[data-sc=headline]', path: 'nope>nope', sig: 'wrong' });
  assert.equal(bySel.by, 'sel', 'the attribute the agent named wins');
  assert.equal(bySel.el.tagName, 'H1');

  // Attribute gone, path still good: the path is trusted only because the signature agrees.
  const byPath = Picker.resolve(doc, { sel: '[data-sc=gone]', path: 'main>h1', sig });
  assert.equal(byPath.by, 'path');
  assert.equal(byPath.el.tagName, 'H1');
  // A path that now points at the wrong element is refused by the signature and falls through.
  const stale = Picker.resolve(doc, { sel: '[data-sc=gone]', path: 'main>section>p', sig });
  assert.equal(stale.by, 'sig', 'a path whose signature disagrees is not trusted');
  assert.equal(stale.el.tagName, 'H1');
  // Nothing left but the text.
  assert.equal(Picker.resolve(doc, { sig }).by, 'sig');
  assert.equal(Picker.resolve(doc, { sel: '[data-sc=gone]', sig: 'not in this document' }), null);

  // A wrapper holding one child reads the same text as the child, so the deepest match is the one a
  // human pointed at.
  const nested = pickerDom('<main><div><span>Only text</span></div></main>');
  assert.equal(Picker.resolve(nested, { sig: 'Only text' }).el.tagName, 'SPAN');
});

test('an element anchor may be stored by path and signature alone, and a bad path is refused', async () => {
  // The picker's third candidate: an element with neither a data-sc nor an id. `sel` is absent rather
  // than invalid, and the store holds it — CONTEXT.md's element anchor resolves "by structural path
  // checked against a text-content signature" for exactly this case.
  const ok = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-bare', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { path: 'main>footer', sig: '© 2026 spktr' }, quote: 'footer · © 2026 spktr' }, thread: [] }] } });
  assert.equal(ok.status, 200);
  const stored = (await ok.json()).review.items.find(i => i.id === 'c-bare');
  assert.deepEqual(stored.anchor.element, { path: 'main>footer', sig: '© 2026 spktr' });

  // A path is run through querySelector inside the frame, so it gets the same treatment the sel does.
  const bad = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-badpath', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { path: 'main > *:has(script)', sig: 'x' }, quote: 'x' }, thread: [] }] } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid element path/);

  // And an element anchor that names nothing at all is not an anchor.
  const empty = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-empty', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { sig: 'x' }, quote: 'x' }, thread: [] }] } });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /needs a sel or a path/);
});

test('check reports a path anchor as a third state, never as ok, and prints it by its path', () => {
  // Node cannot run a structural path without a DOM, so it abstains, and `check` has to SAY that
  // rather than print `ok`, which would report a check that never happened. Three states, and the
  // path-only anchor still prints by its path (an absent sel used to read as "undefined").
  const d = assetDir();
  const sc = (items) => fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'),
    JSON.stringify({ schema: 1, items }, null, 2));
  const bare = (element) => ({ id: 'c-bare', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element, quote: 'footer · © 2026 spktr' },
    thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'the year is wrong' }] });

  sc([bare({ path: 'main>footer', sig: '© 2026 spktr' })]);
  const out = cli(d, 'check', 'poster.html');
  assert.match(out, /\? {4}c-bare {2}main>footer \(\+sig\)/);
  assert.doesNotMatch(out, /undefined/);
  assert.doesNotMatch(out, /^ok/m, 'an unverified anchor is never reported as ok');
  assert.match(out, /1 anchor pins by a structural path/);
  assert.match(out, /cannot say whether the path still lands on that element/);
  assert.match(out, /resolves each one for real when the document is next opened/);

  // The signature is information, both ways, and a signature that stopped matching is NOT death: the
  // element is the referent and its text is evidence.
  sc([bare({ path: 'main>footer', sig: 'a year that is not in the file' })]);
  assert.match(cli(d, 'check', 'poster.html'), /\? {4}c-bare {2}main>footer \(\+sig\)/);
  sc([bare({ path: 'main>div>img' })]);
  assert.match(cli(d, 'check', 'poster.html'), /\? {4}c-bare {2}main>div>img \(no sig\)/);

  // And the abstention does not swallow the answer Node CAN give. A sel anchor is still checked.
  sc([{ id: 'c-sel', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element: { sel: '[data-sc=ghost]' }, quote: 'ghost' }, thread: [] }]);
  const miss = cliFails(d, 'check', 'poster.html');
  assert.equal(miss.status, 1);
  assert.match(miss.stdout, /MISS c-sel/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a comment on a picture survives: no attribute, no text, and Node abstains instead of orphaning', () => {
  // The case the real fixture forced. A poster is mostly pictures, and a picture carries no data-sc, no
  // id and no text — so the anchor is a path and the signature is empty. The Node rule is textual and
  // has nothing to check, and calling that "the element is gone" would orphan every picture comment the
  // moment it was written.
  const poster = '<main><div class="plate"><img src="./face.jpg"></div><p>caption</p></main>';
  const el = pickerDom(poster).querySelector('img');
  const cand = Picker.candidatesFor(el)[0];
  assert.equal(cand.sel, undefined);
  assert.equal(cand.sig, '');
  assert.equal(cand.path, 'main>div>img');
  const element = { path: cand.path, sig: cand.sig };
  assert.equal(Element.isLive(poster, element), true, 'Node abstains on a path it cannot run');
  assert.equal(Element.liveness(poster, element), 'unverified', 'and says so as its own state');
  // The abstention covers a path anchor that HAS a signature too, and that is the change: a signature
  // that stopped matching is evidence of an edit. Node still judges what it can see, so an anchor with
  // a signature and no path is answered outright.
  assert.equal(Element.liveness('<main><p>caption</p></main>', { path: 'main>h1', sig: 'gone now' }), 'unverified');
  assert.equal(Element.liveness('<main><p>caption</p></main>', { sig: 'gone now' }), 'missing');
  assert.equal(Element.liveness('<main><p>caption</p></main>', { sig: 'caption' }), 'live');

  // And the store takes it, so the comment can actually be written.
  const { annotateOrphans } = require('./lib/review.js');
  const review = { items: [{ id: 'c-pic', kind: 'comment', status: 'open',
    anchor: { element, quote: 'img' }, thread: [] }] };
  annotateOrphans(poster, review);
  assert.equal(review.items[0].status, 'open');
});

test('the picker, booted inside the real srcdoc, speaks the whole protocol', () => {
  // The DOM half, exercised the only way it can be without a browser: build the srcdoc the page would
  // build, run it under jsdom with scripts ON, and drive it. jsdom does no layout, so the rects are all
  // zero — geometry VALUES are for the browser pass; that they are reported, keyed by item, is here.
  const srcdoc = AssetFrame.buildFrame({ html: POSTER, docRel: 'poster.html', purify: purifier(),
    picker: fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8') });
  const dom = new JSDOM(srcdoc, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window, doc = win.document;
  const sent = [];
  // At the jsdom top level window.parent IS the window, which is also why the picker did not boot
  // itself — it only does that inside a frame. So this captures its outbound channel.
  win.postMessage = (msg) => sent.push(msg);
  assert.equal(typeof win.SidecarPicker, 'object', 'the inlined picker ran');
  win.SidecarPicker.boot(win);
  const ready = sent.find(m => m.type === 'sidecar:ready');
  assert.ok(ready, 'it reports the canvas on boot');
  assert.equal(typeof ready.width, 'number');

  const say = (data) => { sent.length = 0; win.dispatchEvent(new win.MessageEvent('message', { data })); };

  // init with what a TERMINAL-written item knows: a sel and nothing else.
  say({ type: 'sidecar:init', items: [{ id: 'c1', element: { sel: '[data-sc=headline]' } }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { c1: 'resolved' });
  assert.deepEqual(Object.keys(sent.find(m => m.type === 'sidecar:geometry').rects), ['c1']);
  assert.equal(doc.querySelectorAll('.sc-anchored').length, 1, 'the element carries its cue');
  // …and the picker hands back what only a DOM could know, for the store to keep.
  const bf = sent.find(m => m.type === 'sidecar:backfill');
  assert.equal(bf.id, 'c1');
  assert.equal(bf.element.path, 'main>h1');
  assert.equal(bf.element.sig, 'Train your own image gen model');
  // Written back, that anchor still resolves by the NODE rule after its attribute is renamed — which is
  // the whole point of the backfill.
  assert.equal(Element.isLive(POSTER.replace('data-sc="headline"', 'class="big"'), bf.element), true);

  // A click on a bare element is a pick; a click on one that already carries an item opens that card.
  const footer = doc.querySelector('footer');
  sent.length = 0;
  footer.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(sent.find(m => m.type === 'sidecar:hover').label, 'footer');
  assert.equal(doc.querySelectorAll('.sc-hover').length, 1);
  sent.length = 0;
  footer.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.label, 'footer');
  assert.equal(pick.text, '© 2026 spktr');
  assert.equal(pick.candidates[0].path, 'main>footer');
  sent.length = 0;
  doc.querySelector('h1').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(sent.filter(m => m.type === 'sidecar:open').map(m => m.id), ['c1']);
  assert.equal(sent.some(m => m.type === 'sidecar:pick'), false, 'and it does not also start a second thread');

  // A link inside the frame must never navigate: the sandbox lets a frame navigate ITSELF, which would
  // replace the asset with whatever the URL resolves to.
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  doc.querySelector('a').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);

  // The two inbound cues from the rail.
  say({ type: 'sidecar:highlight', id: 'c1' });
  assert.equal(doc.querySelectorAll('.sc-lit').length, 1);
  say({ type: 'sidecar:highlight', id: null });
  assert.equal(doc.querySelectorAll('.sc-lit').length, 0);
  say({ type: 'sidecar:pulse', id: 'c1' });
  assert.equal(doc.querySelectorAll('.sc-flash').length, 1);

  // An anchor whose element is gone reports missing, which is what the card's orphan badge reads.
  say({ type: 'sidecar:init', items: [{ id: 'c9', element: { sel: '[data-sc=ghost]', sig: 'nothing here' } }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { c9: 'missing' });
  dom.window.close();
});

/* ────────────────────────────────────────────────────────────────────────────
   Drift: the element is the referent, its text is only evidence

   The incident, from live testing: a card said "change this to Alex Smith", the change was made, and
   the card orphaned, so acting on a comment destroyed the comment. Any text edit to an unlabelled
   element did it, because the stored signature was the text as it read when the card was written.
   ──────────────────────────────────────────────────────────────────────────── */

// A frame around one asset, driven the way the boot test drives it: the real srcdoc, jsdom with
// scripts on, the outbound channel captured.
function bootFrame(html) {
  const srcdoc = AssetFrame.buildFrame({ html, docRel: 'poster.html', purify: purifier(),
    picker: fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8') });
  const dom = new JSDOM(srcdoc, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window, sent = [];
  win.postMessage = (msg) => sent.push(msg);
  win.SidecarPicker.boot(win);
  return { dom, win, doc: win.document, sent,
    say: (data) => { sent.length = 0; win.dispatchEvent(new win.MessageEvent('message', { data })); } };
}

test('a text edit at a stable path keeps the card and backfills the new signature', () => {
  // THE INCIDENT. The card asks for the footer to read "Alex Smith"; the edit is made; the element is
  // the same element at the same path with different words in it. It stays live, and the picker hands
  // back the new signature so the next resolution starts from what the file says now.
  const edited = POSTER.replace('© 2026 spktr', '© 2026 Alex Smith');
  const { doc, sent, say, dom } = bootFrame(edited);
  const stored = { path: 'main>footer', sig: '© 2026 spktr' };

  say({ type: 'sidecar:init', items: [{ id: 'c-bare', element: stored }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { 'c-bare': 'resolved' });
  const bf = sent.find(m => m.type === 'sidecar:backfill');
  assert.deepEqual(bf.element, { path: 'main>footer', sig: '© 2026 Alex Smith' });
  assert.equal(doc.querySelector('footer').classList.contains('sc-anchored'), true);
  assert.equal(Picker.resolve(doc, stored).by, 'path-edited', 'the same element, its text edited');

  // The guard that makes case 3 safe. The old signature turning up somewhere ELSE means the element
  // moved, so the search wins and the element that now sits at the stale path does not impersonate it.
  const moved = POSTER.replace('© 2026 spktr', 'Ten minutes, no GPU required.');
  const two = bootFrame(moved);
  const hit = Picker.resolve(two.doc, { path: 'main>footer', sig: 'Ten minutes, no GPU required.' });
  assert.equal(hit.by, 'path', 'the path itself still agrees here');
  two.say({ type: 'sidecar:init', items: [{ id: 'c-moved',
    element: { path: 'main>h1', sig: 'Ten minutes, no GPU required.' } }] });
  const found = Picker.resolve(two.doc, { path: 'main>h1', sig: 'Ten minutes, no GPU required.' });
  assert.equal(found.by, 'sig', 'the stale path resolves to the h1, whose text disagrees, so the search runs');
  assert.equal(found.el.tagName, 'P', 'and it lands on the element the text moved to');
  const bf2 = two.sent.find(m => m.type === 'sidecar:backfill');
  assert.equal(bf2.element.path, 'main>p', 'the new path is backfilled, not the old one kept');
  dom.window.close(); two.dom.window.close();
});

test('resolution order: sel, path+sig, sig anywhere, then the same path with edited text', () => {
  // The full ladder in one place, because the last two rungs are the ones that trade off against each
  // other. Two paragraphs share a path shape; the second holds the text the first used to hold.
  const doc = pickerDom('<main><p>Old words</p><p>New words</p></main>');
  // Nothing else in the document reads "Only here", so the path is trusted despite the mismatch.
  const solo = pickerDom('<main><p>Different words now</p></main>');
  assert.equal(Picker.resolve(solo, { path: 'main>p', sig: 'Only here' }).by, 'path-edited');
  assert.equal(Picker.resolve(solo, { path: 'main>p', sig: 'Only here' }).el.tagName, 'P');
  // The same mismatch, except the stored text is alive elsewhere: that is a move, and it wins.
  const moved = Picker.resolve(doc, { path: 'main>p:nth-of-type(2)', sig: 'Old words' });
  assert.equal(moved.by, 'sig');
  assert.equal(Picker.textOf(moved.el), 'Old words');
  // A path that resolves to nothing and a signature that is nowhere is still death.
  assert.equal(Picker.resolve(solo, { path: 'main>h1', sig: 'Only here' }), null);
});

test('Node never orphans a path anchor, and still orphans one whose sel is deleted', () => {
  const d = assetDir();
  // An item with no attribute at all: what the picker writes when the human clicks a bare element.
  // Its signature is deliberately stale, which used to read as "the element is gone".
  fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-bare', kind: 'comment', by: 'claude', status: 'open',
      anchor: { element: { path: 'main>footer', sig: '© 2026 spktr' }, quote: 'footer · © 2026 spktr' },
      thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'change this to Alex Smith' }] }] }, null, 2));
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('© 2026 spktr', '© 2026 Alex Smith'));
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'open', 'the card survives the edit it asked for');
  // Even the element being cut leaves it open here: a path is the frame's to judge, and the frame
  // reports missing on the next open. Node reporting it dead would be a guess dressed as a fact.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace(/<footer>[^<]*<\/footer>/, ''));
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'open', 'Node defers rather than guessing');

  // A sel anchor is a different matter: Node can read the attribute out of the file, so it answers.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  cli(d, 'comment', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  const id = scAt(d, 'poster.html').items.find(i => i.id !== 'c-bare').id;
  const at = (name) => scAt(d, 'poster.html').items.find(i => i.id === id).status;
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('>Get started<', '>Start now<'));
  cli(d, 'show', 'poster.html');
  assert.equal(at(), 'open', 'rewriting the text does not orphan a sel anchor either');
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace("data-sc='cta'", 'class="btn"'));
  cli(d, 'show', 'poster.html');
  assert.equal(at(), 'orphaned', 'deleting the attribute does');
  assert.equal(scAt(d, 'poster.html').items.find(i => i.id === id).orphanReason, 'element-changed');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   Layer stepping: reaching what the paint stack buries

   The incident: a poster's background image could not be commented on anywhere except one gap,
   because scrims covered the rest of it and hover only ever finds the top of the stack.
   ──────────────────────────────────────────────────────────────────────────── */

const LAYERED = `<!doctype html>
<html><body>
  <main>
    <img data-sc="art" src="./art.jpg">
    <div data-sc="scrim"></div>
  </main>
</body></html>
`;

test('the layer stack is the pickable elements under a point, top first and deduped', () => {
  const doc = pickerDom('<main><img data-sc="art" src="./art.jpg"><div data-sc="scrim"></div></main>');
  const scrim = doc.querySelector('[data-sc=scrim]'), art = doc.querySelector('img');
  const main = doc.querySelector('main');
  // jsdom does no layout, so the browser's hit test is stubbed. What is under test is the filtering
  // and the ordering, which is all the picker contributes.
  doc.elementsFromPoint = () => [scrim, art, art, main, doc.body, doc.documentElement];
  assert.deepEqual(Picker.stackAt(doc, 5, 5, null), [scrim, art, main],
    'body, html and the repeat are dropped; paint order is kept');
  // No hit test at all (jsdom without the stub, an older engine): the event target carries it.
  const bare = pickerDom('<main><p>x</p></main>');
  assert.deepEqual(Picker.stackAt(bare, 0, 0, bare.querySelector('p')), [bare.querySelector('p')]);
  assert.deepEqual(Picker.stackAt(bare, 0, 0, bare.body), [], 'and body is never a pick');

  // The step wraps, and a step left over from a deeper stack reads as the top rather than as nothing.
  const stack = [scrim, art, main];
  assert.equal(Picker.stepped(stack, 0), scrim);
  assert.equal(Picker.stepped(stack, 2), main);
  assert.equal(Picker.stepped(stack, 3), scrim, 'it wraps at the bottom');
  assert.equal(Picker.stepped([], 1), null);
  assert.equal(Picker.sameStack(stack, [scrim, art, main]), true);
  assert.equal(Picker.sameStack(stack, [scrim, art]), false);
  assert.equal(Picker.sameStack(stack, [art, scrim, main]), false, 'order is part of the identity');
});

test('Alt steps the outline a layer deeper, and the click takes what is outlined', () => {
  const { win, doc, sent, say, dom } = bootFrame(LAYERED);
  const scrim = doc.querySelector('[data-sc=scrim]'), art = doc.querySelector('img');
  const main = doc.querySelector('main');
  doc.elementsFromPoint = () => [scrim, art, main, doc.body];
  const move = () => { sent.length = 0;
    doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 })); };
  const hover = () => sent.find(m => m.type === 'sidecar:hover');

  move();
  assert.deepEqual({ ...hover(), type: undefined },
    { type: undefined, label: 'scrim', depth: 1, count: 3, href: '', link: false },
    'the top of the stack by default, with the depth the page shows, no link under it, no link mode');
  assert.equal(scrim.classList.contains('sc-hover'), true);

  // The page forwards the key, because a keydown reaches the frame only once the frame has focus.
  say({ type: 'sidecar:step' });
  assert.equal(hover().label, 'art');
  assert.equal(hover().depth, 2);
  assert.equal(art.classList.contains('sc-hover'), true);
  assert.equal(scrim.classList.contains('sc-hover'), false, 'one outline at a time');
  // The frame's own key does the same thing, so the two routes cannot drift.
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
  assert.equal(hover().label, 'main');
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
  assert.equal(hover().label, 'scrim', 'and it wraps');
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true, repeat: true }));
  assert.equal(hover(), undefined, 'a held key does not spin through the stack');

  // A click takes the OUTLINED element. Step to the buried image and pick it, which is the whole
  // point: the scrim covers every pixel of it, so it is unreachable by hover.
  say({ type: 'sidecar:step' });
  sent.length = 0;
  scrim.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.label, 'art');
  assert.equal(pick.candidates[0].sel, '[data-sc=art]', 'the anchor is the image, not the thing clicked');

  // Moving to a point whose layers differ starts again at the top.
  doc.elementsFromPoint = () => [main, doc.body];
  move();
  assert.equal(hover().label, 'main');
  assert.equal(hover().count, 1);
  doc.elementsFromPoint = () => [scrim, art, main, doc.body];
  move();
  assert.equal(hover().label, 'scrim', 'and back over the stack, the step is reset');
  dom.window.close();
});

test('a citation inside an asset reaches the page as a pick carrying its href', () => {
  // An asset cites its siblings the way a document does, and following one is the same navigation. The
  // frame reports the href and nothing else: the rule lives in public/doclink.js on the page's side,
  // because the frame is given the picker and no way to fetch a second script.
  const cited = POSTER.replace('<footer>© 2026 spktr</footer>',
    '<footer><a href="./market-research.md"><span data-sc="cite">the research</span></a></footer>');
  const { win, doc, sent, dom } = bootFrame(cited);
  const span = doc.querySelector('[data-sc=cite]'), cta = doc.querySelector('[data-sc=cta]');
  const from = 'vault/projects/ccdc-portal/poster.html';

  doc.elementsFromPoint = () => [span, doc.querySelector('footer'), doc.body];
  sent.length = 0;
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
  const hover = sent.find(m => m.type === 'sidecar:hover');
  assert.equal(hover.label, 'cite');
  assert.equal(hover.href, './market-research.md', 'the affordance knows before the click');

  sent.length = 0;
  span.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.href, './market-research.md', 'found from the deepest element, through its ancestors');
  assert.equal(pick.follow, false, 'a plain click is the comment, whatever the href turns out to be');
  assert.deepEqual(DocLink.route(pick.href, from),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' }, 'and the page could open that document');

  // Shift is what asks for the link. The page reads `follow` and routes the href; the frame's part is
  // reporting both, and preventing the default, since Chrome's own shift+click would want a second window.
  sent.length = 0;
  const shifted = new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: true });
  span.dispatchEvent(shifted);
  const follow = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(follow.follow, true, 'shift+click asks the page to follow the link');
  assert.equal(follow.href, './market-research.md');
  assert.equal(shifted.defaultPrevented, true, 'and never navigates the frame or opens a window itself');

  // The poster's own call to action is an absolute path, which is a URL on this origin rather than a
  // path in the served root — so it stays an ordinary pick and the composer opens on it.
  doc.elementsFromPoint = () => [cta, doc.querySelector('main'), doc.body];
  sent.length = 0;
  cta.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const second = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(second.href, '/start');
  assert.equal(DocLink.route(second.href, from), null);
  dom.window.close();
});

test('shift puts the asset in link mode, and it comes back out of it', () => {
  // The other half of the complaint: a click that navigates and a click that comments looked identical.
  // While shift is down the frame carries a class the picker's own stylesheet paints links with, the
  // hover report says link mode is on so the page's status slot can name the destination, and a click
  // follows the link even where the element already carries a thread.
  const linked = POSTER.replace('<footer>© 2026 spktr</footer>',
    '<footer><a href="my-zone.html" id="nav">my zone</a></footer>');
  const { win, doc, sent, say, dom } = bootFrame(linked);
  const nav = doc.querySelector('#nav');
  const html = doc.documentElement;
  const hover = () => sent.find(m => m.type === 'sidecar:hover');
  doc.elementsFromPoint = () => [nav, doc.querySelector('footer'), doc.body];

  // The page forwards the first press, because the frame has no focus until it is clicked.
  say({ type: 'sidecar:linkmode', on: true });
  assert.equal(html.classList.contains('sc-linkmode'), true);
  assert.equal(hover().link, true, 'and the status slot is told without the cursor having to move');
  say({ type: 'sidecar:linkmode', on: false });
  assert.equal(html.classList.contains('sc-linkmode'), false);

  // The frame's own keys do the same, so the two routes cannot drift.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  assert.equal(html.classList.contains('sc-linkmode'), true);
  doc.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  assert.equal(html.classList.contains('sc-linkmode'), false);

  // A keyup lost to a window switch would leave every link in the asset looking live. Blur clears it,
  // and so does the true modifier state on the next movement over the frame.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  win.dispatchEvent(new win.Event('blur'));
  assert.equal(html.classList.contains('sc-linkmode'), false, 'blur drops it');
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5, shiftKey: true }));
  assert.equal(html.classList.contains('sc-linkmode'), true, 'a move with shift down puts it back');
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 6, clientY: 6 }));
  assert.equal(html.classList.contains('sc-linkmode'), false, 'and a move without it clears a stuck one');

  // An element that already carries an item: a plain click reopens its thread, shift follows the link.
  // A commented nav bar is exactly what a human then wants to click through.
  say({ type: 'sidecar:init', items: [{ id: 'c1', element: { sel: '#nav' } }] });
  sent.length = 0;
  nav.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  assert.equal(sent.find(m => m.type === 'sidecar:open').id, 'c1');
  sent.length = 0;
  nav.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: true }));
  assert.equal(sent.some(m => m.type === 'sidecar:open'), false, 'shift does not reopen the card');
  assert.equal(sent.find(m => m.type === 'sidecar:pick').follow, true);
  dom.window.close();
});

test('a fragment link reports where it points, for the page to scroll to', () => {
  // '#flags' scrolls the asset it is already in. The frame is laid out at its full natural height and has
  // no scrollport of its own, so the scroll belongs to the page and all the frame owes it is a rect.
  const fragged = POSTER.replace('<footer>© 2026 spktr</footer>', '<footer id="flags">flags</footer>');
  const { sent, say, dom } = bootFrame(fragged);

  say({ type: 'sidecar:reveal', frag: 'flags' });
  const at = sent.find(m => m.type === 'sidecar:revealed');
  assert.ok(at && at.rect && typeof at.rect.top === 'number', "the target, in the frame's own coordinates");

  say({ type: 'sidecar:reveal', frag: 'nothing-here' });
  assert.equal(sent.some(m => m.type === 'sidecar:revealed'), false,
    'an id in no element says nothing: that is a broken link in the asset, not a scroll to recover');
  dom.window.close();
});

// ---------- the folder layer: `wait --dir` / `digest --dir` (lib/dir.js) ----------
// Reviewing a product means reviewing a folder, so one watcher and one digest cover it. The cursors
// underneath stay per document — these assert the aggregation over them, the doc set it aggregates,
// and the lock that keeps two folder watchers off the same cursors.
const Dir = require('./lib/dir.js');
const { computeDigest: cd, renderDigest: rd, digestBody: db } = require('./lib/digest.js');

// A delta shaped like computeDigest's, without the disk round-trip.
const delta = (over = {}) => ({ decided: [], orphaned: [], news: [], replies: [], removed: [],
  docChanged: false, docPatch: null, done: false, empty: true, noMarker: false, at: null,
  snapshot: { docHash: 'h', items: {}, at: 'now' }, ...over });
const oneNew = (q, text) => delta({ empty: false, news: [{ id: 'c1', kind: 'comment', q, text }] });

test('the folder doc set is the panel\'s: this directory only, documents only, sorted', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirset-'));
  for (const n of ['zeta.md', 'brief.md', 'poster.html', 'notes.txt', 'data.json', '.hidden.md'])
    fs.writeFileSync(path.join(d, n), 'x');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'deep.md'), 'x');       // no recursion: the panel shows one folder
  fs.writeFileSync(path.join(d, 'brief.md.sidecar.json'), '{}');   // a sidecar is not a document
  fs.writeFileSync(path.join(d, 'brief.md.sidecar.seen.json'), '{}');
  assert.deepEqual(Dir.docsIn(d).map(p => path.basename(p)), ['brief.md', 'poster.html', 'zeta.md']);
  assert.deepEqual(Dir.docsIn(path.join(d, 'nope')), [], 'a folder that is not there is empty, never a throw');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the folder digest labels every event with its document, and counts live against total', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'brief.md', d: oneNew('the bet', 'say who it is for') },
    { rel: 'business-case.md', d: delta() },
    { rel: 'market-research.md', d: delta({ empty: false, replies: [{ id: 'c2', q: 'counties', text: 'which ones' }] }) },
  ]);
  assert.match(out, /## sidecar — your turn in \/p\/ccdc \(2 of 3 documents\)/);
  assert.match(out, /### brief\.md\n- NEW comment @ “the bet”: say who it is for/);
  assert.match(out, /### market-research\.md\n- REPLY @ “counties”: which ones/);
  assert.ok(!out.includes('business-case.md'), 'a document with nothing unseen is counted, not printed');
  assert.match(out, /\nDONE: false$/);
});

test('a folder digest with nothing unseen says so once, not once per document', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [{ rel: 'a.md', d: delta() }, { rel: 'b.md', d: delta() }]);
  assert.equal(out, 'nothing new across 2 documents in /p/ccdc\n\nDONE: false');
  assert.match(Dir.renderDirDigest('/p/empty', []), /^nothing new across 0 documents/);
});

test('folder DONE is true only when every document is done; a partial says which', () => {
  const half = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'a.md', d: delta({ done: true }) }, { rel: 'b.md', d: delta() }]);
  assert.match(half, /DONE: false {2}\(1 of 2 marked done: a\.md\)/, 'one finished document does not end the review');
  const all = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'a.md', d: delta({ done: true }) }, { rel: 'b.md', d: delta({ done: true }) }]);
  assert.match(all, /\nDONE: true$/);
  assert.ok(!/marked done:/.test(all), 'and it does not then list them all back');
});

test('a document with no cursor is labelled per document, since the others still have theirs', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'fresh.md', d: { ...oneNew('q', 't'), noMarker: true } },
    { rel: 'seen.md', d: oneNew('q2', 't2') },
  ]);
  assert.match(out, /### fresh\.md {2}\(no last-seen marker\)/);
  assert.match(out, /### seen\.md\n/, 'the document with a cursor carries no such note');
});

test('the doc-changes section nests under the document name in a folder digest', () => {
  const withDiff = delta({ empty: false, docChanged: true, docPatch: '@@ -1 +1 @@\n-a\n+b' });
  assert.match(Dir.renderDirDigest('/p', [{ rel: 'a.md', d: withDiff }]), /#### doc changes \(since your last look\)/);
  // and the single-document digest still says ### — its heading is the top level there.
  assert.match(rd(withDiff), /\n### doc changes \(since your last look\)/);
});

test('digestBody is the single-document renderer minus its frame (the split kept renderDigest honest)', () => {
  const d = oneNew('the bet', 'say who');
  assert.equal(rd(d), '## sidecar — your turn\n' + db(d) + '\n\nDONE: false');
  const both = delta({ empty: false, news: d.news, docChanged: true, docPatch: '@@ -1 +1 @@\n-a\n+b' });
  assert.equal(rd(both), '## sidecar — your turn\n' + db(both) + '\n\nDONE: false');
});

test('the folder lock: one watcher per (folder, agent), and a different agent gets its own', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirlock-'));
  const p = Dir.lockPath(d, 'claude');
  assert.notEqual(p, Dir.lockPath(d, 'gemini'), 'the agent is part of the key');
  assert.notEqual(p, Dir.lockPath(d + '2', 'claude'), 'and so is the folder');
  assert.equal(Dir.heldBy(p), null, 'nothing held to begin with');
  assert.ok(Dir.acquireLock(d, 'claude').path, 'the first watcher takes it');
  assert.equal(Dir.heldBy(p).pid, process.pid);
  // Another agent on the same folder is a separate loop with its own cursors — it is not refused.
  assert.ok(Dir.acquireLock(d, 'gemini').path);
  assert.equal(Dir.heldBy(Dir.lockPath(d, 'gemini')).agent, 'gemini');
  assert.ok(Dir.acquireLock(d, 'claude').path, 'and a process is never a rival to itself');
  Dir.releaseLock(p); Dir.releaseLock(Dir.lockPath(d, 'gemini'));
  assert.equal(Dir.heldBy(p), null, 'and it is free again on the way out');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a lock whose holder is dead, or whose heartbeat stopped, is not held', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirlock2-'));
  const p = Dir.lockPath(d, 'claude');
  const live = { pid: process.pid, dir: d, agent: 'claude', at: 'now' };

  fs.writeFileSync(p, JSON.stringify(live));
  assert.ok(Dir.heldBy(p), 'a running holder with a fresh heartbeat holds it');

  // Stopped heartbeat: the file is old, whoever wrote it is not beating any more.
  const old = new Date(Date.now() - Dir.LOCK_TTL - 5000);
  fs.utimesSync(p, old, old);
  assert.equal(Dir.heldBy(p), null, 'three missed beats and the lock is free');
  Dir.touchLock(p);
  assert.ok(Dir.heldBy(p), 'a beat revives it');

  // Dead holder: a pid nothing is running. 0x7FFFFFF is beyond any live pid on macOS/Linux.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 0x7FFFFFF }));
  assert.equal(Dir.heldBy(p), null, 'a fresh file from a dead process is not a claim');

  // A rival that is BOTH alive and beating is refused, and --force takes it.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 1 }));   // pid 1 is always alive (EPERM reads as alive)
  assert.equal(Dir.acquireLock(d, 'claude').error.pid, 1, 'refused, and it names the holder');
  assert.ok(Dir.acquireLock(d, 'claude', { force: true }).path, '--force takes over');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);

  // Release only ever removes OUR lock — a process that was forced out must not delete the new claim.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 1 }));
  Dir.releaseLock(p);
  assert.ok(fs.existsSync(p), 'someone else\'s lock survives our release');
  fs.writeFileSync(p, JSON.stringify(live));
  Dir.releaseLock(p);
  assert.ok(!fs.existsSync(p), 'and our own is cleaned up');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- the folder verbs, as real processes (no server: the filesystem is the sync layer) ----

const dirFixture = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirwait-'));
  fs.writeFileSync(path.join(d, 'brief.md'), '# Brief\n\nThe first claim lives here.\n');
  fs.writeFileSync(path.join(d, 'research.md'), '# Research\n\nThe second claim lives here.\n');
  fs.writeFileSync(path.join(d, 'ignored.json'), '{}');
  return d;
};
// Alex's side of the loop: the human writing a comment, run as a different agent name.
const asAlex = (args, cwd) => spawnSync('node', [path.join(__dirname, 'server.js'), ...args],
  { cwd, env: { ...process.env, SIDECAR_AGENT: 'alex', SIDECAR_PORT: '4990' }, encoding: 'utf8' });
const dirCli = (args, cwd) => spawnSync('node', [path.join(__dirname, 'server.js'), ...args],
  { cwd, env: { ...process.env, SIDECAR_PORT: '4990' }, encoding: 'utf8' });

test('sidecar wait --dir wakes on a change to ANY document and names which one', async () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);   // seed both cursors, so the wait starts from a clean folder
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (x) => out += x.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  asAlex(['comment', 'research.md', '--quote', 'The second claim lives here.', '--text', 'WAKE-ON-ANY-DOC'], d);
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'the folder wait exits 0 once they act on any document in it');
  assert.match(out, /### research\.md/, 'the digest labels the event with its document');
  assert.match(out, /WAKE-ON-ANY-DOC/);
  assert.ok(!out.includes('### brief.md'), 'and says nothing about the document that did not change');
  // The cursor that advanced is research.md's own — the folder holds none of its own.
  assert.ok(fs.existsSync(path.join(d, 'research.md.sidecar.seen.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('a second wait --dir by the same agent refuses (exit 2) rather than racing the first', async () => {
  const d = dirFixture();
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '8'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));
  const second = dirCli(['wait', '--dir', d, '--timeout', '2'], d);
  assert.equal(second.status, 2, 'refused, the same exit code a bad path gets');
  assert.match(second.stderr, /already watching/);
  assert.match(second.stderr, /--force/, 'and it says how to take over');
  w.kill();
  await new Promise((res) => w.on('exit', res));
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait --dir on something that is not a folder exits 2, and --timeout exits 1', async () => {
  const d = dirFixture();
  const bad = dirCli(['wait', '--dir', path.join(d, 'brief.md')], d);
  assert.equal(bad.status, 2, 'a file is not a folder');
  assert.match(bad.stderr, /no folder at/);
  const asFile = dirCli(['wait', d, '--timeout', '2'], d);
  assert.equal(asFile.status, 2, 'and a folder passed as the file argument says which flag it wanted');
  assert.match(asFile.stderr, /--dir/);
  dirCli(['digest', '--dir', d], d);
  const quiet = dirCli(['wait', '--dir', d, '--timeout', '1'], d);
  assert.equal(quiet.status, 1, 'a quiet folder times out at 1, exactly as one quiet document does');
  assert.match(quiet.stdout, /still watching/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --dir reports every document, then advances each cursor (and --peek advances none)', () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);
  asAlex(['comment', 'brief.md', '--quote', 'The first claim lives here.', '--text', 'ONE'], d);
  asAlex(['comment', 'research.md', '--quote', 'The second claim lives here.', '--text', 'TWO'], d);

  const peek = dirCli(['digest', '--dir', d, '--peek'], d);
  assert.match(peek.stdout, /\(2 of 2 documents\)/);
  assert.match(peek.stdout, /### brief\.md\n- NEW comment @ “The first claim lives here\.”: ONE/);
  assert.match(peek.stdout, /### research\.md\n- NEW comment @ “The second claim lives here\.”: TWO/);

  const again = dirCli(['digest', '--dir', d, '--peek'], d);
  assert.equal(again.stdout, peek.stdout, '--peek advanced nothing, so it reads the same twice');

  const real = dirCli(['digest', '--dir', d], d);
  assert.equal(real.stdout, peek.stdout);
  assert.match(dirCli(['digest', '--dir', d], d).stdout, /^nothing new across 2 documents/,
    'and once looked at, both cursors have moved');

  // The cursors are the ordinary per-document ones: a single-document digest agrees with the folder.
  assert.match(dirCli(['digest', path.join(d, 'brief.md')], d).stdout, /^nothing new since/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a document created while wait --dir is armed joins the folder it is watching', async () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (x) => out += x.toString());
  await new Promise((res) => setTimeout(res, 900));
  // Creating it must NOT wake the watcher: a new file is baselined where it stands, exactly as a
  // document with no cursor is at launch. The first real change to it is the news.
  fs.writeFileSync(path.join(d, 'business-case.md'), '# Case\n\nThe payback is eighteen months.\n');
  await new Promise((res) => setTimeout(res, 900));
  assert.equal(out, '', 'the file appearing is not itself an event');
  asAlex(['comment', 'business-case.md', '--quote', 'The payback is eighteen months.', '--text', 'LATE-DOC'], d);
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /### business-case\.md/, 'a document that did not exist at launch is watched anyway');
  assert.match(out, /LATE-DOC/);
  assert.match(out, /\(1 of 3 documents\)/, 'and the folder is now three');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- the watcher registry: `sidecar watchers` (lib/watchers.js) ----------
// A `wait` is a long-lived process holding the turn, and half of them used to leave no trace at all.
// These cover the three things the verb promises: it says what is armed, it can tell a running
// watcher from a record that outlived its process, and --clean touches only the second kind.

const Watchers = require('./lib/watchers.js');

// A record for a pid nothing is running. 0x7FFFFFF is beyond any live pid on macOS/Linux, the same
// number the folder-lock tests use for a dead holder.
const DEAD_PID = 0x7FFFFFF;
const plantDead = (target, agent = 'ghost') => {
  const p = Watchers.recordPath('doc', target, agent);
  fs.writeFileSync(p, JSON.stringify({ pid: DEAD_PID, kind: 'doc', file: target, agent, at: new Date().toISOString() }));
  return p;
};

test('the registry reads a live record and a dead one apart, and clean removes only the dead', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-'));
  const liveDoc = path.join(d, 'live.md'), deadDoc = path.join(d, 'dead.md');

  const mine = Watchers.arm(liveDoc, 'claude');       // this process is genuinely alive
  const theirs = plantDead(deadDoc);
  const find = (t) => Watchers.list().find(r => r.target === t);

  assert.equal(find(liveDoc).state, 'live', 'a running holder with a fresh beat is live');
  assert.equal(find(liveDoc).pid, process.pid);
  assert.equal(find(liveDoc).kind, 'doc');
  assert.equal(find(deadDoc).state, 'stale', 'a fresh record from a dead process is stale');

  // A running holder that has missed three beats is QUIET, not stale: it may be suspended, and
  // reaping its record would hide a watcher that is genuinely armed.
  const old = new Date(Date.now() - Watchers.TTL - 5000);
  fs.utimesSync(mine, old, old);
  assert.equal(find(liveDoc).state, 'quiet');
  Watchers.touch(mine);
  assert.equal(find(liveDoc).state, 'live', 'a beat revives it');

  const reaped = Watchers.clean();
  assert.ok(reaped.some(r => r.target === deadDoc), 'the dead record is reaped');
  assert.ok(!reaped.some(r => r.target === liveDoc), 'and the live one is never touched');
  assert.ok(!fs.existsSync(theirs));
  assert.ok(fs.existsSync(mine));

  Watchers.release(mine);
  assert.ok(!fs.existsSync(mine), 'and our own goes on the way out');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the folder lock is one of the records the registry lists', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-dir-'));
  const lock = Dir.acquireLock(d, 'claude');
  const rec = Watchers.list().find(r => r.target === d);
  assert.equal(rec.kind, 'dir', 'a dir lock reads as a dir watcher');
  assert.equal(rec.agent, 'claude');
  assert.equal(rec.state, 'live');
  Dir.releaseLock(lock.path);
  assert.equal(Watchers.list().find(r => r.target === d), undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sidecar watchers lists a real armed wait as LIVE beside a dead record marked STALE', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-cli-'));
  const doc = path.join(d, 'armed.md');
  fs.writeFileSync(doc, '# Armed\n\nThe claim lives here.\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const ghostDoc = path.join(d, 'ghost.md');
  const ghost = plantDead(ghostDoc);

  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', doc, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  try {
    await new Promise((res) => setTimeout(res, 900));   // let it get past the startup emit and arm
    const armed = fs.realpathSync(doc);

    const listed = dirCli(['watchers'], d);
    assert.equal(listed.status, 0, 'listing is never an error, whatever it finds');
    const live = listed.stdout.split('\n').find(l => l.includes(armed));
    assert.match(live, /LIVE\s+doc\s+claude\s+pid \d+/, 'the armed wait is live, with its pid');
    assert.match(listed.stdout, new RegExp(`STALE\\s+doc\\s+ghost.*${ghostDoc.replace(/[.]/g, '\\.')}`),
      'and the record whose process is gone is marked STALE');
    assert.match(listed.stdout, /sidecar watchers --clean/, 'which says how to clear it');

    const cleaned = dirCli(['watchers', '--clean'], d);
    assert.equal(cleaned.status, 0);
    assert.match(cleaned.stdout, /reaped \d+ stale watcher/);
    assert.ok(cleaned.stdout.includes(ghostDoc), 'it reports what it reaped by name');
    assert.ok(!fs.existsSync(ghost), 'the stale record is gone');

    const after = dirCli(['watchers'], d);
    assert.ok(after.stdout.includes(armed), 'the live watcher survived the clean');
    assert.ok(!after.stdout.includes(ghostDoc));

    // --kill refuses a pid it holds no record for, rather than signalling on a number alone.
    const stray = dirCli(['watchers', '--kill', String(DEAD_PID)], d);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /no watcher record for pid/);
  } finally {
    w.kill();
    await new Promise((res) => w.on('exit', res));
  }
  // The wait cleans its own record up on the way out (SIGTERM now runs its exit path).
  assert.equal(Watchers.list().find(r => r.target === fs.realpathSync(doc)), undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait --timeout 0 has no backstop: it blocks past the default and still wakes on a comment', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-notimeout-'));
  const doc = path.join(d, 'patient.md');
  fs.writeFileSync(doc, '# Patient\n\nThe claim lives here.\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));

  // `Number(argv[++i]) || 900` read 0 as absent and armed the 15-minute backstop anyway. Nothing this
  // test can wait out proves "never", so it proves the flag is taken at all: a 1s wait on the same
  // document exits 1, and this one is still blocking well after that.
  const quick = dirCli(['wait', doc, '--timeout', '1'], d);
  assert.equal(quick.status, 1, 'a 1s timeout expires');

  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', doc, '--timeout', '0'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = '';
  w.stdout.on('data', (x) => out += x.toString());
  // Never let this hang the suite: whatever happens, the child dies at 15s.
  const guard = setTimeout(() => w.kill('SIGKILL'), 15000);
  try {
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(w.exitCode, null, 'still blocking with no timeout to expire');
    assert.equal(out, '', 'and it has said nothing');

    asAlex(['comment', 'patient.md', '--quote', 'The claim lives here.', '--text', 'NO-BACKSTOP'], d);
    const code = await new Promise((res) => w.on('exit', res));
    assert.equal(code, 0, 'it still wakes on a real event and exits 0');
    assert.match(out, /NO-BACKSTOP/);
  } finally { clearTimeout(guard); w.kill(); }
  fs.rmSync(d, { recursive: true, force: true });
});

test('the timeout exit says it is a timeout rather than a failure', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-timeoutmsg-'));
  const doc = path.join(d, 'quiet.md');
  fs.writeFileSync(doc, '# Quiet\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const r = dirCli(['wait', doc, '--timeout', '1'], d);
  assert.equal(r.status, 1, 'exit 1 is the contract and does not move');
  assert.match(r.stdout, /still watching/, 'the phrase agents match on stays');
  assert.match(r.stdout, /The timeout expired, nothing was missed and nothing advanced/);
  assert.match(r.stdout, /DONE: false/);
  fs.rmSync(d, { recursive: true, force: true });
});
