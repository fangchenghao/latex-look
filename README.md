# latex-look — teach an agent to *see* your LaTeX

Compile a `.tex`, render the page as an image, map any spot on that page back to the exact source line, and diff what your last edit changed — all through **one tool**.

An agent that only reads `.tex` source is blind: the document can compile with zero errors and still look wrong. `latex-look` closes the loop.

```
        ┌─────────────┐   latex_look   ┌──────────────┐
        │   agent     │ ─────────────► │  pdf → png   │
        │  (edits .tex)│               │  synctex     │
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

Requires Node ≥ 18, a TeX engine (`xelatex`/`lualatex`/`pdflatex`/`latexmk`), `synctex`, and `ghostscript`.

```bash
git clone <this repo> && cd latex-look
chmod +x bin/*.mjs
```

### As an MCP server (Claude Code, Cursor, DSH, any MCP client)

```json
{
  "mcpServers": {
    "latex-look": {
      "command": "node",
      "args": ["/absolute/path/to/latex-look/bin/mcp.mjs"]
    }
  }
}
```

The server exposes exactly one tool, `latex_look`.

### As a CLI

```bash
node bin/latex-look.mjs book.tex --page 37
node bin/latex-look.mjs book.tex --text "表3.1"
node bin/latex-look.mjs book.tex --page 12 --compare previous --json
```

## The tool

```jsonc
latex_look({
  "file": "book.tex",                  // main .tex
  "page": 37,                          // optional, defaults to 1
  "text": "表3.1",                     // optional: locate this string, show its page
  "point": { "x": 240, "y": 610 },     // optional: PDF points → source line
  "compare": "previous",               // optional: diff against the pre-compile PDF
  "dpi": 200,                          // optional
  "engine": "xelatex",                 // optional
  "maxPasses": 3,                      // optional
  "timeoutSeconds": 300                // optional
})
```

Returns:

- compile status, pass count, page count, and structured `problems` — each with `file`, `line`, `message`
- `warnings`: LaTeX/Package/Class warnings plus **Overfull/Underfull** boxes, the usual cause of an ugly page
- `toc`: whether the document declares `\tableofcontents` and how many entries it actually produced (an empty TOC is reported as a problem, not a success)
- PNG path(s) for the rendered page — hand these to an image reader
- `located`: `{ file, line, page }` for the text anchor or point you asked about
- `diff`: `changedRatio` plus the bounding box of the change **in PDF points**, ready to feed back into `point`

## How the locating works

`latex_look` compiles with `-synctex=1`, so every glyph carries a link to its source line. Then:

- **point → source**: `synctex edit -o page:x:y:file.pdf`
- **text → source**: search the `.tex` sources for the string, then `synctex view` each hit to get its page and coordinates
- **diff bbox → source**: pass the bbox centre as `point`

Coordinates are PDF points (72/inch) with the origin at the **top-left** of the page.

## Honest limits

- SyncTeX resolves to the *nearest text position*. A decorative rule drawn by a page style (`\pagestyle{headings}`, `fancyhdr`) has no glyph of its own, so it resolves to nearby text. Combine the coordinates with LaTeX knowledge — that is what `SKILL.md` is for.
- Multi-pass convergence is checked by hashing `.aux`/`.toc`/`.out`/… — a document with `\tableofcontents` needs ≥ 2 passes, and `latex_look` reports a problem if the TOC comes out empty.
- Cross-engine pixel parity is impossible: TeX vs Word, or two different TeX engines, have different line-breaking engines. This tool verifies *your* engine's output, not another format's.

## License

MIT
