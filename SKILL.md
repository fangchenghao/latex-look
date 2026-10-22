---
name: latex-look
description: Use when a LaTeX document compiles but does not LOOK right and the user describes the problem visually (a table's style, a rule to remove, spacing, an overflowing line, a figure's size, page furniture). Also use before claiming any layout edit is done. Drives the `latex_look` tool in a look → diagnose → edit → look-again loop.
---

# Editing LaTeX by sight

The user often cannot read LaTeX. They see the PDF and say things like
"把这个表格改成三线表" or "把这一页最上面的横线去掉". Your job is to translate a
**visual complaint** into a **minimal source edit**, then *prove* it with your eyes.

A clean compile is not evidence. `latex_look` is.

## The loop — non-negotiable

1. **Look first.** Call `latex_look` on the page the user is talking about and
   open the returned image. Do not guess the cause from source alone.
2. **Locate.** If the user named a thing, pass `text:` to get its source line.
   If they described a place, read the coordinates off the image and pass
   `point:`. Open that file at that line — that is where the truth is.
3. **Diagnose the construct, not the pixels.** Ask *what LaTeX thing draws this?*
   A rule at the top of the page is almost never a `\rule`; it is a page style.
   See the playbook below.
4. **Edit minimally.** Smallest change that moves the rendering in the wanted
   direction. Prefer a preamble setting over rewriting content.
5. **Look again — always** with `compare: "previous"`.
6. **Read the diff.** `changedRatio` tells you whether your edit did anything:
   - `0` → the edit had no effect. Wrong file, shadowed by a later setting, or
     the construct is not what you thought. Go back to step 3.
   - `> 0.02` on a page where you touched one element → reflow. Expected, but
     look at the whole page, not just your element.
   - surprisingly huge → you broke something. Inspect before reporting.
7. **Report with evidence.** Say what changed and where (`bbox`), and give the
   user the after-image path. Never say "done" without having looked.

**Preamble edits affect every page.** After changing page furniture, typography,
or spacing, also look at one more page before claiming success.

## Playbook: symptom → cause → fix

### Page furniture
| What the user sees | Where it comes from | Fix |
|---|---|---|
| Rule under the header | `\pagestyle{headings}` or `fancyhdr`'s `\headrulewidth` | `\usepackage{fancyhdr}\pagestyle{fancy}\renewcommand{\headrulewidth}{0pt}` |
| Rule above the footer | `fancyhdr`'s `\footrulewidth` | `\renewcommand{\footrulewidth}{0pt}` |
| Header/footer should vanish | page style | `\pagestyle{plain}` or `\thispagestyle{empty}` |
| Page number in the wrong place | page style | `\fancyfoot[C]{\thepage}` etc. |
| Section titles too big / too close | `titlesec` | `\titlespacing*{\section}{0pt}{2ex}{1ex}`, `\titleformat` |
| Margins wrong | `geometry` | `\usepackage[margin=2.5cm]{geometry}` |
| Blank pages in a book class | `\cleardoublepage`, `openright` | `\documentclass[openany]{book}` |

### Tables
| Symptom | Fix |
|---|---|
| Wants a **three-line table** (三线表) | `\usepackage{booktabs}`; replace `\hline` with `\toprule`/`\midrule`/`\bottomrule`; delete all `|` from the column spec |
| Rows too tall / too cramped | `\renewcommand{\arraystretch}{1.3}` |
| Table wider than the page | `\usepackage{tabularx}` with `X` columns, or `\resizebox{\textwidth}{!}{...}`, or `\adjustbox{max width=\textwidth}` |
| Text too big inside the table | wrap in `{\small ...}` or `\footnotesize` before `\begin{tabular}` |
| Cell text must wrap | `p{3cm}` column spec, or `\usepackage{makecell}` + `\makecell{...}` |
| Table splits badly across pages | `\usepackage{longtable}` with `\endhead`, or `\usepackage{placeins}` + `\FloatBarrier` |
| Table floats somewhere unexpected | `[htbp]`, then `\FloatBarrier` before the next section |
| Caption above/below wrong | `\caption` before/after the `tabular` |

### Figures
| Symptom | Fix |
|---|---|
| Too big / too small | `\includegraphics[width=0.8\textwidth]{...}` (prefer this over `scale=`) |
| Overflows the margin | `width=\linewidth`, or `\adjustbox{max width=\linewidth}` |
| Jumped to another page | `[htbp]` + `\FloatBarrier`; or `\usepackage{float}` + `[H]` |
| Too much space around it | `\setlength{\intextsep}{6pt}`, `\setlength{\textfloatsep}{10pt}` |

### Spacing & typography
| Symptom | Fix |
|---|---|
| Paragraph gap | `\usepackage{parskip}` or `\setlength{\parskip}{0.5em}` |
| Line spacing | `\usepackage{setspace}\onehalfspacing` |
| List too loose/tight | `\usepackage{enumitem}` + `\setlist{nosep}` or `itemsep=2pt` |
| Text runs into the margin (**Overfull \hbox**) | find it with `\overfullrule=5pt`; then `\usepackage{microtype}`, allow breaks with `\-` / `\allowbreak`, or add `\sloppy` locally |
| Ragged bottom looks uneven | `\raggedbottom` |
| Long URL overflows | `\usepackage{xurl}` |
| Chinese line breaking is bad | `\XeTeXlinebreaklocale "zh"`, `\XeTeXlinebreakskip=0pt plus 1pt` |

### Structure
| Symptom | Fix |
|---|---|
| TOC empty | not enough passes — `latex_look` already runs up to 3; check for `\tableofcontents*` or unnumbered sections |
| TOC too deep/shallow | `\setcounter{tocdepth}{2}` |
| Sections not numbered | `\setcounter{secnumdepth}{3}` |
| Missing glyph (□ / warnings) | the font lacks the character — add a fallback: `\setCJKfallbackfamilyfont{\CJKrmdefault}{...}` |

## Locating: what works and what does not

`latex_look` maps PDF coordinates back to a source line with SyncTeX. That gets
you *near*. Two cases where it needs your judgement:

- **Decorative rules** have no glyph, so they resolve to the nearest text. If a
  `point:` lands on a heading but you are chasing a rule, the rule comes from
  the page style — check the preamble, not the body.
- **Macros and includes**: the line you get may be the macro *invocation*, while
  the real definition lives in a `.sty` or a `\newcommand` in the preamble.
  Search for the macro name.

## Reporting

Give the user:
1. the after image (path or attachment),
2. one sentence on **what you changed in LaTeX terms** (they will learn from it),
3. the `bbox`/`changedRatio` as evidence the page really moved,
4. if the fix touched the preamble, note that it applies to the whole document.

If you could not make it right, say so and show what you tried. A wrong "done"
is much worse than an honest "this construct is not what I expected".
