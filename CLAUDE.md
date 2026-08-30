# CLAUDE.md — working on sidecar's own code

For *driving* sidecar as an agent (reviewing a document with a human), see
[skills/sidecar/SKILL.md](skills/sidecar/SKILL.md). This file is about changing sidecar itself.

## Shape

No build step. Twenty files carry the whole tool:

| File | What it is |
|---|---|
| `server.js` | HTTP server + fs-watch → SSE. Boots express; dispatches `sidecar <verb>` to the CLI first. |
| `lib/cli.js` | The agent's entire command surface. Every write verb funnels into one `applyItems()`. Holds the two extension allowlists, `MARKDOWN` and `ASSETS`, and `docKind()` over them. |
| `lib/review.js` | Load/save/merge the `.sidecar.json`, and the one place the pre-1.7 `.review.*` names still exist. Shared by the server and the CLI so both merge identically. |
| `lib/element.js` | The element anchor: reference normalization, sel validation, and the Node-side liveness rule. |
| `lib/assets.js` | Where an attached image lands and what counts as one. Shared by the upload route and `--image`. |
| `lib/wait.js` | `sidecar wait` — the fs-watching reactive-loop primitive. Server-independent by design. |
| `lib/digest.js` | The persistent per-agent cursor, the doc baseline beside it, and the one digest renderer both `wait` and `digest` print. |
| `lib/dir.js` | The folder under `--dir`: which documents it holds, several digests read as one, the one-watcher lock. |
| `lib/watchers.js` | The watcher registry in tmp: who is armed on what, whether the pid is still running, and what `watchers --clean` may reap. |
| `lib/presence.js` | The presence ping. Decorative and server-optional: a failed POST never affects the command that made it. |
| `public/index.html` | The entire frontend: rendering, contenteditable editor, directory panel, review rail. |
| `public/navsort.js` | The directory panel's ordering. Pure list in/out; no DOM, no dependency. |
| `public/doclink.js` | Does a link in a document open IN sidecar, and which document. Pure string in/out. |
| `public/turn.js` | Whose turn is it: the panel's badges and the inbox. Pure review in, counts + items out; `server.js` requires it too. |
| `public/anchor.js` | The ONE content-anchor matcher, loaded by both the browser and Node. |
| `public/stability.js` | What the rail shows while the document is rewritten under it: freeze, last known position, orphan grace. Pure; the clock is passed in. |
| `public/serialize.js` | The tight-diff serialize/reindex round-trip, shared with the Node tests. |
| `public/flow.js` | ```flow fences → SVG. Pure string in/out; no DOM, no dependency. |
| `public/assetframe.js` | An asset's HTML → the sandboxed frame's srcdoc: the sanitize profile, the `/assets` rewriting, the picker inlining. |
| `public/picker.js` | The ONE script that runs inside an asset frame. Picks, cues, geometry, and the postMessage protocol. |

## Two document kinds, two anchor kinds

A document is markdown or an **asset** (an `.html` file reviewed as a rendered visual). The two
allowlists in `lib/cli.js` are the single source for that, and `docKind()` over them gates the three
places a kind is decided: the file-picker walk, the fs watcher, and every CLI verb. `/api/state`
returns the kind and refuses anything in neither list, which is what stopped `?f=page.html` loading
through the markdown path.

An asset is read-only in the viewer. `/api/save` and `/api/format` refuse one, `suggest`, `answer`
and `reanchor` refuse one from the CLI, and an accept would splice raw bytes into HTML, so a
suggestion can never carry an element anchor. The agent edits the file itself and the watcher
reloads the frame.

Items on an asset anchor to an **element** rather than to a quote: `anchor.element = { sel, path,
sig }`, plus a synthesized `anchor.quote` (the label and a text snippet) so cards, the digest and
`show` keep reading one field. `sel` is what an agent knows from a terminal; `path` and `sig` are
backfilled by the browser picker, which is why `mergeItem` merges an element anchor field by field
instead of replacing it. A dead one orphans with `orphanReason: 'element-changed'` and revives the
same way a text anchor does.

**The element is the referent and its text is only evidence.** A card orphans when its element is
gone, and never because the element's content changed. The signature identifies the element; it is
not a claim about what the element must keep saying. Live testing settled this: a card reading
"change this to Alex Smith" orphaned itself the moment the name was changed, so acting on a comment
destroyed the comment.

**`sel` is optional and `path` is not a lesser anchor.** Most real posters carry no `data-sc` and no
`id` on anything, so an element picked in the browser often has only a structural path and a
signature — refusing those would leave nothing in the file commentable. Both halves are validated
where present (`validSel`, `validPath`), for the same reason an item id is: each is echoed back into a
selector. An anchor naming neither is refused.

Two authorities decide whether an element anchor is live, and they see different things. The picker
has a DOM and runs `sel`, then `path` verified against `sig`, then a document-wide search for `sig`
alone, and then the case that rule used to miss: a `path` that still resolves whose signature
disagrees **and whose stored signature is found nowhere else** is the same element with edited text,
so it stays live and the new signature is backfilled. The document-wide miss is the guard: a
signature that turns up somewhere else means the element moved, and case 4 takes it there rather than
letting whatever now sits at the old path impersonate it. The picker reports the answer out as
`anchors {id: resolved|missing}`, which is what the card's orphan badge reads on an asset.

Node is textual and **abstains on every path-carrying anchor**: it reports live and says so plainly in
`check`'s third state. It cannot run a structural path without a DOM, and a signature mismatch no
longer implies death, so there is nothing left for it to judge. The abstention started narrower (a
path-only anchor with no signature, because a picture has no text) for the same reason it is now
wide: deferring to the side that can actually see costs one reload, and a false orphan costs the
human a rescue. The frame's re-resolution writes through `/api/review`, so `annotateOrphans` sees the
truth on the next load. The signature is taken the way Node reads the file, tags becoming spaces, so
`<span>a</span><span>b</span>` signs as `a b` on both sides.

The picker reads the whole **layer stack** under the cursor (`elementsFromPoint`), not just the top of
it, and a tap of Alt steps one layer deeper and wraps. A poster's top layer is usually a full-bleed
scrim or dot screen that owns every point it covers, and without stepping the artwork beneath it is
unreachable. A click acts on whatever is outlined, so the pick and the promise are the same element.

The frame is assembled in the CLIENT (`public/assetframe.js`), which is what keeps this
dependency-free: the page already has DOMPurify. `/api/state` returns the asset's raw HTML in the
`markdown` field, the asset profile keeps `<style>` and inline styles while stripping everything that
executes, relative `src`/`href`/`url()` references are rewritten to `/assets`, and the picker is
inlined as the srcdoc's only script. Everything the page needs back out of the frame — the canvas
size to scale by, per-item rects to dock cards by, picks — crosses a postMessage boundary, because the
sandbox withholds this page's origin. `docs/adr/0001-asset-frame-isolation.md` has the why.

**An asset does not keep the prose measure, and it has a zoom.** `#doc`'s 908px cap is what prose asked
for, and a 1600px artboard read inside it is read at half size, so `renderDoc` puts an `asset` class on
`#doc` and the cap comes off the element that carries it. Nothing breaks out of anything: a breakout
wrapper would have to reconstruct the column width it was escaping, against a track two draggable
panels move, and `#doc` already is that column. The header's control then chooses between `fit` (scale
the canvas into the column, the default, remembered as `sc:assetZoom`) and `100%` (natural size, the
wrapper scrolling sideways so the page never does). Three things `sizeFrame` keeps true across both:
the wrapper carries the SCALED height, because a transform does not change layout size; the scroller
class is toggled before the column is measured, or a fit computed against a width a leftover scrollbar
narrowed comes out short and stays short; and where the platform draws classic scrollbars the
horizontal bar sits inside that height, so what it took is measured and given back rather than
reserved as a guess on every platform.

Both zooms leave anchoring alone, which is what doing this with a transform buys. A click is hit-tested
by the browser inside the frame and the picker reads `clientX`/`clientY` in the frame's own
untransformed space, so no sidecar code turns a page coordinate into a frame one. The other direction is
`framePageRect` and `onFramePick`'s `selRect`, and both multiply by the same `frameScale`; the wrapper's
horizontal scroll rides along for free, since the iframe's bounding rect already carries it.

## What sidecar actually promises

**100% local. You own it.** That's the whole pitch — nothing leaves the machine, no account, no
upload, and the document and its review are files on your disk that you can read, diff, and delete
without sidecar's help.

It is *not* a rule about transport. Earlier drafts of this file said "the agent works through the
filesystem, never the HTTP API," which described an implementation detail and then got treated as a
principle — it made a local CLI talking to a local server over loopback look like a violation of
something, when it violates nothing. If a change keeps everything on the machine and in the user's own
files, it is faithful to the design. Don't defend the transport.

## Two writers, one lock

The document has two writers and only one of them checks. The browser saves with a `baseHash`
optimistic lock and handles both conflict directions (external change while dirty → banner; stale
save → 409 → banner), so **the human never silently loses work**. The agent edits the document with
ordinary file writes and no check at all, so an agent write CAN silently overwrite something the human
just saved.

What actually prevents that is **turn-taking**: the `sidecar wait` → respond → re-arm loop keeps the
two writers temporally separated, and the agent should only touch the document while it holds the
turn. That is the real concurrency model and it is a convention, not an enforced property — worth
knowing before you assume the locking is symmetric. The expensive fix, if this ever actually bites, is
routing document edits through sidecar so they take the same lock; it has not bitten yet.

`public/anchor.js` and `lib/review.js` are shared on purpose. A second implementation of matching or
merging is a second set of bugs, and the two sides must agree byte-for-byte — a matcher that
normalised differently on each side once made the highlight point at one duplicate while accept
spliced another.

## The rail holds still while the agent writes

The docked rail places every card at its anchor, which means an agent rewriting a sentence moves the
card that is about it. Three things then happen inside a few seconds: the anchor stops matching, the
item is stamped `orphaned` and takes the -1 rank that floats it to the top of the rail, and
`reanchor` lands and it drops back down. Rendered as they arrive, the middle state is a card
teleporting out from under a human who was typing into it.

`public/stability.js` is the answer and it changes nothing about the store: the file still says
`orphaned` the moment it is true, `hq`-side readers and the digest see exactly what they always saw,
and this is only what the CARD does about it. Three rules, all client-side, all per document.

- **Freeze.** A card whose reply box has the caret or holds unsent text is pinned to where it sat when
  that started, and moves for nothing until the box is blurred and empty.
- **Last known position.** A card that docks against a real mark records the rank and the pixel. When
  its anchor stops matching it holds them, greyed, instead of taking the -1.
- **Grace.** It does not visibly go orphaned until the anchor has failed for seven seconds, which an
  edit and its reanchor normally round-trip inside. Same reasoning `lib/element.js` already applies to
  an element anchor: a false orphan costs the human a rescue, a late one costs nothing.

Two reasons opt out of both, for opposite reasons: `never-matched` was broken from birth and the -1
exists to make it visible, and `element-changed` is the browser picker's verdict, which has a DOM and
has already deferred. A cold load has nothing remembered and behaves exactly as it always did.

Auto-migrating an anchor across a diff was considered and refused; `annotateOrphans` documents why
silent re-anchoring picks the wrong target. Nothing here re-anchors anything. It buys the honest
answer a few seconds so it can be delivered in place instead of somewhere else.

## The folder says what is still waiting on you

A badge on a panel row counts the items on that document whose next move is the HUMAN's: a live comment
whose latest message is the agent's, and a pending suggestion, which only the human can decide. A
document with open items that are the AGENT's move gets a neutral dot instead, and a document with
nothing open gets nothing. Three states rather than one count, because a folder where every row wears a
number stops meaning anything.

`public/turn.js` is that rule and it is required by both sides, which is the point. The server is the
only side that can see a document nobody has open, so `/api/dir` counts every document in the folder
and sends the live items along for the Inbox; the page is the only side that knows about a resolve half
a second before the file watcher does, so `navSelfUpdate` re-runs the same function over the open
document's review after every render. Two answers to one question agree by being one function.

The counting reads STORED status and nothing else. `public/stability.js`'s grace window is the client's,
the server has no such state, and an item inside its window is being shown as open anyway, so
`orphaned` counts as live on both sides and the badge and the rail can never disagree. An orphaned
SUGGESTION is the one asymmetry: it is open but it is not your turn, because repairing an anchor is
`sidecar reanchor` and the human cannot run it.

The panel reads the sidecar RAW rather than through `loadReview`, which also migrates the pre-1.7
`.review.*` names. Migrating a whole folder as a side effect of listing it is a rename nobody asked
for, so a legacy-named or unparseable sidecar counts zero and its row still draws.

## One watcher for the whole folder

`sidecar wait --dir <folder>` and `sidecar digest --dir <folder>` take a folder where the single-document
verbs take a file: the same doc set the panel lists (`lib/dir.js` `docsIn`, no recursion, the `docKind`
allowlist), one digest with a `###` heading per document, one `DONE` for the folder that is true only when
every document is done.

**It is an aggregation layer and holds no state of its own.** The cursor is still one
`<doc>.sidecar.seen.json` per document, keyed by agent, and a folder digest advances each one exactly as
running `sidecar digest` on each would. So a folder wait and a per-document wait can be swapped for each
other mid-review, and neither replays a turn nor skips one. A directory-level cursor was the obvious
alternative and it is a second store to keep honest; the first time the two disagreed, the agent would
have answered twice or not at all.

The watcher watches the FOLDER rather than the list of documents it held at launch, which is what lets a
document created mid-review join without the agent re-arming. A document first seen mid-wait is baselined
where it stands, exactly as a document with no cursor is at launch, so creating a file is not itself an
event and the first real change to it is.

**One folder watcher per agent**, enforced by a lock in tmp keyed by (realpath, agent): two of them share
every cursor in the folder, so whichever advances one first decides what the other believes it has already
seen. A held lock is a live pid AND a heartbeat inside 60s, since a pid can be recycled and an mtime alone
cannot tell a killed watcher from a busy one. `--force` takes over. A per-document `wait` inside the folder
coexists with a folder wait rather than being refused: it takes no lock and has to keep behaving exactly
as it does, and the cost of the overlap is one doubled digest on one document, which self-heals because
both processes read and advance the same cursor file.

## What is armed, and is it still running

`sidecar watchers` lists every `wait` on the machine: which document or folder, which agent, the pid, how
long it has been blocking, and whether that pid is alive. `--clean` reaps the records whose process is
gone, `--kill <pid>` stops a live one, and both take no document, because the question is about the
machine rather than about one review.

**Both kinds of wait leave a record in tmp now** (`lib/watchers.js`), and only one of them is a lock. The
folder lock refuses a rival, for the reason above. The per-document record refuses nothing at all: two
per-document waits on one file have always been allowed, and making one refuse would change behaviour
reviews already depend on. It exists so the verb can answer the question, and for nothing else. Before it,
a backgrounded `wait` whose harness died was invisible: the browser stopped reading *claude is here* and
there was no way to ask what was still armed.

Three states, because only one of them is safe to reap. **live** is running and beating. **quiet** is
running and has missed three beats, which is a suspended or wedged process that will carry on, so `--clean`
leaves it alone. **stale** is a record that outlived its process, and that is all `--clean` removes.

`--kill` needs two things to agree before it signals: a record naming the pid, and `ps` showing a command
line that is still a sidecar wait. A pid is recycled the moment it is freed, so the record on its own says
nothing about what is wearing that number now. When `ps` cannot answer, it refuses and points at `--clean`
plus the lock's own 60-second TTL.

Presence covers every document in the folder while a folder wait is armed, by pinging each one (the server
keys presence per document and needs no change for this). The woken document's ping carries the thread ids,
so its cards read "claude is replying" while the rest of the folder reads "claude is working".

## Testing

```bash
npm test      # end-to-end against a real server + temp fixture repo, plus CLI and unit coverage
```

The CLI tests run the real binary with **no server running**, which is the point: the filesystem is
the sync layer, and the agent's interface has to work without one.

## The trap: a running server holds stale code

Editing `server.js`, `lib/`, or `public/` does not affect a server that is already running. You will
be testing against code loaded hours ago — this exact trap produced a whole "false orphan" debugging
session once. `sidecar doctor` compares the running server's code stamp against the code on disk and
prints **STALE** when they differ. Restart before testing.

The stamp (`<git-sha> · <mtime>`) is logged at boot, shown in `/api/state`, and on the wordmark's
hover title in the UI.

## Conventions

- Comments explain *why*, especially where the code looks odd — most of them record a real incident.
  Keep that when you change the surrounding code; delete them when the reason stops being true.
- Layout preferences (each panel's width, whether it is collapsed, whether the review rail's width was
  set by hand rather than filled, an asset's zoom, and the directory panel's sort, one key per folder)
  persist in `localStorage` under an `sc:` prefix, through the wrapped `uiStore`. Safari in private mode throws
  on `setItem`, and nothing about a preference is worth an exception on the path that renders the
  review. Document and review state never go there; those are files.
- The shell is the panel fixed to the window, the document inset past it, and the review rail taking
  whatever width is left over, up to 520px. The measure the old 1280px cap was protecting belongs to
  the document, so the document carries it (908px) and the rail fills the rest. `sc:railPinned` is
  what separates a width the human dragged from one the fill computed: every session predating the
  fill already has an `sc:railWidth` on file, and reading that as a preference would mean nobody who
  had used sidecar before ever saw the new layout.
- A history entry carries `{ f, y }`: which document, and where the reader left it. The browser's own
  `scrollRestoration` is off, since switching documents never navigates and its restore would fire
  against the outgoing document's height. Anything else belonging to one document is cleared in
  `resetDocState`, which runs on every swap.
- Whether a link opens IN sidecar is `public/doclink.js` and nothing else. Three callers ask it (the
  document's click handlers, the render that marks a link, and the asset frame's `pick`), so a rule
  added there is a rule all three follow. The frame reports the href out and the page decides, because
  the frame is given the picker and no way to fetch a second script.
- Inside an asset, following a link takes **Shift**, and a plain click there is always the comment. The
  frame is one picking surface, so a nav bar is as often a thing to comment on as a thing to click
  through, and the two clicks looked identical while one of them silently navigated. `frameLink()` turns
  one href into both the label the header shows and the action the click runs (a document in the root, an
  outbound tab, a fragment scroll, or nothing sidecar follows, which stays an ordinary pick), so the
  affordance and the click cannot disagree. While Shift is held the picker paints its own document
  through an `sc-linkmode` class. It arrives three ways (the page forwards the key, the frame sees its own
  once it has focus, and every mouse event carries the true state) and it clears on a keyup, on a blur,
  and on the next movement over the frame, because a modifier whose keyup goes missing to a window switch
  leaves every link in the asset looking live.
- Safety properties that tests cover and should stay covered: atomic sidecar writes, merge-by-id never
  dropping the other side's work, decided statuses never regressing, path confinement to the served
  root, Host-header allowlisting, DOMPurify on rendered markdown, `git diff` run without a shell
  (the two surviving call sites: the server's /api/state and `show`'s --stat; the digest diffs
  in-process against its own baseline), atomic blocks emitting their source bytes rather than
  going through turndown, the legacy rename moving the full sibling set while never merging two
  reviews when both names are present, `/api/state` refusing a file in neither allowlist, save and
  format refusing an asset, an element `sel` and `path` being validated wherever an item id is, the
  asset frame's sandbox flag set being exactly `allow-scripts` (asserted against the whole served
  page, which is why no comment in `public/index.html` spells the same-origin flag), and the
  assembled srcdoc carrying no script but the picker.

## Attached images

An attachment is not a schema field. A pasted screenshot becomes a file in `<doc>.sidecar.assets/` and a
plain markdown link in the comment body, which the existing `/assets` route already resolves because it
is the same doc-relative form a document's own images use. That is why the feature added an upload
endpoint and no rendering, no storage format, and no new item kind.

Bytes stay out of the `.sidecar.json` deliberately. It is rewritten and merged on every reply and pushed
to the browser over SSE, so a base64 screenshot in there would tax every unrelated write; `sidecar show`
would print a wall of it at the agent; and "your files on your disk" stops being literally true the
moment a picture only exists inside a JSON string.

Names are content hashes, so the same image pasted three times is one file and a re-run of the same
agent command is idempotent. The upload sniffs magic bytes rather than trusting the filename or the
browser's `Content-Type` — not a security control (the serving route pins the type by extension and
sends `nosniff`), but the difference between a refusal with a reason and a silently broken `<img>`.

## Atomic blocks

A ```flow fence and a raw-HTML block render as **islands**: `contenteditable="false"`, and `toMd()`
returns the element's `__md` (its original markdown) instead of running turndown. Both halves are
load-bearing. Turndown cannot round-trip what these render to — an `<svg>` comes back as its bare label
text — so the block has to be unreachable from the edit path, not merely unlikely to be edited. The
`toMd` branch **throws** when `__md` is missing rather than falling back to turndown, because a silent
fallback there is precisely the data-loss bug it exists to prevent.

Two things that look like they should work and don't. `contenteditable` is not in DOMPurify's allowed
attribute set, so it must be set from code after sanitizing. And DOMPurify's `SAFE_FOR_XML` strips any
attribute whose value contains `-->` — which is the flow arrow — so a node's identity travels as an
index in `data-node`, never as its source. Both cost an afternoon to find; neither fails loudly.

Diagrams are also excluded from `docText()`, so anchor highlighting never injects an HTML `<mark>` into
the SVG namespace (where it silently does not render) and never mixes the fence's per-edge label
mentions into the same offset space as the rendered one-per-node text. Anchored nodes get their cue
from `markNodes()` instead.
