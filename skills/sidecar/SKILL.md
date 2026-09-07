---
name: sidecar
description: |
  Review and revise a document together with a human, on their own machine. Use sidecar instead of
  pasting a draft back and forth whenever the task is collaboratively working through a prose
  document — a PRD, proposal, spec, essay, email or blog draft, summary, one-pager, memo, contract,
  community post, or any markdown file on disk. Triggers include naming it ("open this in sidecar,"
  "respond to my comments in sidecar") and generic collaborative-review intent without the word
  ("let's review this doc," "let's edit this together," "look this over and suggest changes," "work
  through this proposal with me," "let's revise this"). Sidecar gives tracked suggestion cards with
  word-level diffs, comment threads, and rich-text editing on the real file, anchored by content
  rather than line numbers. It also reviews an .html file as the visual it renders — a poster, a
  social card, an email template — where comments anchor to elements instead of to text. NOT for a
  quick one-line take or a prose-tightening pass, and not for code review. Needs the document as a
  file on disk.
---

# sidecar — reviewing a document with a human

Sidecar has two sides.

- **The human** uses the browser at `http://localhost:4880`. They read, comment, accept or reject
  your suggestion cards, and edit the rich text directly.
- **You** use the **commands below**. They read and write a JSON sidecar next to the document. The
  running server watches those files and pushes your changes into their browser live; their decisions
  come back to you through the same files.

You never call the HTTP API, and you never hand-edit the sidecar JSON. Every action is one command.

**What your items look like to them.** A suggestion renders as a card showing a word-level diff of the
quoted text against your replacement, with accept and reject buttons; `--note` appears as one line
underneath. A comment renders as a thread they can reply to or resolve. An `answer` nests inside the
thread it responds to, so the diff sits right under their question. Every open item softly highlights
its span in the document. Keep replacements short enough to read as a diff — a card is not a good place
for three paragraphs.

---

## Start here

**Setup is yours, not theirs. Never hand the human a shell command to run.** Installing this skill
was their last terminal step; assume they do not have a terminal open and would not know what to do
with one. Everything below you run yourself.

Put `sidecar` on PATH, and bring an older copy forward at the same time; nothing in the package
updates itself, so a global install stays on the version it was:

```bash
npm i -g @spktr/sidecar@latest
```

If that fails — a permissioned or sandboxed npm prefix is the usual reason — **do not report it and
do not ask them to fix it.** Prefix every command in this file with `npx -y @spktr/sidecar` instead
(e.g. `npx -y @spktr/sidecar doctor doc.md`) and carry on. Nothing here needs the global install; it
only shortens the commands.

`sidecar help` lists every verb, and `sidecar skill` prints this file from inside the installed
package — reach for that one when the installed version might be older than what you are reading.
`sidecar doctor` asks the registry whether the install is current and prints the upgrade command when
it is behind. An `npx` run re-resolves `latest` on its own when it is online.

```bash
sidecar doctor                # is a server running, on what code, and what URLs to hand over
sidecar doctor path/to/doc.md # …including the deep links for that specific file
```

`doctor` also warns when the host repo has not gitignored your digest state (`*.sidecar.seen*`). Act
on that warning when you see it; sidecar never edits a host `.gitignore` itself.

If nothing is running, start one yourself — it serves a file or a whole directory:

```bash
sidecar ~/path/to/docs        # → http://localhost:4880
```

**That command does not return** — it is the server. Start it in the background (Claude Code: Bash
with `run_in_background`), or detached with `nohup … &`. Running it in the foreground hangs your
turn and the human sees nothing happen.

The other commands work with **no server running** — the filesystem is the sync layer. A server is
only needed for the human's browser.

**Always hand the human both URLs** when a review is ready; they are often on a phone, not at a desk.
`sidecar doctor <file>` prints both, including the tailnet address if one is configured.

---

## The commands

Every command takes the file path first. The **verb is the kind** — there is no `--kind` flag.

### Raising things

```bash
# a question or note, as a thread
sidecar comment doc.md --quote "success metrics" --text "No targets here yet — want me to draft three?"

# a "look here" with no question
sidecar flag doc.md --quote "ship all six in week one" --text "This reads as an overcommit."

# a specific edit, shown as a word-level diff they can accept or reject
sidecar suggest doc.md \
  --quote "We will ship all six features in week one." \
  --replacement "Week one ships the three core features; the rest follow once those earn their place." \
  --note "Optional one-line rationale, shown under the diff."
```

### Attaching an image

`comment` and `reply` take `--image <path>`, repeatable. The file is copied into
`<doc>.sidecar.assets/` and appended to your message as a markdown link — so it keeps rendering after
whatever scratch directory you generated it in is gone.

```bash
sidecar comment doc.md --quote "the hero section" --text "This is what it looks like at 375px:" \
  --image /tmp/mobile.png
```

**They can attach images too** — pasting or dropping a screenshot into a comment box puts the same
markdown link in the message. So a comment whose body contains
`![](doc.md.sidecar.assets/ab12cd34ef56.png)` is a screenshot they wanted you to look at: **open that
path with your own file tools and actually read it before you answer.** The path is relative to the
document. Replying to a screenshot you never opened is the fastest way to answer the wrong question.

### Responding to them

```bash
sidecar reply doc.md c-metrics-a1b2c3 "Cut it — done."          # a message in their thread
sidecar reply doc.md c-metrics-a1b2c3 "Rewritten." --resolve    # …and settle the thread
sidecar resolve doc.md c-metrics-a1b2c3                         # settle it outright

# answer their comment WITH an edit: renders as a card nested in that thread, and
# accepting it auto-resolves the comment. Inherits the comment's anchor — no --quote.
sidecar answer doc.md c-metrics-a1b2c3 --replacement "Target: 200 signups by March."
```

### Housekeeping

```bash
sidecar reanchor doc.md s-intro-d4e5f6 --quote "the text as it reads now"   # rescue an orphan
sidecar suggest doc.md --id s-intro-d4e5f6 --replacement "a better wording" # revise a card in place
sidecar drop doc.md s-intro-d4e5f6                                          # withdraw your own item
```

`reanchor` repoints the anchor keeping the content; `suggest --id` keeps the anchor and revises the
content (no `--quote` — the card's existing anchor is reused).

### Long or multi-line text

Bash quoting will mangle multi-line markdown, so `-` reads the value from stdin:

```bash
sidecar suggest doc.md --quote "…" --replacement - <<'MD'
Week one ships three features.

The rest follow once those earn their place.
MD
```

### Seeding a review in one call

```bash
sidecar add doc.md <<'JSON'
[
  { "quote": "all six features", "replacement": "the three core features", "note": "Overcommit." },
  { "quote": "success metrics", "text": "No targets here yet — want three?" }
]
JSON
```

`kind` is inferred: a `replacement` makes it a suggestion, a `text` makes it a comment.

### Reading

```bash
sidecar wait doc.md --timeout 900  # block until they act, then print the digest since your last look
sidecar wait doc.md --timeout 0    # …with no backstop at all: it returns when they act, and not before
sidecar digest doc.md              # the delta since your last look — re-check mid-turn without a full show
sidecar digest doc.md --peek       # …without advancing the cursor
sidecar show doc.md                # the COMPLETE current state — items, statuses, threads, diff, done
sidecar show doc.md --needs-reply  # just the threads whose last message is theirs
sidecar show doc.md --json         # same, machine-readable
sidecar check doc.md               # lint every anchor in the sidecar
sidecar check doc.md --quote "…"   # pre-flight one quote before you write it

sidecar wait --dir /abs/folder     # the same block over every document in a folder, one process
sidecar digest --dir /abs/folder   # the same delta, one heading per document
```

Reviewing more than one document? `wait` and `digest` take `--dir <folder>` where they take a file.
See **Folders** below.

`wait` and `digest` share a persistent last-seen cursor (a sibling `foo.md.sidecar.seen.json`, keyed by
your `SIDECAR_AGENT`), so each reports only what changed since the last time you looked and advances the
marker. That covers the document too: a sibling `foo.md.sidecar.seen.base.<agent>` holds the doc text as
of your last look, and the digest's doc-changes section is a diff against it — since your last look, not
since the last commit, and independent of git entirely (untracked files and non-git directories diff the
same). `wait` blocks until there IS a change and returns that digest; `digest` reports the delta right
now. Both print ids, so you can `reply`/`answer` straight off a digest without a `show`. `--peek` reads
without advancing. Cursor and baseline are agent workspace state — never commit them (they're
git-ignored, pattern `*.sidecar.seen*`); delete them to replay everything.

---

## Anchors — the one thing to get right

Comments and suggestions attach to **quoted text**, not line numbers. If the text moves, the anchor
follows; if it disappears, the item goes `orphaned` — loudly — rather than editing the wrong place.

The commands handle the mechanics. `--quote` is matched against the file, whitespace-normalised and
markdown-tolerant, so it can be either the raw markdown (`**bold**`) or the visible text (`bold`), and
for a **comment** it may span soft line breaks and block boundaries — a quote taken from the rendered
document, running across two list items, still anchors. The occurrence index is resolved for you.

**A suggestion is stricter, because accepting one rewrites those exact bytes.** Both sides are checked.
The span is refused if it crosses a block boundary or a blank line, or starts or ends inside inline
markup — replacing such a span eats a list marker or leaves a dangling `*`. The *replacement* is
refused if it carries block structure (a blank line, heading, or list marker) into a span that is only
part of a line, or into a list item — that splits the block around it. In both cases the word-diff
would have looked clean while the file came out mangled.

So: quote within a single block, quote the raw markdown (`**bold** text`, not `bold text`) when the
span touches emphasis or code, and only introduce new blocks when your quote covers a whole
paragraph. To point at something spanning blocks, use a comment — comments only anchor, so they are
unrestricted.

**Proposing a NEW list item is the one exception**, because it is item-for-items at the same level and
the list comes out the same list. Quote the **whole** item, marker included, and make every line of the
replacement an item carrying that same marker:

```bash
sidecar suggest plan.md --quote "- **Ship the beta.** By March." --replacement - <<'MD'
- **Ship the beta.** By March.
- **Write the launch note.** Same week.
MD
```

Four things this asks of you, each of which is refused otherwise. The quote covers the marker (`- …`,
not just the text) and the item's continuation lines, if it wraps onto an indented second line. Every
replacement line is an item at that same indent with that same marker character, or a line indented
under one; a `*` where the list uses `-` opens a second list in markdown. The first line repeats the
original marker verbatim, ordered number included, and later items may number however you like, since
markdown counts from the first item. No blank lines, which would split the list in two.

Refused, and use a comment instead: a nested (indented) item, whose marker sits outside the span the
matcher can anchor; a replacement mixing in a paragraph or heading; and anything inside a blockquote.

**What is left to your judgment is choosing a quote that identifies exactly one span.** Everything
else is enforced:

- A quote matching **nothing** is refused, and nothing is written. `sidecar check --quote "…"` will
  bisect it and tell you which word it breaks at.
- A quote matching **several** spans is refused, with the count. Use a longer quote, or pass
  `--occurrence N` (0-based) if you genuinely mean the Nth.

If an item does orphan because the human rewrote that passage, `sidecar reanchor` it onto the new
text, or `sidecar drop` it.

**About `--force`.** The refusal messages mention it, so: it exists for the narrow case of seeding an
anchor onto text you are about to write, before that text exists. It is never the right answer to a
refusal you do not understand — a forced item lands `orphaned`, or worse, applies a splice the check
was trying to prevent. Fix the quote instead.

---

## Visuals — diagrams, HTML, images

Some things are worth showing rather than describing, and a flow is the clearest case: the human wants
to comment on *the step*, not on the sentence about the step.

**A ```flow fence renders as a diagram, and each box is a comment target.** The human clicks a box and
gets a thread anchored to that node. Write the fence as ordinary document content:

````markdown
```flow
Sign up --> Verify email
Verify email --> {Valid?}
{Valid?} -->|yes| Onboarding
{Valid?} -->|no| Verify email
```
````

`A --> B` is an edge · `-->|label|` labels it · `{…}` is a decision (drawn as a diamond) · a first line
of `LR` lays it out left-to-right instead of top-down · `%%` is a comment · chains work
(`A --> B --> C`). A node's identity is its label text, so repeating a label refers to the same box.
A line that can't be read is reported under the diagram rather than dropped.

This is a deliberate subset of mermaid's flowchart syntax. It is not mermaid — no subgraphs, no other
diagram types.

**Commenting on a node from the CLI needs `--occurrence`.** A label appears once per edge that names
it, so `--quote "Verify email"` is ambiguous by construction and will be refused with a count. Pass
`--occurrence 0` for its first mention in the fence, and remember the label may also appear in the
prose around the diagram — `sidecar check <file> --quote "…"` shows you every match before you write.

**Raw HTML renders too**, for what the flow syntax can't draw. Inline `style=""` only — a `<style>`
tag is stripped, as are `<script>`, event handlers and `<iframe>`. Prefer a diagram: the HTML block is
opaque to a reader of the raw file, where a fence stays legible in a `git diff`.

**Images work by relative path** — `![wireframe](./wireframe.svg)` resolves against the document.
Generating an `.svg` next to the file and linking it is the right move for anything the flow syntax
can't express. The same path form works inside a comment; `--image` above is the shortcut for it.

**Both render as islands the human cannot type into.** That is deliberate: the editor saves by
re-serializing edited blocks, and an `<svg>` cannot survive that trip. So *you* change a diagram by
editing the file; they change it by asking you to. Their comments and your edits work as normal
everywhere else in the document.

---

## Assets — reviewing an .html file as the thing it renders

A document is markdown **or an asset**: an `.html` file (`.html`, `.htm`) reviewed as a rendered
visual. A poster, a social card, a signup sheet, an email template. Open it the same way you open
markdown, `sidecar poster.html` or `?f=poster.html`, and the human sees the page as a page: full CSS,
real fonts, real images, scaled to fit the column.

**An asset is read-only in the viewer, and its review anchors to ELEMENTS rather than to quoted text.**
That is the whole difference. Everything else — threads, replies, resolve, orphans, the digest, the
cursor, `wait` — is unchanged.

```bash
sidecar elements poster.html                      # every anchorable element: label, tag, its text
sidecar comment poster.html --element headline --text "Two words too long for this line."
sidecar flag poster.html --element '#cta' --text "This link goes nowhere."
sidecar check poster.html --element headline      # pre-flight one, the way --quote does for markdown
sidecar check poster.html                         # lint every element anchor already stored
```

`<ref>` is a `data-sc` value (`headline`), an `#id`, or the selector spelling (`[data-sc=headline]`).
`--quote` on an asset and `--element` on markdown are both hard errors: they are two anchor kinds and
the document decides which one it takes.

**`sidecar elements` is how you see what they see.** It lists everything the file marks as anchorable,
which is every element carrying a `data-sc` or an `id`. If it prints nothing, the file has no handles
yet — add `data-sc="…"` to the elements worth discussing (you are allowed to edit the file; it is a
document like any other) and run it again. Two elements sharing a label are both listed, and
`check --element` says so rather than picking one.

**The human is not limited to that list.** In their browser the render is live: hovering outlines the
element under the cursor and clicking it opens a comment on it, whether or not it carries an
attribute. An element with neither a `data-sc` nor an `id` anchors by its position and its text
instead, which is most of a real poster. So expect element items you never named — their anchor is
just as durable as one you wrote.

**They can also reach what is buried.** Hover only ever finds the top of the paint stack, and a poster
usually has a full-bleed layer over everything (a scrim, a dot screen, a gradient wash). Tapping Alt
steps the outline one layer deeper and wraps at the bottom, with the depth shown beside the label
(`img · 2/5`). So a comment can land on the background photograph under three overlays, and the
element reference you get back is that photograph's.

**A link inside an asset is held behind Shift.** A plain click always writes a comment, on a nav bar
and a citation as much as on anything else; Shift+click follows the link, and while Shift is down the
asset's links underline and take a pointer, so the two clicks are told apart before either is spent. A
relative link naming another document in the served root opens in sidecar, an outbound URL opens a tab,
and a fragment scrolls the asset it is already in. So a set of linked wireframes is walkable and their
nav is still commentable.

**You edit the file; the frame reloads.** There is no save, no accept, no splice: `suggest`, `answer`
and `reanchor` all refuse an asset, because accepting a diff would mean splicing raw bytes into HTML.
Change the markup yourself and `sidecar reply` that it is done, exactly as you would for a mechanical
edit in markdown. The watcher pushes the new render into their browser.

**An element item orphans when its element goes, and only then.** It carries
`orphanReason: element-changed`, shows on the card as *orphaned — element changed*, and revives on its
own if the element comes back. The element is what the card is about; its text is how sidecar
recognizes it. So **editing the text never orphans the card that asked for the edit.** Rename the attribute and the position and the
signature still find it; rewrite the text and the attribute or the position still does; move the
element and its signature still does. Delete it and the card orphans.

`sidecar check <asset>` has three answers about an element anchor, not two. `ok` means the attribute
or the signature is in the file. `MISS` means it is gone, and that exits 1. `?` means the anchor pins
by a structural path, which Node cannot run without a DOM. The browser resolves that one for real on
the next open and writes back what it finds, so treat it as information rather than as a thing to fix.

**Images and fonts the asset references keep working.** Relative `src` and `url()` references are
resolved against the document, so `<img src="./face.jpg">` and `@font-face { src: url(./x.woff2) }`
render. Absolute URLs are left alone and, since the render is isolated, external ones may simply not
load — prefer local files for anything the review depends on.

**Nothing in the asset executes.** The frame strips every `<script>`, event handler and `javascript:`
URL before rendering, and runs sandboxed. A poster that "works" only with its JavaScript will render
as its unscripted self, which is worth knowing before you ask why an animation is missing.

---

## Folders: a review across several documents

A product review is usually a folder rather than a file: a brief, a market research report, a
business case. Serve the folder (`sidecar ~/path/to/project`) and both sides get the folder.

**What they see.** A panel down the left lists every document in the open document's folder, that
folder only, no recursion. Clicking a row opens it in place. The panel sorts three ways and
remembers which per folder: *spine* (`summary.md` first, `brief.md` second, then alphabetical),
*last updated*, and *waiting on you*.

Each row carries a badge counting the items on that document whose next move is THEIRS: a live
comment whose latest message is yours, plus every pending suggestion. A document with open items
that are yours to move shows a neutral dot instead, and a settled document shows nothing. The
panel's **inbox** tab (beside **files**) lists those open items across the whole folder, grouped by
document; clicking one opens that document and lands on the anchored span. So they can see where the
conversation stands without opening five documents, and your reply is what clears a row.

**Relative links between documents open in sidecar.** Write `[the research](./market-research.md)`
in a brief and a click on it loads that document in place, with browser back returning to the
paragraph they left. Outbound URLs, `mailto:`, in-document anchors, and paths outside the served
root behave exactly as they did. So a citation you write is a citation they can follow.

**What you do: one watcher for the whole folder.**

```bash
sidecar wait --dir /abs/path/to/folder            # blocks until they act on ANY document in it
sidecar digest --dir /abs/path/to/folder          # the same delta right now, per document
sidecar digest --dir /abs/path/to/folder --peek   # …reading it without advancing anything
```

**Use `--dir` for any review covering more than one document.** One process instead of one per
document, one digest with a `###` heading per document, and no set of background watchers to keep
armed, which is where a document quietly stops being watched and a comment on it goes unanswered.

The contract is the single-document one, read a folder at a time:

- **Exit 0**: they acted. The digest is on stdout, labelled by document. Respond, then arm it again.
- **Exit 1**: the timeout. Nothing advanced; it means run it again. `--timeout <seconds>` as usual.
- **Exit 2**: the path is not a folder, or another watcher already holds it.
- `DONE: true` only when **every** document in the folder is done. Until then the tail names how many
  are, so you can watch a review close without opening anything.
- **One folder watcher per folder per agent.** A second one refuses and names the holder's pid;
  `--force` takes over a wedged one, and `sidecar watchers` says whether that pid is still running.
  Two would share every cursor in the folder, so whichever advanced one first would decide what the
  other believed it had seen.
- **The per-document cursors are unchanged.** `--dir` aggregates and stores nothing of its own: still
  one `<doc>.sidecar.seen.json` per document, keyed by your agent name, advanced exactly as running
  `sidecar digest` on each would. So you can swap between a folder wait and a per-document wait
  mid-review, and a per-document `wait` inside a folder someone is dir-waiting is allowed rather than
  refused. Neither replays a turn nor skips one.
- **The lock lives in tmp**, not beside the documents, so nothing new appears in the folder and a
  `*.sidecar.seen*` gitignore line still covers everything sidecar writes there.
- **Presence covers the folder.** While a folder wait is armed, every document in it reads *claude is
  here*; when it wakes, the document that woke it shows *claude is replying* on those threads while
  the rest of the folder reads *claude is working*.
- **A document created mid-wait joins on its own**, baselined where it stands, so creating a file is
  not itself an event and the first real change to it is. You do not re-arm to pick it up.

Passing a folder to the single-document `sidecar wait` tells you which flag it wanted rather than
sleeping until its timeout.

---

## Waiting for them — the step agents skip

**Nothing pushes into your session.** sidecar will not interrupt you, and the human's comment will
not appear in your context on its own. If you hand over a URL and then stop talking, you will never
see a word they write, and from their side you have simply gone silent with a comment sitting
unanswered. **Arming a watcher is not optional; it is how you stay in the conversation.**

```bash
sidecar wait /abs/path/to/doc.md      # blocks until they act, then prints the digest
```

Pass an **absolute path**. A relative one resolves against your cwd, and `wait` exits `2` rather than
watching the wrong file.

**If the review covers a folder, arm `sidecar wait --dir <folder>` instead** and read the rest of
this section as written: everything below is true of both, and one folder watcher replaces the pile
of per-document ones.

**If your harness can run a command in the background and wake you when it exits, use that** — Claude
Code: Bash with `run_in_background`. `wait` fs-watches, so it costs nothing while it sleeps and
returns the instant they act. A 15-minute block is free.

**Otherwise, poll.** Foreground with a short timeout, and run it again:

```bash
sidecar wait /abs/path/to/doc.md --timeout 60
```

- Exit **0** — they acted; the digest is on stdout. Respond to it.
- Exit **1** — the timeout. It prints `still watching`, advances nothing, and means *run it again*.
  The line says so itself: the timeout expired, nothing was missed, and the cursor sat still, so
  re-arming picks up exactly where it left off.

Never leave the 15-minute default blocking a foreground turn.

**`--timeout 0` removes the backstop**: the wait returns when they act and not before. Use it only for a
watcher your harness runs in the background and can kill; in the foreground it blocks the turn forever.
The default with no flag is still 900.

### What is still armed

```bash
sidecar watchers                  # every wait on this machine: document or folder, agent, pid, how long
sidecar watchers --clean          # remove the records of the ones whose process is gone
sidecar watchers --kill <pid>     # stop one that is running, and clear its record
```

Three states, and only one is yours to clear. **LIVE** is armed and beating. **QUIET** is running and has
missed three heartbeats, which is suspended or wedged, and `--clean` leaves it alone. **STALE** is a record
that outlived its process, usually a backgrounded wait that died with its harness, and that is all
`--clean` removes. A live watcher is never touched.

Reach for it when a `wait --dir` refuses with `already watching` and you believe the holder is gone, or when
you have lost track of what you left armed across a long session. `--kill` checks the pid against `ps`
before signalling and refuses anything that does not read as a sidecar wait, since a pid is recycled the
moment it is freed.

**Re-arm after every response.** One `wait` covers one turn: respond to the digest, then wait again.
You stop only when the digest says `DONE: true` or the human says they're finished. A review where
you answered once and stopped watching is a review they think you abandoned.

**The human can see this loop.** While your `wait` is armed the browser header reads *claude is
here*, and when it wakes, the threads it woke on show *claude is replying* until your reply lands.
A rejection that carries a reason lights its card the same way, because the reason is an invitation
to retry and you are presumed to be composing one. The `wait` exit does that on its own, and every
write verb you run refreshes the signal as a side effect; there is no presence command for you to
call. It also means a wake you sit on looks exactly like what it is.

---

## The loop

1. **Draft** the document (the first version is usually yours).
2. **Suggest** — cards and comments anchored to real text.
3. **Hand over both URLs**, then arm `sidecar wait` as above, or `sidecar wait --dir` when the review
   covers a folder.
4. **When it returns, act on its digest.** In steady state that is enough — the digest is everything
   that changed since your last look (decisions with their reasons, new comments and replies in full,
   orphans, the doc diff), not just the one event that woke it. Reach for `sidecar digest` to re-check
   mid-turn, and `sidecar show` for the full picture when the delta isn't enough context: the first pass
   of a session, after an error, or before the final commit.
5. **Respond**, then arm `sidecar wait` again.
6. Repeat until the digest says `DONE: true`, then make **one commit**.

Committing mid-review is safe — the digest diffs against its own baseline, not against HEAD, so a
checkpoint commit costs nothing. Still prefer to land the finished doc and its `.sidecar.json` together
in that final commit: half-decided reviews make weak history.

**The digest is complete since your last look — trust it, don't skip it.** It is baselined on a
persistent cursor, so anything the human does while you are composing is still there on the next `wait`
or `digest`, not lost. This is what the earlier in-memory delta got wrong: it reported only the event
that woke it, and five stacked comments were silently buried that way on 2026-07-22. Act on every item
the digest lists; when in doubt about older context, `sidecar show`.

Respond according to what they asked for:

- **Mechanical** ("cut this", "fix the typo") → just edit the file and `sidecar reply` a short "done".
  No card; it is applied and reversible.
- **Judgment** ("make this warmer", "tighten this") → `sidecar answer` their comment, so the diff lands
  inside the thread. If they reject it, `sidecar answer` again and iterate.

---

## What sidecar will not do

**It never interprets the document.** It has no notion of tasks, tags, checkboxes, or any external
schema, and it models no jobs — no queue, no running or failed states, no progress, no history. A
comment carries a request and its reply; deciding *what* it asks for and *how* to act is entirely
yours. If your workflow needs richer semantics, build them above sidecar, not inside it.

**You cannot accept or reject.** Those are the human's, in the browser. You propose; they decide.
There is deliberately no command for it.

---

## What gets stored

Each reviewed `foo.md` gets a sibling `foo.md.sidecar.json` holding the items. You should not need to
read or write it directly — `sidecar show` is the readable view and the commands are the writable one —
but it is plain JSON, it belongs in git alongside the document, and the schema is stable.

Commit it with the document when the review ends — and until you do, remember a `git checkout -f`
or `git stash` discards the whole review — every card and comment, not just an anchor (checkpoint
commits mid-review are safe and protect against exactly that). There are also two agent-state siblings,
never committed (gitignored as `*.sidecar.seen*`): `foo.md.sidecar.seen.json`, the cursor of what you have
already read, and `foo.md.sidecar.seen.base.<agent>`, the doc text as of your last look, which the
digest's doc-changes diff is computed against.

Images attached to comments are files in `<doc>.sidecar.assets/`, named by content hash, referenced
from the message as ordinary markdown. Nothing is stored as bytes inside the JSON, so it stays a small
text file you can diff — and the pictures commit and delete alongside the review that holds them.

All four were named `<doc>.review.*` before 1.7.0. Opening the document renames the set, printing one
line on stderr when it does, so a review written by an older sidecar keeps working. If both names are
on disk, the `.sidecar.json` is the live one and the `.review.json` is ignored rather than merged;
`sidecar doctor` lists whatever is still on the old names.

Statuses: suggestions run `pending → accepted | rejected`; comments run `open → resolved`; either can
become `orphaned`. Items are stamped with `by` (your agent name — set `SIDECAR_AGENT` if `claude` is
wrong) and real timestamps, both filled in for you.

---

## Reviewing from a phone

`tailscale serve --bg 4880` proxies sidecar onto a private [Tailscale](https://tailscale.com) tailnet,
so the human can review from their phone with the machine awake (the repo wraps this as
`./scripts/tailscale-serve.sh`). Add the tailnet hostname to `SIDECAR_HOSTS` so the Host allowlist
accepts it. Keep it tailnet-only: sidecar has no authentication, so never `tailscale funnel` it
publicly.

---

## Working on sidecar's own code

If you edit `server.js`, `lib/`, or `public/`, a running server keeps serving the OLD code until it
restarts — you will be testing against stale logic. `sidecar doctor` compares the running server's
code stamp against the code on disk and says **STALE** when they differ. Restart before testing.
