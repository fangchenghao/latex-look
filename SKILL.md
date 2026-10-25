---
name: latex-look
description: Use when a LaTeX document compiles but does not LOOK right and the user describes the problem visually (a table's style, a rule to remove, spacing, an overflowing line, a figure's size, page furniture). Also use before claiming any layout edit is done. Drives the `latex_look` tool in a look → diagnose → edit → look-again loop.
---

# Editing LaTeX by sight

The user often cannot read LaTeX. They see the PDF and say things like
"把这个表格改成三线表" or "把这一页最上面的横线去掉". Your job is to translate a
**visual complaint** into a **minimal source edit**, then *prove* it with your eyes.

A clean compile is not evidence. `latex_look` is.

## Page numbers are not what the page says

`page` is the **PDF page index** (1-based): page 1 is the cover, page 208 is the last
sheet. The number printed at the foot of the page is a different thing — front matter
shifts it, often by ten or more, and the offset can differ between front matter
(roman) and body (arabic).

Before you edit, if the user quoted "page 41", render the page you think they mean and
read the number printed at its foot. If it does not match, ask which they meant, or
walk the offset from one known page. Editing the wrong page and reporting a 7% diff is
worse than one extra question.

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

7c. **Check order, when the edit changed how objects are placed** (float, `[H]`,
`\FloatBarrier`, `minipage`). Numbered objects must still appear in numerical order
as the reader turns the pages; a float lands after any inline sibling that follows it
in the source. `sequence: "图"` reports every inversion with both page numbers.

7d. **A hole that survived the float is still a hole.** Floating moves the empty
space, it does not delete it: if the text after the figure is short, the page still
stops short. `audit: true` names the figure that opens the next page
(`nextPageOpensWith`), which is the one to float next.

7b. **Audit, when the edit touched more than one page.** A request like "give every
figure a caption" is fulfilled per figure and can still leave ten pages broken:
the caption adds height, the figure no longer fits, and it jumps to the next page,
leaving a hole. No single page shows that. Pass `audit: true` to `latex_look`:
it measures every page and reports only findings **that were not there in the
previous audit of the same document** — so a first run records a baseline and
every later run says exactly what this build broke. Anything it lists is yours to
fix or to tell the reader about; silence means the change did not disturb the rest
of the book.

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

### When the reader's premise is wrong

Readers describe a page relative to whatever they can see. One insisted a
figure "touches both margins"; measured, it was 311pt wide in a 455pt column,
and the thing reaching both edges was the header rule above it. Another
complained that code lines were ragged; a per-line scan of the left edge found
exactly three indentation levels, all pixel-identical.

Do not argue, and do not silently do the wrong thing either:

1. **Draw the reference on the page.** Render it, dash the text-block edges in
   red, box the element in question in green, and show that image. The
   disagreement usually dissolves in one look.
2. **Do the part that is real.** That figure did waste half its height on an
   empty y-range — cropping the axis fixed the page the reader was cross about,
   even though the sentence they wrote was wrong.
3. **Quote the numbers in the units they used** (mm at the dpi they measured at)
   and let them withdraw the wrong half themselves.

### When the build itself stops cooperating

- **A look that never returns.** A pass is killed at `timeoutSeconds` (default 120) and
  the tool now says which pass and why. The usual cause is a macro loop, not a slow
  machine: `ulem`'s `\uline` wrapped around an `\href` **inside any tabular** hangs the
  engine forever (tested with `tabular`, `tabularx` and `multirow`). If the user asks to
  underline all links, say what it costs instead of silently rewriting 181 call sites.
- **"It compiles but the page is unchanged".** Check that the file you edited is within
  three `\input` levels of the root, and that the edit is not shadowed by a duplicate
  definition later in the preamble.

### Traps that make an edit look like it did nothing

- **Numbers that are typed, not counted.** If a document writes `\tag{12}` or
  `\setcounter{equation}{12}` by hand, no amount of `\theequation` /
  `\numberwithin` changes the printed number, and the next formula keeps the
  hand-written value too. `grep -c '\\tag{' *.tex` before touching the counter.
- **A page-size box that cannot be shrunk.** `Overfull \hbox (1.9pt)` in a table
  of contents is usually not the dot leaders: `book.cls` reserves `\@pnumwidth`
  (1.55em) for the page number, and bold three-digit numbers need more. Fix with
  `\makeatletter\renewcommand{\@pnumwidth}{2.3em}\makeatother`, not by
  shortening the leaders.
- **A package that lists itself.** `tocbibind` puts the table of contents into the
  table of contents. `\usepackage[nottoc]{tocbibind}` keeps the index and the
  glossary entries but drops that one line.

- **"nothing changed since the last build" after you replaced a figure.** `\graphicspath`
  used to be ignored when collecting build dependencies, so a figure that lives in
  `images/` was not part of the cache signature. A regenerated `.pdf`/`.png` now
  invalidates the build; if you ever see the message again right after touching an
  image, check that the `\includegraphics` target is reachable from the `\graphicspath`
  entry rather than from the .tex directory.

The tool will honestly report "nothing changed on this page" — before you conclude the
document is broken, suspect one of these:

- **Leading space in a right-aligned header/footer field.** `\fancyfoot[RO]{\hspace{2em}\thepage}`
  does not move the number: the field's box is flush right and grows to the left, so the
  glyphs stay put. To actually shift it, change the content (`{第\thepage 页}`), the
  alignment (`[C]`), or add a rule/box.
- **`fancyhdr` ignores `E`/`O` parts under `oneside`** (`[LE]`, `[RO]` in a one-sided
  document: the `E` half warns and is dropped). Setting `\leftmark` there changes nothing.
- **A mark, not a value.** `\chapter` *clears* `\rightmark` in `book`/`report`, so pages
  between a chapter opening and its first `\section` show an empty header with the rule
  still drawn — define what `\chaptermark` should put in the right mark.
- **A spacing command already in force.** `\onehalfspacing` followed by `\onehalfspacing`
  is a no-op; check `main.tex` for the length before "increasing" it.

### Tables
| Symptom | Fix |
|---|---|
| Wants a **three-line table** (三线表) | `\usepackage{booktabs}`; replace `\hline` with `\toprule`/`\midrule`/`\bottomrule`; delete all `|` from the column spec |
| Already numerically correct, but a rule between **every** row ("like ruled paper") | Delete the per-row `\midrule`s and put `\addlinespace` in their place — removing the rule alone leaves the rows touching |
| A list of names/dates stranded on one line with ragged gaps | Give every entry the same slot: `\begin{tabular}{@{}l@{}l@{}}` with `\makebox[3.1cm][c]{…}` in each cell, wrapped over 2–3 rows. Fixed `p{}` columns with left alignment leave the *gaps* ragged, which is the thing the user complained about |
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
| Adding a caption pushed a near-full-page figure off the page, leaving half a page blank | the figure was already as tall as the text block, so a few millimetres of caption cannot fit above it. Wrapping it in `minipage` makes it unbreakable. Make that figure a float (`\begin{figure}[!tbp]`) so the text after it fills the page and the figure starts the next one |
| Caption orphaned on the next page | wrap figure+caption in one `minipage` — a caption is not tied to its graphic by default |
| "Delete the line at the top of the page", and the point lookup reports `no rule-drawing command on line N or any of the 4 lines around it` | the rule comes from the page style. It is `\pagestyle{fancy}` / `\pagestyle{headings}` with the head rule still on, or a `\rule`/`\hrule` in a `\markboth`-style macro. Fix it with `\fancyhf{}` plus `\renewcommand{\headrulewidth}{0pt}`, or switch to `\pagestyle{plain}`. Do **not** edit the line the lookup named (`\end{document}`); it is only the nearest box. When the rule *is* typed in the body, the lookup names it instead: `drawn by line 15: \rule{\linewidth}{0.4pt}`, and that is the line to change |
| A figure sits above the chapter title on a chapter's first page | a top float won the opening page. `\let\origchapter\chapter\renewcommand{\chapter}{\suppressfloats[t]\origchapter}` (no `@` in the name, or wrap it in `\makeatletter`) forbids top floats on every chapter opening, now and for chapters added later |
| Numbers run backwards: 图 3-4 on one page, 图 3-3 on the next | you floated one object but left its numbered neighbours inline. A float is placed later than an inline object that follows it in the source, and the reader turns the page to see 3-4 before 3-3. Floats of the same class keep their relative order, so float the **whole run** — never a float mixed into inline siblings. Check with `latex_look --sequence 图` after any change to how objects are placed |
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

The person reading your reply often cannot read LaTeX and is not going to open two
PNGs and hunt for the difference. Give them, in this order:

1. **The before/after image** — a `compare` call writes `images.sideBySide`, one PNG
   with the old page on the left and the new one on the right. Show that first.
2. **One plain sentence** on what changed and **which pages** it affected, in their
   words: "the rule above the title is gone on every chapter-opening page".
3. **A sentence that the rest of the document still holds** ("page count unchanged,
   nothing else moved") — silence there reads as "they did not check".
4. The `bbox` / `changedRatio` only when they ask for evidence, or when the change is
   too subtle to see. A reply led by "0.004% of the page, 18 px, bbox y=791" answers
   a question nobody asked.

If the user's description does not match what you see (they say "the last figure is
centred" when it is left-aligned), do not just contradict them: they are describing
what their eye sees. Show an image that makes the alignment visible — a crop, a
composite with guides — and explain the *effect* they are reacting to (an empty
right-hand column reads as "centred" even when the edges line up).

If you could not make it right, say so and show what you tried. A wrong "done" is
much worse than an honest "this construct is not what I expected".
