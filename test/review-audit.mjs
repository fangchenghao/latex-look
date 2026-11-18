// Real PDFs: an audit without a reference, or a partial failed build, must never
// become a clean baseline or a successful reading-order check.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { look, auditLayout } from '../lib/core.mjs'
import { formatResult } from '../lib/format.mjs'

const dir = await mkdtemp(join(tmpdir(), 'latex-look-review-audit-'))
let checks = 0, failures = 0
async function check(name, body) {
  checks++
  try { await body(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
}
const baselinePath = (file) => join(tmpdir(), 'latex-look-audit-baseline',
  createHash('sha1').update(file).digest('hex'), `${basename(file, '.tex')}.json`)
const BLANK = String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
\null\newpage\null\newpage\null
\end{document}
`
const paragraphs = 'The body of this page is real content. '.repeat(80)
const GOOD = String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
Figure 1.1 first caption.

${paragraphs}
\newpage
Figure 1.2 second caption.

${paragraphs}
\newpage
Figure 1.3 third caption.

${paragraphs}
\end{document}
`
const PARTIAL = String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
Figure 1.1 partial caption.
\newpage
\UndefinedFailure
\end{document}
`
const options = { engine: 'pdflatex', page: 1, audit: true, sequence: 'Figure', compare: null }
try {
  const blank = join(dir, 'blank.tex')
  await writeFile(blank, BLANK)
  const firstBlank = await look(blank, options)
  assert.equal(firstBlank.ok, true)
  assert.equal(firstBlank.pages, 3)
  await check('raw audit of three blank pages explains its missing reference', async () => {
    const report = await auditLayout(firstBlank.pdf)
    assert.match(report.calibration || '', /every page is blank/)
  })
  await check('blank-page audit declines instead of recording an empty baseline', async () => {
    assert.match(firstBlank.audit.calibration || '', /every page is blank/)
    assert.match(formatResult(firstBlank), /AUDIT: cannot measure/)
    assert.doesNotMatch(formatResult(firstBlank), /AUDIT \(baseline recorded/)
    await assert.rejects(stat(baselinePath(blank)), { code: 'ENOENT' })
  })
  const secondBlank = await look(blank, options)
  await check('a repeated blank-page audit never says nothing new', async () => {
    assert.match(secondBlank.audit.calibration || '', /every page is blank/)
    assert.equal(secondBlank.audit.hadBaseline, false)
    assert.doesNotMatch(formatResult(secondBlank), /AUDIT: nothing new/)
    await assert.rejects(stat(baselinePath(blank)), { code: 'ENOENT' })
  })

  const file = join(dir, 'document.tex')
  await writeFile(file, GOOD)
  const good = await look(file, options)
  assert.equal(good.ok, true)
  assert.equal(good.pages, 3)
  assert.equal(good.audit.calibration, null)
  assert.equal(good.sequence.total, 3)
  const baseline = baselinePath(file)
  const before = await readFile(baseline, 'utf8')
  await writeFile(file, PARTIAL)
  const partial = await look(file, options)
  assert.equal(partial.ok, false, 'fixture must fail compilation')
  assert.equal(partial.pages, 1, 'fixture must ship a partial PDF')
  assert.ok(partial.images.after, 'fixture must reach the rendered partial-output path')
  await check('a failed partial PDF does not pass the reading-order check', () => {
    assert.match(partial.sequence.error || '', /compile failed/)
    assert.match(formatResult(partial), /ORDER: cannot check the order.*compile failed/)
    assert.doesNotMatch(formatResult(partial), /all in reading order/)
  })
  await check('a failed partial PDF does not replace the audit baseline', async () => {
    assert.match(partial.audit.error || '', /compile failed/)
    assert.match(formatResult(partial), /AUDIT FAILED:.*compile failed/)
    assert.equal(await readFile(baseline, 'utf8'), before)
  })

  await writeFile(file, BLANK)
  const changedToBlank = await look(file, options)
  await check('an all-blank rebuild leaves the last usable audit baseline intact', async () => {
    assert.equal(changedToBlank.ok, true)
    assert.match(changedToBlank.audit.calibration || '', /every page is blank/)
    assert.deepEqual(changedToBlank.audit.newFindings, [])
    assert.equal(await readFile(baseline, 'utf8'), before)
  })
  await writeFile(file, '\\documentclass{article}\n\\begin{document}\nOne short page.\n\\end{document}\n')
  const short = await look(file, options)
  await check('an uncalibratable one-page rebuild does not replace the good baseline', async () => {
    assert.equal(short.ok, true)
    assert.match(short.audit.calibration || '', /cannot be the reference/)
    assert.deepEqual(short.audit.newFindings, [])
    assert.equal(await readFile(baseline, 'utf8'), before)
  })
  await writeFile(file, GOOD)
  const restored = await look(file, options)
  await check('restoring the document compares to the last successful usable audit', () => {
    assert.equal(restored.ok, true)
    assert.equal(restored.audit.baselinePages, 3)
    assert.equal(restored.audit.hadBaseline, true)
    assert.deepEqual(restored.audit.newFindings, [])
    assert.equal(restored.sequence.total, 3)
    assert.deepEqual(restored.sequence.inversions, [])
  })
} finally {
  const root = await realpath(tmpdir()), target = await realpath(dir)
  assert.equal(dirname(target), root, `unsafe fixture deletion target: ${target}`)
  await rm(target, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} audit review checks passed`)
if (failures) process.exitCode = 1
