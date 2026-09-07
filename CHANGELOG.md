# Changelog

All notable changes to sidecar. Versions follow [semver](https://semver.org); dates are the day the
version was tagged.

## 1.9.0 (2026-09-07)

**`sidecar watchers` says what is armed and whether it is still running.** A `wait` is a long-lived
process holding the turn, and until now half of them left no trace: a folder wait wrote a lock, and a
per-document one wrote nothing at all, so a backgrounded watcher that died with its harness was
invisible. The verb lists every wait on the machine with its document or folder, its agent, its pid,
and how long it has been blocking. Three states, because only one of them is safe to clear: **live**
is beating, **quiet** is running and has missed three heartbeats (suspended or wedged, and left
alone), and **stale** is a record that outlived its process. `--clean` reaps the stale ones and
reports each by name; it never touches a live watcher. `--kill <pid>` stops one that is running and
clears its record, checking the pid against `ps` first and refusing anything that does not read as a
sidecar wait, since a pid is recycled the moment it is freed. Both records live in tmp, so nothing new
appears beside the documents, and the per-document one is a record rather than a lock: two
per-document waits on one file are still allowed, exactly as they always were.

**`--timeout 0` means no timeout.** It read as the 15-minute default and armed the backstop anyway,
which is the opposite of what it says. Zero now blocks until something happens; the default with no
flag is still 900, and an unparseable value still falls back rather than silently becoming forever.

**The timeout exit says in words that the timeout expired.** The line still opens with `still
watching` and the exit code is still 1, and it now adds that nothing was missed and nothing advanced,
so an agent reading exit 1 knows it means "run it again".

**A wide design gets the whole column, and a zoom.** A 1600px artboard reviewed inside the 908px
prose measure rendered at half size, which is a different design: the type was unreadable and the
spacing a guess. An `.html` asset now fills the column the two panels leave, with the gutter narrowed
to 24px because the frame draws its own edge, while prose keeps its 908px measure untouched. The
header carries the asset's zoom, remembered per browser: **fit** scales the canvas into the column and
stays the default, **100%** renders it at natural size with the frame's own wrapper scrolling sideways
so the page never does. Anchoring is the same at both zooms, since a click is hit-tested inside the
frame in its own untransformed space and only the outline drawn over it is scaled.

**Inside an asset, Shift follows a link.** A plain click in a poster or wireframe stays a comment,
because a nav bar is as often a thing to comment on as a thing to click through, and the two clicks
looked identical while one of them silently navigated. Shift is now the click that follows, and it
says so the whole time it is held: the pointer returns on links, the underline is forced over a
wireframe's own `text-decoration: none`, and the pick outline drops. The header names the destination
before you click, so the affordance and the action cannot disagree. A fragment link scrolls the page
to where the frame says its target sits.

**The window is one frame, and the header owns only the document.** The review rail runs the full
height of the window as the frame's right column, its tabs sitting in the same 52px brand row the
folder panel uses, and the header spans only the band between the two panels. What the header used
to carry has moved to where it belongs: *saved* goes silent at the steady state (editing, saving,
conflict, and save failed still speak), *all clear* and the open count are gone because the rail's
active tab already wears the number, the docs link sits at the foot of the folder panel with the rest
of the application chrome, and presence sits in the centre of the document column where it reads
ambiently.

**Also:**

- A responsive `.html` asset was measured at the iframe's default 300px viewport before its first
  layout, so it rendered permanently narrow. It is laid out at column width before the first measure.
- Below 780px the asset's kind tag drops its *read-only* qualifier so the zoom control and the
  filename fit on one line.
- The agent skill spells the panel's tabs the way the panel does (*inbox*, *files*).

**Upgrading:** re-arm any `sidecar wait` armed before the upgrade, same as every release. Nothing on
disk changes format; the new watcher records live in tmp.

## 1.8.0 (2026-08-15)

**A review is a folder now, not a file.** Reviewing a product means reading a brief, a research
report, and a business case, and each of those used to be an island. A panel down the left lists
every document in the folder you have open, and clicking one loads it in place: same view, same live
event stream, the URL still naming the document. It sorts three ways and remembers which per folder:
spine (`summary.md` first, `brief.md` second, the rest alphabetical), last updated, and waiting on
you. A breadcrumb steps up a level, the panel collapses to an icon strip with its width persisted,
and below 780px it becomes a drawer. Existing single-document deep links (`?f=…`) behave exactly as
they did.

**Follow a citation without leaving the document.** A relative link naming another document in the
served root opens in sidecar on a plain click, with the panel following along and browser back
returning to the paragraph you were on. Everything else a link can be keeps the behaviour it had: an
outbound URL, a `mailto:`, an anchor within the document, a path that climbs out of the served root,
a file sidecar does not review. Cmd-click still opens a second tab, and an `.html` asset participates
through the same rule its element picker already used.

**The folder says what is still waiting on you.** Each row badges the items on that document whose
next move is YOURS: a live comment whose latest message is the agent's, and a pending suggestion,
which only you can decide. A document whose open items are the agent's move shows a neutral dot, and
one with nothing open shows nothing, because a folder where every row wears a number stops meaning
anything. The panel's second tab is an inbox: every open item across the folder, grouped by document,
waiting on you first, and clicking one opens that document at the anchored span. The rule is one
function the server runs over the folder and the page runs over the open document, so the badge and
the rail can never report two different numbers.

**One watcher for the whole folder.** `sidecar wait --dir <folder>` and `sidecar digest --dir
<folder>` take a folder where the single-document verbs take a file: one process over every document
in it, one digest with a heading per document, and one `DONE` that is true only when every document
is done. It aggregates and stores nothing of its own. The cursor is still one
`<doc>.sidecar.seen.json` per document, so a folder wait and a per-document wait can be swapped for
each other mid-review and neither replays a turn nor skips one. Exit codes match the single-document
contract (0 acted, 1 timeout, 2 a bad path or a watcher already holding the folder), `--force` takes
over a wedged one, and the lock lives in tmp so nothing new appears beside the documents. A document
created mid-wait joins on its own, baselined where it stands. Presence covers every document in the
folder while a folder wait is armed.

**The rail holds still while the agent rewrites the document.** Commenting on a sentence and then
having the agent rewrite it used to move the card out from under your cursor: the anchor stopped
matching, the item floated to the top of the rail as orphaned, and `reanchor` dropped it back down a
few seconds later. A card whose reply box has the caret or holds unsent text is now pinned where it
is and moves for nothing; a card whose anchor stops matching holds its last known position, greyed,
instead of floating; and nothing shows as orphaned until the anchor has failed for seven seconds,
which an edit and its reanchor normally round-trip inside. The stored review is unchanged: this is
only what the card does about it.

**Also:**

- The window is one application shell: the panel is the frame, the wordmark and the document's own
  header sit on one unbroken rule, and the review rail fills the width the document does not want, up
  to 520px, instead of leaving a dead band on a wide screen. A rail width you dragged still wins at
  every size.
- A ` ```flow ` diagram no longer shrinks to fit its column at any cost. It renders at a size its
  labels can be read at and scrolls sideways inside its own box when that is wider than the column,
  which took the CCDC brief's diagrams from 24% scale to 85% at phone width.
- A legacy-named or unreadable sidecar counts zero in the panel rather than being migrated as a side
  effect of listing the folder. Its row still draws.

**Upgrading:** re-arm any `sidecar wait` armed before the upgrade, same as every release. Nothing on
disk changes format.

## 1.7.0 (2026-08-14)

**Sidecar reviews posters now.** Open an `.html` file and it renders as it was designed, at scale,
inside a sandboxed frame: styles intact, references resolved, and none of the asset's own scripts
ever running. Hover outlines the element under the cursor, a click opens the composer pinned to
that element, and the comment anchors to the element itself: a `data-sc` attribute or `id` when the
element has one, a structural path with a text signature when it does not. The same anchor works
from the terminal (`comment --element`, a new `elements` listing, `check --element`), so a
picker-made card and a CLI-made card on the same element read identically. Markdown documents are
untouched; the two kinds share the sidebar, the digest, and the sibling file.

**The element is the referent, its text is just evidence.** The first live review session found the
rule this feature needed: asking for "change this to Alex Smith" and getting it must never orphan
the card that asked. An edit that leaves the element in place keeps the card live and quietly
refreshes the stored signature. Orphaning now means the element is gone. Where the server cannot
verify a structural path without a DOM it abstains and says so (`check` grew a third answer), and
the frame settles the truth on its next open.

**Option steps the layer stack.** A poster is layers, and hover only ever reached the top one, so
an image under a scrim was uncommentable except through gaps. Tapping Option while hovering steps
the target one layer deeper (the label shows the depth), and a click takes whatever is outlined.

**The sibling files are named after the tool.** `<doc>.review.json` and its seen, baseline, and
assets siblings are now `<doc>.sidecar.*`. The whole set renames itself the first time a document
is loaded, one line on stderr says so, and a directory holding both names is warned about loudly
and never merged. `doctor` reports leftover `.review.*` files and stale `*.review.seen*` gitignore
patterns.

**Also:**

- The `/assets` route serves font files (`woff2`, `woff`, `ttf`, `otf`) so posters keep their
  typefaces inside the frame.
- Suggestions are refused on assets, by every verb that could create one: accepting a text splice
  into markup would corrupt the file, so the refusal is the feature.
- A frame sized while its page had no layout (a hidden pane, a background tab) used to freeze at
  scale zero until a window resize; sizing now waits for a real measurement.

**Upgrading:** re-arm any `sidecar wait` armed before the upgrade, same as every release. The
rename touches the working tree of any repo that tracks a `.review.json`: the first load renames it
on disk, and that rename wants a commit.

## 1.6.0 (2026-08-13)

**A reply to a fresh card no longer vanishes.** Replying to a card the agent created after its last
look hit a gap in the digest: the card sat outside the agent's cursor, the news check skipped it as
"my own card", and the skip took your reply down with it. `wait` slept through to its timeout and
the agent went quiet on a direct question. Suggest-then-wait is the normal order, so the window was
open at exactly the moment a first reply arrives. Messages from anyone else on the agent's own new
cards now surface as replies, and a matching negative control keeps the agent from waking on its
own messages.

**Suggestions take threads.** A suggestion card can be discussed before it is decided: reply on the
card, and the agent answers in place. Accept and reject stay the human's.

**Presence survives long turns.** The per-thread "claude is replying" mark used to die three minutes
into a long turn, because `working` presence had no heartbeat once the wait exited. Every CLI write
verb now refreshes presence as a side effect, so a multi-thread turn keeps its remaining marks lit
for as long as the agent keeps working. On the wire this is a protocol distinction: a presence ping
with no `items` field refreshes the clock and keeps the marks, an explicit empty list clears them.

**A rejection with a reason lights the mark.** The digest ships rejection reasons in full so the
agent can retry, and now the rejected card shows "claude is replying" while that retry is composed.
A bare rejection stays dark, since "just no" usually gets silence and a lying light is worse than
none. Accepts and resolves stay dark too.

**The agent stops waking itself on its own drops.** The cursor now records who authored each card,
so an agent dropping its own card produces no wake, while a card someone else authored going
missing still reports.

**A suggestion can propose new list items.** When the quote covers a whole list item and every
replacement line is an item of the same kind at the same indent, the splice is safe and now
permitted. Partial spans, mismatched markers, and mixed block types stay refused; a `*` in a `-`
list opens a second list in CommonMark, so the marker rule is correctness rather than caution.

**Also:**

- The selection toolbar rises for keyboard selections, so shift-arrow selection can bold, link, or
  comment without touching the mouse.
- `doctor` warns when a host repo has not gitignored the agent-state files (`*.review.seen*`).
- `spliceRisk` recognizes `2)`-style ordered markers as block boundaries.

**Upgrading:** a `sidecar wait` process armed before the upgrade holds the old digest code and keeps
the reply-dropping bug until it exits. Re-arm your waits after updating.

## 1.5.0 (2026-08-12)

**Per-thread presence.** The card the agent is answering now says so: a shimmering *claude is
replying* at the tail of the thread, cleared the moment that reply lands. The signal rides the
`sidecar wait` exit the tool already makes (the digest knows which threads woke it), so every agent
that drives `wait` gets it unchanged, and there is nothing an agent has to remember to call. Only
threads that expect an answer light up; a decided suggestion or an orphaned anchor never shows it.
Presence records are now kept per (file, agent), so two agents on one document can't wipe each
other's state, and the browser expires stale presence on its own clock, so a killed agent goes
quiet instead of glowing "working" forever.

**The digest owns its document baseline.** `sidecar digest` and `wait` used to diff review items
against your last look but the document against git HEAD, which is a different clock. Untracked
docs and non-git directories produced "your turn" digests with empty bodies, tracked docs re-sent
every uncommitted hunk on every look, and a mid-review commit silently blanked the diff channel.
The cursor now keeps its own copy of the doc (`<doc>.review.seen.base.<agent>`) and diffs
in-process, so the doc half of the digest finally means "since your last look" everywhere, and
mid-review commits are harmless.

**A motion pass.** Cards animate in and out (accept, reject, and resolve share the same exit),
buttons got a spring press and a lift on hover, the toast eases in and out, and thread messages are
tinted by author so replies read at a glance. All of it honours `prefers-reduced-motion`.

**Fixes.** A server launched from a symlinked directory (`/tmp`, `/var/folders`) silently rejected
every presence ping; the root is now canonicalized at boot.

## 1.4.0 (2026-08-12)

- `.mdx` files are accepted.
- The gap between blocks is no longer marked as anchored content.
- Security: patched DOMPurify, and the package no longer ships the README's own review state.

## 1.3.0 (2026-08-03)

- **Screenshots in comments.** Paste or drop an image into any comment or reply box, or attach one
  from the camera roll on a phone; agents attach with `--image` and can read what you attach. Images
  live in `<doc>.review.assets/` next to the review.
- Attach is an icon beside resolve, not the word "image".

## 1.2.2 (2026-07-30)

- Agents hand the human the browser URLs instead of a terminal.

## 1.2.1 (2026-07-29)

- `sidecar doctor` stops reporting STALE for every npm install; it now distinguishes a genuinely
  stale server from a different installation and from a version mismatch.
- `--version` / `-v` print the version instead of trying to serve a directory named `--version`.

## 1.2.0 (2026-07-29)

- `sidecar skill` prints the agent protocol on stdout, so the agent that just installed the tool can
  read how to drive it without leaving the shell.

## 1.1.0 (2026-07-29)

- Review cards dock beside the text they're about; a tall card clips with its actions kept reachable.
- ` ```flow ` fences render as diagrams whose nodes take comment threads directly.
- The decision digest: a persistent per-agent cursor, a `digest` verb, and `wait` waking only on what
  the agent hasn't seen.
- Mobile: the review as a pull-up sheet, presence on the phone, `SIDECAR_USER` for the human's name.
- Comment and note bodies render as markdown.
- Packaged for public release as `@spktr/sidecar`.

## 1.0.0 (2026-07-28)

Initial release: suggestion cards with word-level diffs, comment threads, content-based anchors with
loud orphaning, rich-text editing on the real file, `sidecar wait`, and the localhost server.
