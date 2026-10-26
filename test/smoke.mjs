/**
 * Smoke test: exercises compile → render → locate → diff on a throwaway document.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { look, locateText, pageCarryingText } from '../lib/core.mjs'
import { compareVersions, parseVersion } from '../lib/update.mjs'
import { classifyInk, textLayerHealth } from '../lib/core.mjs'

const dir = await mkdtemp(join(tmpdir(), 'latex-look-test-'))
const tex = join(dir, 'demo.tex')

const BASE = String.raw`\documentclass[UTF8]{ctexart}
\usepackage{booktabs}
\begin{document}
\section{测试小节}
这是一个用来定位的段落。

\begin{table}[h]
\centering
\begin{tabular}{ll}
\toprule
名称 & 数值 \\
\midrule
甲 & 1 \\
乙 & 2 \\
\bottomrule
\end{tabular}
\caption{测试表格}
\end{table}
\end{document}
`

let failures = 0
// Await the body. A synchronous `check` returned as soon as an async test body hit its
// first await, so the test ran on in the background, raced the temp-directory cleanup,
// and printed "ok" without a single assertion having executed.
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`) } catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
}

try {
  // ---- 1. compile + render + no problems -----------------------------------
  await writeFile(tex, BASE)
  const first = await look(tex, { page: 1, compare: null })
  check('compiles cleanly', () => assert.equal(first.ok, true, JSON.stringify(first.problems)))
  check('produces a page', () => assert.equal(first.pages, 1))
  check('renders a PNG', async () => {
    const s = await stat(first.images.after)
    assert.ok(s.size > 3000, `png too small: ${s.size}`)
  })
  check('is a valid PDF', async () => {
    const buf = await readFile(first.pdf)
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.ok(buf.subarray(-2048).toString('latin1').includes('%%EOF'))
  })

  // ---- 2. text anchor → source line ---------------------------------------
  const { hits } = await locateText(tex, first.pdf, '测试表格')
  const srcLines = (await readFile(tex, 'utf8')).split(/\r?\n/)
  check('locates a text anchor', () => {
    assert.ok(hits.length >= 1, 'no hits')
    const line = srcLines[hits[0].line - 1] || ''
    assert.ok(line.includes('测试表格'), `line ${hits[0].line} does not contain the anchor: ${line}`)
  })

  // ---- 2b. which page does the text really live on? -----------------------
  const two = join(dir, 'two.tex')
  await writeFile(two, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
第一页的普通文字。

\clearpage
第二页的普通文字。
\end{document}
`)
  const built = await look(two, { page: 1, compare: null })
  const where = await pageCarryingText(built.pdf, 1, '第二页的普通文字')
  // Ghostscript's txtwrite recovers text only from fonts carrying a ToUnicode map.
  // The macOS system CJK fonts do; a Linux box without Noto CJK, and the vendored
  // fandol set, do not — there is then no text to search. The honest assertion in
  // that environment is that the guess is left alone rather than moved on the
  // strength of a layer that was never read.
  const layerReadable = where.verified === true && where.page === 2
  check('text layer overrules a wrong page guess', () => {
    if (!layerReadable) {
      assert.equal(where.page, 1, `a guess moved to page ${where.page} without a readable text layer`)
      assert.equal(where.verified, false)
      return
    }
    assert.equal(where.page, 2, `got page ${where.page}`)
    assert.equal(where.verified, true)
  })
  const miss = await pageCarryingText(built.pdf, 1, '这一段根本不存在')
  check('keeps the guess when the string is not in the page', () => {
    assert.equal(miss.page, 1)
    assert.equal(miss.verified, false)
  })

  // ---- 2f. a replaced figure invalidates the build ------------------------
  // \graphicspath{{figs/}} was invisible to the cache: the signature only looked for
  // files next to the .tex, so swapping the picture rebuilt nothing and the reader was
  // told "nothing changed" about a page whose figure had just been replaced.
  const figDir = join(dir, 'figs')
  await mkdir(figDir, { recursive: true })
  const figPdf = join(figDir, 'blob.pdf')
  const drawPdf = (color) =>
    execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-sOutputFile=${figPdf}`,
      '-c', `<< /PageSize [120 120] >> setpagedevice ${color} 12 12 moveto 108 108 lineto 4 setlinewidth stroke showpage`,
    ])
  await drawPdf('1 0 0 setrgbcolor')
  const figTex = join(dir, 'figdoc.tex')
  await writeFile(figTex, String.raw`\documentclass{article}
\usepackage{graphicx}
\graphicspath{ {figs/} }
\begin{document}
图在这里：
\begin{center}\includegraphics{blob}\end{center}
\end{document}
`)
  const v1 = await look(figTex, { page: 1 })
  await drawPdf('0 0 0 setrgbcolor')
  const v2 = await look(figTex, { page: 1, compare: 'previous' })
  check('a replaced figure rebuilds the page instead of reusing the cache', () => {
    assert.equal(v1.ok, true)
    assert.equal(v2.ok, true)
    assert.ok(!v2.cached, 'the second look reused a cache built from the old figure')
    assert.ok(v2.diff && v2.diff.changedPixels > 0, `diff: ${JSON.stringify(v2.diff)}`)
  })

  // ---- 2e. a pass that never finishes says why ---------------------------
  // ulem's \uline around a link inside any tabular loops the engine forever. Reported
  // as "produced no PDF", the user learns nothing and the assistant retries blindly.
  const loopTex = join(dir, 'loop.tex')
  await writeFile(loopTex, String.raw`\documentclass{article}
\usepackage{hyperref}
\usepackage{tabularx}
\usepackage[normalem]{ulem}
\let\nndlhref\href
\DeclareRobustCommand{\href}[2]{\nndlhref{#1}{\uline{#2}}}
\begin{document}
\begin{tabularx}{0.8\textwidth}{lX}
\href{https://example.com/1}{一个链接} & 说明 \\
\end{tabularx}
\end{document}
`)
  const hung = await look(loopTex, { page: 1, compare: null, timeoutSeconds: 6 })
  check('a compile that never finishes names the loop, not "no PDF"', () => {
    assert.equal(hung.ok, false)
    const first = (hung.problems[0] || {}).message || ''
    assert.match(first, /did not finish within/)
    assert.match(first, /infinite loop/i)
  })

  // ---- 2c. the comparison baseline follows the latest build ---------------
  // A plain look (no compare) must still publish its snapshot; otherwise the next
  // comparison spans the last two edits and reports a change twice as big.
  const three = join(dir, 'three.tex')
  const withRule = (pt) =>
    String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
一行文字。

\noindent\rule{\textwidth}{` + pt + String.raw`pt}
\end{document}
`
  await writeFile(three, withRule(3))
  await look(three, { page: 1, compare: null })
  await writeFile(three, withRule(5))
  const stepA = await look(three, { page: 1, compare: 'previous' })
  await writeFile(three, withRule(7))
  await look(three, { page: 1, compare: null })
  const stepB = await look(three, { page: 1, compare: 'previous' })
  check('the baseline follows the last build, one edit at a time', () => {
    const a = stepA.diff && stepA.diff.changedPixels
    const b = stepB.diff && stepB.diff.changedPixels
    assert.ok(a > 100 && b > 100, `a=${a} b=${b}`)
    assert.ok(Math.abs(a - b) / Math.max(a, b) < 0.35, `one step=${a}px, next step=${b}px: the second diff spans more than one edit`)
  })

  // ---- 3. diff detects a real edit ----------------------------------------
  const edited = BASE.replace(
    String.raw`\usepackage{booktabs}`,
    String.raw`\usepackage{booktabs}` + '\n' + String.raw`\pagestyle{plain}`,
  )
  assert.notEqual(edited, BASE)
  await writeFile(tex, edited)
  const second = await look(tex, { page: 1, compare: 'previous' })
  check('diff sees the change', () => {
    assert.ok(second.diff, 'no diff produced')
    assert.ok(second.diff.changedRatio > 0, 'change not detected')
    assert.ok(second.diff.bbox, 'no bbox')
  })
  check('diff bbox is in the header area', () => {
    assert.ok(second.diff.bbox.y < 200, `bbox y=${second.diff.bbox.y} not in header`)
  })

  // ---- 4. a cached re-look repeats the SAME before/after -------------------
  // The before-snapshot belongs to the build, not to one call: an agent that just
  // edited something inspects several pages of it, and every look after the first
  // is served from the cache.
  const third = await look(tex, { page: 1, compare: 'previous' })
  check('a cached re-look reports the same diff, not zero', () => {
    assert.equal(third.cached, true, 'expected the build to be reused')
    assert.equal(third.diff?.changedRatio, second.diff?.changedRatio)
    assert.ok(third.diff.changedRatio > 0)
  })

  // ---- 5. an empty table of contents is caught -----------------------------
  const tocDir = await mkdtemp(join(tmpdir(), 'latex-look-toc-'))
  const tocTex = join(tocDir, 'toc.tex')
  await writeFile(tocTex, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\tableofcontents
\section*{星号小节不编号}
没有编号小节，目录必然是空的。
\end{document}
`)
  const tocRun = await look(tocTex, { page: 1, compare: null })
  check('flags an empty table of contents', () => {
    assert.equal(tocRun.ok, false, 'a blank TOC must not be reported as OK')
    assert.ok(
      tocRun.problems.some((p) => /table of contents is EMPTY/i.test(p.message)),
      JSON.stringify(tocRun.problems),
    )
  })
  await rm(tocDir, { recursive: true, force: true })

  // ---- 6. Overfull boxes are surfaced as warnings -------------------------
  const warnDir = await mkdtemp(join(tmpdir(), 'latex-look-warn-'))
  const warnTex = join(warnDir, 'warn.tex')
  await writeFile(warnTex, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\noindent\hbox to 1cm{XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX}
\end{document}
`)
  const warnRun = await look(warnTex, { page: 1, compare: null })
  check('surfaces Overfull warnings', () => {
    assert.ok(
      warnRun.warnings.some((w) => w.kind === 'overfull-hbox'),
      JSON.stringify(warnRun.warnings),
    )
  })
  await rm(warnDir, { recursive: true, force: true })

  // ---- 10. the layout audit finds a hole an edit introduced ---------------------
  // The point of the audit is not "does any page end early" — books are full of
  // chapter ends — but "did MY edit push the rest of a page down". So: build once for
  // a baseline, change the document so a page break leaves a hole, expect it flagged.
  const auditDir = join(dir, 'audit')
  await mkdir(auditDir, { recursive: true })
  const auditTex = join(auditDir, 'audit.tex')
  const filler = Array.from({ length: 40 }, (_, i) => `第${i + 1}段用来把这一页填满，这样最后一页才是真的满页。`).join('\n\n')
  const AUDIT_BASE = String.raw`\documentclass[UTF8,zihao=5]{ctexart}
\usepackage[a4paper]{geometry}
\begin{document}
${filler}

\newpage
${filler}
\end{document}
`
  await writeFile(auditTex, AUDIT_BASE)
  const auditRun1 = await look(auditTex, { page: 1, compare: null, audit: true })
  check('audit records a baseline on first run', () => {
    assert.ok(auditRun1.audit, 'no audit report')
    assert.equal(auditRun1.audit.hadBaseline, false, 'a fresh document must not claim a baseline')
    assert.equal(auditRun1.audit.newFindings.length, 0, `first run invented ${auditRun1.audit.newFindings.length} finding(s)`)
  })
  // Two \newpage in a row are collapsed by TeX and leave no hole at all, so break the
  // FIRST page in the middle instead: that pushes the rest of its text down and leaves
  // exactly the hole a reader complains about.
  const firstPara = AUDIT_BASE.split('\n\n')[2]
  const broken = AUDIT_BASE.replace(firstPara + '\n\n', firstPara + '\n\n\\newpage\n')
  await writeFile(auditTex, broken)
  const auditRun2 = await look(auditTex, { page: 1, compare: null, audit: true })
  check('audit reports the hole an edit introduced', () => {
    assert.equal(auditRun2.audit.hadBaseline, true, 'second run must compare against the baseline')
    assert.ok(auditRun2.audit.newFindings.length >= 1, 'a blank page in the middle of the text was not reported')
  })
  await rm(auditDir, { recursive: true, force: true })

  // ---- 11. reading order of numbered labels ---------------------------------
  const orderTex = join(dir, 'order.tex')
  const ORDER_GOOD = String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
图 1-1 第一条

图 1-2 第二条

图 1-3 第三条
\end{document}
`
  await writeFile(orderTex, ORDER_GOOD)
  const orderRun = await look(orderTex, { page: 1, compare: null, sequence: '图' })
  const labelsReadable = orderRun.sequence.total > 0
  check('sequence accepts an in-order document', () => {
    if (!labelsReadable) {
      // No text layer means no labels to count. Reporting "0 inversions" would be a
      // pass for a check that never ran; it has to say so instead.
      assert.ok(orderRun.sequence.unreliable, `no labels and no reason given: ${JSON.stringify(orderRun.sequence)}`)
      return
    }
    assert.equal(orderRun.sequence.total, 3, JSON.stringify(orderRun.sequence))
    assert.equal(orderRun.sequence.inversions.length, 0)
  })
  const ORDER_BAD = ORDER_GOOD.replace('图 1-1 第一条\n\n图 1-2 第二条', '图 1-2 第二条\n\n图 1-1 第一条')
  await writeFile(orderTex, ORDER_BAD)
  const orderBad = await look(orderTex, { page: 1, compare: null, sequence: '图' })
  check('sequence reports a label that goes backwards', () => {
    if (!labelsReadable) {
      assert.ok(orderBad.sequence.unreliable, `no labels and no reason given: ${JSON.stringify(orderBad.sequence)}`)
      return
    }
    assert.equal(orderBad.sequence.inversions.length, 1, JSON.stringify(orderBad.sequence))
    assert.equal(orderBad.sequence.inversions[0].before.label, '图 1-2')
  })

  // ---- 13. version ordering for the update check -----------------------------
  check('version comparison follows semver', () => {
    assert.equal(compareVersions('0.3.0', '0.2.0'), 1)
    assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
    assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
    // A prerelease sorts below the release it precedes, so an rc must not be offered
    // to users as an upgrade.
    assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1)
    assert.equal(compareVersions('0.3.0', '0.3.0-rc.1'), 1)
  })
  check('an unparseable version does not throw', () => {
    assert.deepEqual(parseVersion('not-a-version'), { major: 0, minor: 0, patch: 0, pre: '' })
    assert.equal(compareVersions('garbage', '0.0.0'), 0)
  })

  // ---- 14. what is drawn at a point ------------------------------------------
  check('ink classification tells a rule from text from blank', () => {
    const W = 100, H = 100
    const data = new Uint8Array(W * H * 3).fill(255)
    const ink = (x, y) => { const o = (y * W + x) * 3; data[o] = data[o+1] = data[o+2] = 0 }
    for (let x = 0; x < W; x++) ink(x, 20)            // a full-width rule
    for (let y = 60; y < 68; y++) for (let x = 40; x < 60; x++) ink(x, y)  // a word
    const raster = { width: W, height: H, max: 255, data }
    // dpi 72 == one pixel per point, so page coordinates are pixel coordinates.
    assert.equal(classifyInk(raster, { x: 50, y: 20, dpi: 72 }).kind, 'rule')
    assert.equal(classifyInk(raster, { x: 50, y: 64, dpi: 72 }).kind, 'text')
    assert.equal(classifyInk(raster, { x: 5, y: 90, dpi: 72 }).kind, 'blank')
    // Off the page is its own answer: a blank classification would be a lie.
    assert.equal(classifyInk(raster, { x: 500, y: 20, dpi: 72 }).kind, 'outside')
    // A reader clicking a rule is a point or two off; the probe must still find it,
    // and must report where the rule really is.
    // A table rule spans a third of the page, not all of it: a fraction-of-row test
    // called it nothing, and silence reads as "no feature here".
    const wide = new Uint8Array(W * H * 3).fill(255)
    for (let x = 20; x < 55; x++) { const o = (50 * W + x) * 3; wide[o] = wide[o + 1] = wide[o + 2] = 0 }
    const tableRule = classifyInk({ width: W, height: H, max: 255, data: wide }, { x: 30, y: 50, dpi: 72 })
    assert.equal(tableRule.kind, 'rule')
    const near = classifyInk(raster, { x: 50, y: 23, dpi: 72 })
    assert.equal(near.kind, 'rule')
    assert.equal(near.y, 20)
  })

  // A text layer full of unmapped glyphs is not an empty document: reporting
  // "0 labels, all in order" is a pass for a check that never ran.
  await check('text layer health separates unreadable from clean', async () => {
    const clean = textLayerHealth(['图 1-1 甲', '正文'])
    assert.equal(clean.usable, true)
    const unmapped = textLayerHealth(['\uffff'.repeat(40), '\uffff'.repeat(40)])
    assert.equal(unmapped.usable, false)
    assert.match(unmapped.reason, /no Unicode mapping/)
    const empty = textLayerHealth(['', '   '])
    assert.equal(empty.usable, false)
    assert.match(empty.reason, /no text layer at all/)
  })

  // One page cannot be its own reference: the audit must decline, not report zero holes.
  await check('a one-page document is not audited against itself', async () => {
    const one = join(dir, 'one.tex')
    await writeFile(one, '\\documentclass{article}\n\\begin{document}\nShort.\\end{document}\n')
    const r = await look(one, { page: 1, audit: true })
    assert.notEqual(r.audit.calibration, null)
    assert.match(r.audit.calibration, /cannot be the reference/)
  })

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}

process.exit(failures ? 1 : 0)
