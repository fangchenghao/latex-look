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

# Changelog

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
