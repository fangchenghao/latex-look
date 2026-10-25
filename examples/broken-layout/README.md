# The demo: a page that compiles and still looks wrong

Two files, one page each, the same content:

- [`broken.tex`](broken.tex) — compiles with **zero errors**, opens fine, and is wrong in five ways a reader can see instantly.
- [`fixed.tex`](fixed.tex) — the same page after five sentences.

```bash
npm install -g dsh-latex-look      # or use the plugin inside the Harness
latex-look broken.tex --page 1     # renders page 1 to a PNG
latex-look fixed.tex  --page 1
```

| # | A reader says | The cause | The fix in `fixed.tex` |
|---|---|---|---|
| 1 | "there is a rule above the title, delete it" | `\pagestyle{fancy}` without clearing the header: the default head rule is still drawn | `\fancyhf{}` + `\renewcommand{\headrulewidth}{0pt}` |
| 2 | "the rules around the title are too close to the text" | a hand-drawn `\rule{\linewidth}{0.4pt}` in a `center` block with `\\[2pt]` | delete it — the title needs no rules |
| 3 | "this table looks like a spreadsheet, make it a real table" | `{|c|c|c|c|}` with a `\hline` after every row | `booktabs`: `\toprule \midrule \bottomrule`, no vertical rules |
| 4 | "the link runs off the right edge of the page" | an unbreakable 100-character URL in a justified paragraph | `\usepackage{xurl}` so the URL may break anywhere |
| 5 | "the figure is too wide, it touches both margins" | `\parbox{0.95\linewidth}` | `0.72\linewidth` |

Only defect 4 is visible to `grep`: LaTeX reports it as

```
Overfull \hbox (184.5095pt too wide) in paragraph at lines 32--33
```

The other four compile silently. That is the whole argument for the tool — the
same reason a spell-checker cannot tell you your table has too many rules.

## Why defect 1 is the interesting one

"Delete the line at the top of the page" is the request that proves the point:
there is no line in the source. Nothing in `broken.tex` says `ule` at that
height — the hairline above the title is drawn by `fancyhdr` because
`\pagestyle{fancy}` was set and the header was never cleared. Grep finds nothing,
reading the file finds nothing, and a model that never sees the page has no way to
know the request was about `\headrulewidth` at all.

## After the fix

`fixed.tex` compiles with **no Overfull hbox at all**, and the two pages differ by
exactly the five changes above — which is what `--compare` shows:

```bash
latex-look fixed.tex --page 1 --compare   # side by side with the previous PDF
```
