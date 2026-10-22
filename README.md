# latex-look — teach an agent to *see* your LaTeX

A **DeepSeek Harness plugin** that adds exactly one tool: `latex_look`.

An agent that only reads `.tex` source is blind: a document can compile with zero errors and still look wrong. `latex_look` compiles the document, renders the page as an image, maps any spot on that page back to the exact source line, and diffs what your last edit changed — in a single call.

```
        ┌─────────────┐   latex_look   ┌──────────────┐
        │   agent     │ ─────────────► │  pdf → png   │
        │ (edits .tex)│                │  synctex     │
        └─────────────┘ ◄───────────── │  pixel diff  │
              ▲          image + line  └──────────────┘
              └─────────────── verification ───────────┘
```

## Why one tool, not three

Rendering, locating, and diffing are the *implementation*. The agent needs one coherent verb — **"look at this page"** — the same way a person does. `latex_look` compiles, renders, resolves, and diffs in a single call, so the loop is:

```
look → diagnose → edit .tex → look again → confirm the change → report
```

## Install

Requires Node ≥ 18, a TeX engine (`xelatex`/`lualatex`/`pdflatex`/`latexmk` or tectonic), `synctex`, and `ghostscript`.

This repository **is** the bundle: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts one row.

```bash
git clone https://github.com/fangchenghao/latex-look
```

Then install it into the current profile (in the Harness, via the plugin manager):

```
plugin_manager  action: install_bundle  target: /absolute/path/to/latex-look
```

That adds the row `latex-look` and registers the `latex_look` tool. Replacing the sources of an already-installed package needs a Harness restart to load a fresh module generation.

### Optional: the knowledge skill

The tool gives the agent eyes. [`SKILL.md`](SKILL.md) gives it the LaTeX knowledge to act on what it sees — a symptom → cause → fix playbook (a rule you want gone is usually `\pagestyle`/`fancyhdr`, not a stray `\hline`). Copy or symlink it into the skills root:

```bash
mkdir -p ~/.dsh/skills/latex-look
ln -sf "$PWD/SKILL.md" ~/.dsh/skills/latex-look/SKILL.md
```

### CLI, for humans and for testing

```bash
node bin/latex-look.mjs book.tex --page 37
node bin/latex-look.mjs book.tex --text "表3.1"
node bin/latex-look.mjs book.tex --page 12 --compare previous --json
```

The CLI runs the same engine as the plugin and needs no Harness, which makes it the fast way to check a change without reloading anything.

## Tests

Both suites run on a clean checkout — they create their own fixtures and compile
real documents, so expect a few minutes:

```bash
node test/smoke.mjs      # unit level: problem parsing, PPM, raster diff, aux detection
node test/scenarios.mjs  # 52 end-to-end cases driven through index.js
```

The scenario suite stubs only `@deepseek-ai/dsh-tools` (it exists solely inside
the Harness) and calls the real `execute` with real arguments, so it exercises the
argument handling and the exact text the model reads — not just `lib/core.mjs`.
That matters: several bugs found this way lived only in the formatting layer.

## The tool

```jsonc
latex_look({
  "file": "book.tex",       // main .tex (required)
  "page": 37,               // optional, defaults to 1
  "text": "表3.1",          // optional: locate this string, show its page
  "pointX": 240,            // optional, with pointY: PDF points → source line
  "pointY": 610,
  "compare": "previous.pdf",// optional: diff against an earlier PDF
  "dpi": 200,               // optional, 50-300
  "engine": "xelatex",      // optional
  "maxPasses": 3,           // optional
  "timeoutSeconds": 300     // optional
})
```

Returns:

- compile status, pass count, page count, and structured `problems` — each with `file`, `line`, `message`
- `warnings`: LaTeX/Package/Class warnings plus **Overfull/Underfull** boxes, the usual cause of an ugly page
- `toc`: whether the document declares `\tableofcontents` and how many entries it actually produced (an empty TOC is reported as a problem, not a success). The declaration is found across `\input`/`\include`, so a one-line root that wraps `\input{main}` still works
- `aux`: external tools it ran — `makeglossaries`, `makeindex`, `biber`, `bibtex` — chosen from the artifacts the first pass produced, not from the root file's text, so multi-file projects that keep `\makeglossaries` in an included preamble are handled too
- PNG path(s) for the rendered page — hand these to an image reader
- `located`: `{ file, line, page }` for the text anchor or point you asked about
- `diff`: `changedRatio` plus the bounding box of the change **in PDF points**, ready to feed back into `pointX`/`pointY`

## How the locating works

`latex_look` compiles with `-synctex=1`, so every glyph carries a link to its source line. Then:

- **point → source**: `synctex edit -o page:x:y:file.pdf`
- **text → source**: search the `.tex` sources for the string, then `synctex view` each hit to get its page and coordinates
- **diff bbox → source**: pass the bbox centre as `pointX`/`pointY`

Coordinates are PDF points (72/inch) with the origin at the **top-left** of the page.

## Honest limits

- SyncTeX resolves to the *nearest text position*. A decorative rule drawn by a page style (`\pagestyle{headings}`, `fancyhdr`) has no glyph of its own, so it resolves to nearby text. Combine the coordinates with LaTeX knowledge — that is what `SKILL.md` is for.
- Multi-pass convergence is checked by hashing `.aux`/`.toc`/`.out`/… — a document with `\tableofcontents` needs ≥ 2 passes, and `latex_look` reports a problem if the TOC comes out empty.
- Multi-file detection follows `\input`/`\include` three levels deep. `\import`/`\subfile`, unusual custom `.latexmkrc` recipes, and `\includeonly` are not understood.
- Cross-engine pixel parity is impossible: TeX vs Word, or two different TeX engines, have different line-breaking engines. This tool verifies *your* engine's output, not another format's.
- A `%` in a *file name* defeats the TeX engine itself (`! Emergency stop.`), so no tool can help there. A `%` in a directory name is fine.
- If the compile fails without writing a new PDF, the stale PDF on disk is **not** rendered and no diff is reported — the tool says so instead. Otherwise an unchanged file would read as "0% changed", i.e. "your edit did nothing".
- `engine` accepts only the engines in this tool's list (`auto` or a known name); it is never passed to `spawn` unchecked.
- Rendered PNGs stay under `TMPDIR/latex-look-<pid>/` because the agent opens them after the call returns. Nothing prunes that directory.

## License

MIT
