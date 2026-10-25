# Changelog

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
