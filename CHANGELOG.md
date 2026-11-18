# Changelog

## 0.4.3 — two review passes

Two models read the whole tool in turn, reproduced every claim before changing it, and
the second audited the first: five of the first pass's eleven fixes were incomplete.
Everything below was observed, not inferred.

### Second pass (content identity, honest checks)

- PDF text and whole-document observations now use content digests, not mtime+size;
  restored equal-size PDFs no longer verify text from an older build. Build signatures
  also hash tracked inputs and verify the output PDF. Nested literal inputs and graphics
  paths are resolved from TeX's compilation directory, not the including file's directory.
- Page-text extraction uses unique temporary files. Returned PNGs and composites are
  immutable per call: concurrent documents cannot exchange text, and a missing page
  cannot return an old PNG. The document lock covers snapshots and observations as well
  as compilation; concurrent looks no longer share a partly published baseline.
- Comparison selection is separate from snapshot publication. `compare: null` disables
  the diff; an unreadable explicit baseline does not stop the next previous-build snapshot.
  CLI output now displays comparison declines, and errors distinguish missing pages,
  corrupt baselines and different page sizes. A successful no-op `latexmk` invocation
  no longer falsely says that no PDF was produced.
- One classic pass over a setup-only or comment-only `.toc` is an empty-TOC error,
  not a warning. Entry count, not file size, decides whether an old TOC was populated.
- Sequence scans decline unsupported or partially matched numeric labels rather than
  truncating `3.2a`/`3.2.1` to `3.2`. Replies preserve the labels actually read.
  Extraction errors are visible in every frontend.
- CLI point parsing consumes adjacent coordinates only; third tokens, missing option
  values and unknown options are refused. Boolean flags no longer swallow the filename.
- Failed auxiliary tools fail the build. Failed partial PDFs cannot pass a sequence
  check or replace an audit baseline; blank and otherwise uncalibratable audits decline
  and preserve the last usable baseline.
- A horizontal rule must cross the queried x-coordinate. Missing SyncTeX mappings now
  say so, instead of silently dropping a point request or calling existing source text
  absent. An invalid page cannot return a location from page one.
- The running version is captured during module initialization, before the first call,
  and SemVer precedence compares numeric prerelease identifiers and ignores build metadata.
- Added real-engine regressions and prior-version counterchecks. The CLI JSON test now
  asserts an actual edited-page diff. `npm test` includes all four second-review suites;
  optional book tests remain separate.

## Unreleased — answers that came from the wrong place

Every defect below was reproduced before it was fixed, against real documents.

- **Page text survived a rebuild.** The per-page text cache was keyed on the PDF's
  path, which `look()` writes to again on every build. After an edit it answered with
  the text of the page as it used to be, so `pageCarryingText` "confirmed" a caption
  was on the page it had already left: `--text` reported `→ page 1` —
  `pageVerified` — for a caption that had moved to page 2. That is a check reporting
  success without having run, which is the one outcome this tool exists to prevent.
  The key now carries the PDF's mtime and size, and the cache is bounded.
- **`compare: <path>` was ignored.** The pre-build snapshot was published over the
  caller's baseline whenever a build happened, so pointing `compare` at another PDF
  diffed the new page against its own pre-edit self: a completely different document
  measured 0.02% and read as "nothing changed". The snapshot is now published only
  when the caller asked for `previous`.
- **`sequence` passed on the documented example.** The separator between chapter and
  number was `-`, `–`, `—` only, though README and `SKILL.md` both give
  `Figure 3.2`. A dotted document reported `0 label(s), all in reading order` — a pass
  for a scan that matched nothing, on a page with two captions in front of it. `.` and
  `·` are accepted, and **zero matches now declines** with what was searched.
- **A point lookup with `--point 300 78` silently located nothing.** Only the comma
  form parsed; the space form became `y = NaN`, the point branch was skipped, and the
  run exited 0 with no LOCATED section. Both spellings work; a malformed point is
  refused with its own message instead of being ignored.
- **Two documents called `main.tex` shared one PNG path.** Renders were named after
  the PDF's basename under a per-process directory, so a second document's look
  replaced the image the first call had already returned. Renders now live in a
  per-document subdirectory.
- **An out-of-range page with a point threw ENOENT.** `gs` exits 0 having written
  nothing, and `renderPpm` read the absent file: `--page 99 --point 80,110` on a
  two-page document died with `ENOENT ... -p99.ppm` instead of saying the page is out
  of range. Also fixes a same-millisecond temp-name collision between two renders of
  one page.
- **`--engine latexmk` failed a correct table of contents.** `passes < 2` was judged
  on the count of *this tool's* engine invocations, but `latexmk` and `tectonic`
  converge inside one: a first build with a TOC was reported
  `the table of contents page is EMPTY ... maxPasses allowed only 1`, exit code 2, on
  a PDF that carried the TOC. The pass-count rule now applies only to the engines
  whose passes are actually counted; `tocExpected && !tocEntries` still fails a
  genuinely empty TOC.
- **`replaceFile` wiped its target when the source was missing.** `rm(to)` ran before
  the rename, so publishing a snapshot that was never written deleted the last good
  baseline. A missing source is now a no-op.
- **`page must be a whole number, got NaN`** hid the value the caller typed; it now
  echoes `2.5`.
- **The CLI allowed 300 s per pass while `--help`, `SKILL.md` and the plugin all said
  120.** It now passes 120. The plugin's own `timeoutSeconds` description said 300
  while its code clamped to 120; the description is corrected.
- `--audit`, `--audit-blank` and `--sequence` were missing from `--help`, though the
  README's CLI example uses `--audit`.
- **New `test/cli.mjs`** drives the real binary's argv handling; nothing did before,
  which is why the `--point` regression was invisible. Plus regression tests in
  `test/smoke.mjs` (page text after a rebuild, `replaceFile`) and
  `test/scenarios-deep.mjs` (dot-numbered sequence, zero-match decline, same-basename
  images, `compare` to another file).

## 0.4.2 — the version it is running, not the version on disk

An automatic update replaces the package directory while the old code keeps running.
The running code then read its version back off the new `package.json` and reported
the new number, so after an update that had not been loaded yet everything still
looked current — including "up to date" from `--check-update`.

- **The running version is read once, at start-up**, so it keeps meaning "what this
  process is running". `versionOnDisk()` asks the other question.
- **A restart is reported.** When the disk holds something newer than the process,
  one line appears in the tool reply and in the log: `0.4.2 is installed on disk, but
  this process is still running 0.4.1 — restart DeepSeek Harness to load it.`
- **The upgrade command names the real profile**, derived from the plugin's own path
  (`~/.dsh/profiles/<name>/node_modules/…`). No command is printed when that cannot
  be told, which is the case for a tarball, a git checkout, or `npx`.
- **The advice is no longer wrong.** It used to say "upgrade it with the plugin
  manager", which is not how the bundle in this profile updates: an updater plugin
  does that. The note now states what happened and what to do about it.

## 0.4.1 — Windows

The plugin was written on macOS, where Ghostscript is called `gs`, `PATH` is split
on `:`, `fs.rename` replaces the target and a child in its own process group can be
killed with a negative PID. Each of those is false on Windows, and the first one is
fatal: the plugin looked for `gs`, which the Windows installer does not create —
so a machine with Ghostscript installed was told it had none.

- **Ghostscript is found on Windows.** Looked up as `gswin64c`, then `gswin32c`,
  then by globbing `C:\Program Files\gs\gs*\bin`, because that version number is
  not something anyone can put on `PATH` in advance.
- **`PATH` is split on the platform's separator**, and `PATHEXT` suffixes are
  tried: on Windows there is no file called `xelatex`, only `xelatex.exe`, so every
  lookup used to fall through to the bare name.
- **`Path` works as well as `PATH`**, and the TeX install directories of TeX Live,
  MiKTeX and TinyTeX are probed when the installer did not update `PATH`.
- **A rebuild no longer loses the baseline snapshot.** `rename` onto an existing
  file fails on Windows; the snapshot is written every build under one name, so the
  second build onwards failed silently. It unlinks first, and retries briefly
  because an indexer holding the file is a matter of milliseconds.
- **Timeouts kill the whole process tree** (`taskkill /T`) instead of the direct
  child, which left `latexmk`'s children running and holding the `.pdf` open.
- **No console window flashes** on every compile and render (`windowsHide`).
- **`\r\n` in the TeX log is normalised** before parsing, so no message ends in a
  carriage return the reader cannot see.
- Not changed, and verified rather than assumed: PostScript escaping of the PDF
  path already doubles backslashes, so `C:\Users\...` inside a gs `-c` string
  works — now covered by a test that runs a document in a directory whose name
  contains a backslash.

Windows is covered by a real `windows-latest` CI job (Ghostscript + TinyTeX, then
compile, render, locate and speak MCP), not by reasoning about the code.

## 0.4.0

- **An MCP server.** `npx -y @fffangchenghao/dsh-latex-look mcp` speaks Model Context
  Protocol on stdio, so Claude Desktop, Cursor and Codex get the same tool as the
  Harness plugin: one `latex_look` with `file`, `page`, `text`, `pointX`/`pointY`,
  `compare`, `audit`, `sequence`, `dpi`. Pages are returned as image content blocks,
  so the model sees the page rather than a file path. Server version, protocol
  negotiation and the error codes are covered by a client that speaks the wire format
  with no SDK.
- The reply text moved to `lib/format.mjs`, shared by the plugin, the CLI and the MCP
  server. Three front ends describing the same measurement in three different words
  would be three tools by accident.

## 0.3.7

- **A table rule was invisible to the ink probe.** Detection asked what fraction of a
  full page row carried ink, so a `\hline` spanning a third of the page scored 0.30
  against a 0.35 threshold and came back as `none` — silence, which reads as "no
  feature here", on the one shape users ask about most after the header line. It now
  measures the longest unbroken run in the row: a rule is one run, a line of text is
  many short ones. The same table rule now reports
  `horizontal rule at y=155pt, 30% of page width` and is attributed: `drawn by line
  25: \hline`.
- The not-attributed wording stopped claiming more than it knows. `the document body
  does not draw this rule` was false for a `\toprule`, a tikz line or anything else
  a package draws; it now says `no rule-drawing command on line N or any of the 4
  lines around it, so it is drawn somewhere else`.

## 0.3.6

Three ways the tool could answer a question it had not actually answered, found by
testing documents whose pages are not all alike:

- **A point outside the paper** used to return a source line anyway, because synctex
  answers about the nearest box even when there is no box under the point. It now
  says how large the page is and locates nothing.
- **An unreadable text layer** made `sequence` report `0 label(s), all in reading
  order`— a pass for a check that never ran. A PDF whose glyphs carry no Unicode
  mapping now gets `cannot check the order: ... 90% of its characters are glyphs
  with no Unicode mapping`, and the same guard covers a PDF with no text layer at all.
- **An audit of a one- or two-page document** reported `0 page(s) stop short`, because
  the reference block bottom was that same page's bottom. It now declines with the
  reason.

Faster while fixing pages one at a time: the whole-document passes (text layer, ink
raster) are cached on the PDF's mtime and size, so a second `audit` in the same
session costs 2 ms instead of 7.5 s, and `audit` plus `sequence` together dropped from
11.5 s to 8.1 s on a 215-page book.

## 0.3.5

- **The tool reports facts, not advice.** When the point lookup finds a rule it now
  says what it measured and stops: `ink at this point: horizontal rule at y=47pt,
  76% of page width`, then either `drawn by line 15: \rule{...}` or `nearest source
  line 40 contains no rule command ... the document body does not draw this rule`.
  The previous wording told the reader to go and look at `\pagestyle` /
  `\headrulewidth`; that is knowledge about typography, not an observation, and the
  tool is the wrong place for it — it lives in `SKILL.md`, where the agent reads it
  and decides.
- The ink probe searches a ±4 pt band instead of one pixel row. Clicking a line is
  routinely a point or two off, and a miss left the caller trusting the locate answer
  this check exists to challenge. The finding reports the rule's own y, so a query
  two points away still lands on the truth.

## 0.3.4

- Fix the bundle patch for a scoped package name: `name: @scope/pkg` is not valid
  YAML, because `@` is a reserved indicator, so the installer rejected the package
  with `bad indentation of a mapping entry`. Quoted. 0.3.3 installs nowhere.

## 0.3.3

- **Moved to a scope: `@fffangchenghao/dsh-latex-look`.** The flat name
  `dsh-latex-look` is deprecated and kept only as a signpost. A scope makes the
  owner visible at a glance and removes the squatting risk that an unscoped name
  carries. Install with `target: @fffangchenghao/dsh-latex-look`.
- The update check follows the new name; the plugin id (`dsh-latex-look`) does
  not, because profile config and enable state key off it.

## 0.3.2

- **`--point` now says what is drawn there.** Asking "what is at (300,118)" on a
  rule used to return `\end{document}`, because a rule drawn by `fancyhdr` has no
  line of its own and inverse search returns the nearest box. The tool measures the
  ink instead: it reports whether the point holds a rule, text or nothing, and when
  the ink is a rule it either names the command that draws it
  (`drawn by line 15: \rule{\linewidth}{0.4pt}`) or says plainly that no line of
  the document draws it and the reader should look at `\pagestyle`/`\headrulewidth`.
- Point lookups return the queried coordinates instead of `x=undefined y=undefined`,
  and synctex's `/tmp/./main.tex` spellings are normalised.

## 0.3.0

Everything below came out of driving the tool against a real 215-page book
(《神经网络与深度学习》中文版) for a reader who could only see the PDF.

### Added

- **`audit`** — measure every page in one `gs` pass and report only what the
  current build broke, compared with the baseline the previous audit left
  behind. Running heads, rules and page numbers are detected and excluded first,
  or a page number becomes "the lowest ink in the book" and every page looks
  broken. Findings are matched by the text at the break, not by page number, so
  the comparison survives a repagination. When a page stops short and the next
  page opens with a caption, the finding names that caption.
- **`sequence`** — reading order of numbered labels (`图 1-1`, `Figure 3.2`).
  Floating one member of a numbered run makes the numbers go backwards, and no
  per-page diff can show it.
- **Update check** — the plugin asks the npm registry once a day, in the
  background, and appends one line to a tool reply when a newer release exists.
  `latex-look --version` and `latex-look --check-update` for scripts.

### Fixed

- `pageTexts` returns one file per page: `txtwrite` does not reliably separate
  pages with form feeds, so a single-file read reported every label on page 1.
- Anonymous `@` names in a preamble rewrite (`\nndl@chapter`) break the compile;
  the skill now says to use a plain name.

### Skill

- New playbook entries: a top float on a chapter opening page needs
  `\suppressfloats[t]` in `\chapter`; a figure that becomes a float must be
  floated together with its numbered run; floating moves a hole, it does not
  remove it.

## 0.2.0

- `build` cache keyed on the document's source signature.
- `locate` falls back to the PDF text layer when SyncTeX names the page a float
  was built on.

## 0.1.0

- First release: compile, render, locate, diff.
