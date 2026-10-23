/**
 * Smoke test: exercises compile → render → locate → diff on a throwaway document.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { look, locateText } from '../lib/core.mjs'

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
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) } catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
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

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}

process.exit(failures ? 1 : 0)
