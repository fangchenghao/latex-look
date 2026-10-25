# Case study: a 215-page LaTeX book, read the way a reader reads it

This is the document the tool was built against, and the only test that matters:
**《神经网络与深度学习》中文版** (Michael Nielsen's *Neural Networks and Deep
Learning*, Chinese translation) — 215 pages, 6 chapters, 3 appendices, 163 figures,
129 numbered equations, a 63-entry table of contents, a glossary built with
`glossaries`, and a great deal of mathematics.

The document compiled with **zero errors** long before the work in this file
started. Every defect below was invisible to the compiler and visible to a reader.

## Why the test was run this way

Two fixed roles, one file:

- A **reader** who can only see the PDF. It gets page numbers, measures pixels,
  and writes findings as sentences: *"印 52 最上面是图 3-1，章名被压到页面四分之一
  处"*. It never sees `.tex`, never accepts "it looks fine to me", and does not
  accept a fix it cannot verify on a re-rendered page.
- An **editor** who may only change the source, and must prove each change on the
  rendered page before reporting it.

That split is what makes the numbers below meaningful: they are measurements taken
by something that does not know what the source *intends*.

## What was actually wrong

| Symptom, as a reader said it | What it was | Pages |
|---|---|---|
| "the table of contents has lines sticking out past the margin" | `book.cls` sets `\@pnumwidth` to `1.55em`, too narrow for bold three-digit page numbers | all 63 TOC entries |
| "the equation numbers are wrong, they say `(5)` instead of `(1-1)`" | 129 equations carried a hard-coded `\tag{N}`, which ignores any `\theequation` redefinition | 129 equations, 6 chapters |
| "the chapter header says 第0章 on page viii" | the front matter sets `\chapter*`, but `\chaptermark` still ran | 1 page |
| "there is a gap at the bottom, the text stopped early" | figures did not fit, so they moved to the next page and took the space with them | 9 pages, up to 170 mm |
| "the figure numbers run backwards: 图 3-4 on p63, then 图 3-3 on p64" | converting an inline figure to a float makes LaTeX place it *after* the inline figures that follow it in the source | 3 runs |
| "page 52 (a chapter opening) starts with a picture, the chapter title is a quarter down the page" | a float was allowed at the top of a chapter's first page | 1 page |

## What the tool caught that a careful person missed

**The floating–numbering interaction.** Making a figure a float to kill a page hole
is obviously right, and it silently inverted figure numbers across a chapter,
because LaTeX orders floats of the same class by source position among *floats*,
not among inline figures. On a per-page diff, every page was fine. Only a
reading-order pass over the whole document showed it:

```
图 3-4 on p63, then 图 3-3 on p64
```

`sequence` finds this; the fix is to float the entire numbered run, not one member
of it.

**Page furniture poisoning a whole-book measurement.** The first version of
`audit` reported that all 215 pages ended 40 pt too early. The cause was that the
running head, the head rule, and the page number are the *deepest ink* on a page
in some pages and the *highest* in others; taking a percentile over the whole book
made page numbers the reference. The fix is to detect furniture first — a row that
recurs on a large share of pages within the outer 8 % band — and mask the whole
band, not the individual rows.

**A baseline that outlived its document.** Comparing against "the previous audit"
is useless the moment the document repaginates: every finding moves, and everything
reports as new. The audit matches findings by the **text at the break**, so a hole
is still recognisably the same hole after the page numbers shift.

## Final state

Verified on the rendered PDF, not on the source:

| Measurement | Result |
|---|---|
| Compile errors | 0 |
| Pages | 215 (front matter i–ix, body 1–205) |
| Overfull `\hbox` | 0 |
| Numbered figures | 163 — contiguous 1..N in every chapter |
| Figures out of reading order | 0 |
| Numbered equations | 129 — `(1-1)` … `(6-1)`, contiguous per chapter |
| Pages with >60 mm of unexplained white space | 19, all of them chapter ends or front matter |
| The nine named holes | all ≤ 56 mm |
| Chapter opening pages | all six start at exactly 17.0 % of page height |
| Running heads | 197 of 215 pages (the rest are pages where a head is wrong) |

## What this case proves — and what it does not

It proves that an agent can be held to a *visual* acceptance bar on a document it
cannot see as a whole, and that the failures above are the kind that survive
compile-and-forget workflows.

It does not prove the tool knows what your document should look like. Every fix
came from a sentence a person wrote. The tool's job is to make "look at it and
tell me whether it is right" cheap enough that a person can afford to say it ten
times in a row.
