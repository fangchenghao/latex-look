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
// Repeated footers and a stable PDF ID make both ambiguous anchors and an exact
// undo reproducible. Every sheet except the deliberately short ones fills the
// same vertical interval.
const sheet = (label, lines = 31, gapAfter = 0) => [
  `Section ${label}.\\par`,
  ...Array.from({ length: lines }, (_, i) =>
    `Item ${i + 1} of the report.\\par` + (i + 1 === gapAfter ? '\\vspace{120pt}' : '')),
  'Review complete.',
].join('\n')
async function auditSheets(file, sheets, opts = {}) {
  await writeFile(file, [
    '\\documentclass{article}', '\\pdfinfoomitdate=1', '\\pdftrailerid{}', '\\pagestyle{empty}', '\\raggedbottom',
    '\\begin{document}', sheets.join('\n\\newpage\n'), '\\end{document}',
  ].join('\n'))
  const result = await look(file, { ...options, sequence: null, ...opts })
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.pages, sheets.length)
  assert.equal(result.audit.calibration, null)
  return result
}
const holePages = findings => findings.filter(f => f.kind === 'bottom-hole').map(f => f.page)
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
  await check('the whole-book text pass annotates findings beyond the fortieth', async () => {
    const book = join(dir, 'short-pages.tex')
    const pages = Array.from({ length: 43 }, (_, i) => `Figure 1.${i + 1} on sheet ${i + 1}.`)
    await writeFile(book, '\\documentclass{article}\n\\pagestyle{empty}\n\\begin{document}\n' +
      pages.join('\n\\newpage\n') + '\n\\end{document}\n')
    const r = await look(book, { ...options, sequence: null })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.audit.findings.length, pages.length)
    for (const f of r.audit.findings) {
      assert.ok(f.lastLine?.endsWith(`sheet ${f.page}.`), JSON.stringify(f))
      if (f.page < pages.length) assert.equal(f.nextPageOpensWith, `Figure 1-${f.page + 1}`)
    }
  })
  await check('a repeated footer cannot hide another short page, even after rereading or changing thresholds', async () => {
    const form = join(dir, 'repeated-footers.tex')
    const pages = [sheet('One'), sheet('Two'), sheet('Three', 7), sheet('Four')]
    const high = await auditSheets(form, pages, { auditBlankMm: 150 })
    assert.deepEqual(high.audit.findings, [])
    const standard = await look(form, { ...options, sequence: null })
    assert.equal(standard.audit.hadBaseline, false)
    assert.deepEqual(standard.audit.newFindings, [])
    assert.deepEqual(holePages(standard.audit.findings), [3])
    pages[0] = sheet('One', 7)
    const edit = await auditSheets(form, pages)
    assert.deepEqual(holePages(edit.audit.findings), [1, 3])
    assert.deepEqual(holePages(edit.audit.newFindings), [1])
    const highEdit = await look(form, { ...options, sequence: null, auditBlankMm: 150 })
    assert.equal(highEdit.audit.hadBaseline, true)
    assert.deepEqual(highEdit.audit.newFindings, [])
    const reread = await look(form, { ...options, page: 2, sequence: null })
    assert.deepEqual(reread.audit, edit.audit)
  })
  await check('fully identical page text reserves the existing finding on its physical page', async () => {
    const form = join(dir, 'identical-forms.tex')
    const compact = sheet('Repeated form', 14)
    const full = compact.replaceAll('\\par', '\\par\\vspace{12pt}')
    const before = await auditSheets(form, [full, full, compact, full])
    assert.deepEqual(holePages(before.audit.findings), [3])
    const edit = await auditSheets(form, [compact, full, compact, full])
    assert.deepEqual(holePages(edit.audit.findings), [1, 3])
    assert.deepEqual(holePages(edit.audit.newFindings), [1])
    await auditSheets(form, [full, full, compact, full])
    const inserted = await auditSheets(form, [compact, full, full, compact, full])
    assert.deepEqual(holePages(inserted.audit.findings), [1, 4])
    assert.deepEqual(holePages(inserted.audit.newFindings), [1])
  })
  await check('undoing an edit to identical PDF bytes compares with the immediately preceding PDF', async () => {
    const form = join(dir, 'undo.tex')
    const original = [sheet('One'), sheet('Two'), sheet('Three', 7), sheet('Four')]
    const first = await auditSheets(form, original)
    const firstBytes = await readFile(first.pdf)
    const fixed = await auditSheets(form, [sheet('One'), sheet('Two'), sheet('Three'), sheet('Four')])
    assert.deepEqual(fixed.audit.findings, [])
    const undone = await auditSheets(form, original)
    assert.deepEqual(await readFile(undone.pdf), firstBytes)
    assert.deepEqual(holePages(undone.audit.newFindings), [3])
    const reread = await look(form, { ...options, sequence: null })
    assert.deepEqual(reread.audit, undone.audit)
  })
  await check('a deeper hole reports the previous depth, while improving it does not add a finding', async () => {
    const form = join(dir, 'deeper.tex')
    const pages = [sheet('One', 21), sheet('Two'), sheet('Three'), sheet('Four')]
    const first = await auditSheets(form, pages)
    const edit = await auditSheets(form, [sheet('One', 7), ...pages.slice(1)])
    const [deeper] = edit.audit.newFindings
    assert.deepEqual(holePages(edit.audit.newFindings), [1])
    assert.equal(deeper.previousMm, first.audit.findings[0].mm)
    assert.ok(deeper.previousMm > 35 && deeper.previousMm < 50 && deeper.mm > 95)
    assert.match(formatResult(edit), /previously \d+ mm/)
    const improved = await auditSheets(form, pages)
    assert.deepEqual(improved.audit.newFindings, [])
  })
  await check('a short page follows its contents through insertion and movement within a fixed page count', async () => {
    const form = join(dir, 'reflow.tex')
    const pages = [sheet('One'), sheet('Two'), sheet('Three', 7), sheet('Four')]
    await auditSheets(form, pages)
    const inserted = await auditSheets(form, [sheet('New'), ...pages])
    assert.deepEqual(holePages(inserted.audit.findings), [4])
    assert.deepEqual(inserted.audit.newFindings, [])
    assert.equal(inserted.audit.repaginatedFrom, 4)
    const reordered = await auditSheets(form, [sheet('New'), pages[2], pages[1], pages[0], pages[3]])
    assert.deepEqual(holePages(reordered.audit.findings), [2])
    assert.deepEqual(reordered.audit.newFindings, [])
  })
  await check('an internal gap at a different height is reported even with identical page text', async () => {
    const form = join(dir, 'internal-gap.tex')
    const others = [sheet('Two'), sheet('Three'), sheet('Four')]
    const first = await auditSheets(form, [sheet('One', 20, 5), ...others])
    const edit = await auditSheets(form, [sheet('One', 20, 15), ...others])
    const old = first.audit.findings.find(f => f.kind === 'hole-inside')
    const fresh = edit.audit.newFindings.find(f => f.kind === 'hole-inside')
    assert.equal(fresh?.page, 1)
    assert.ok(fresh.startPt - old.startPt > 75)
  })
  await check('an older baseline with an unknown threshold starts a new comparable history', async () => {
    const form = join(dir, 'legacy.tex')
    const pages = [sheet('One'), sheet('Two'), sheet('Three', 7), sheet('Four')]
    await auditSheets(form, pages)
    await writeFile(baselinePath(form), JSON.stringify({ pages: 4, findings: [] }))
    const migrated = await look(form, { ...options, sequence: null })
    assert.equal(migrated.audit.hadBaseline, false)
    assert.deepEqual(migrated.audit.newFindings, [])
    assert.match(formatResult(migrated), /older baseline omitted its threshold/)
    const edit = await auditSheets(form, [sheet('One', 7), ...pages.slice(1)])
    assert.deepEqual(holePages(edit.audit.newFindings), [1])
  })
} finally {
  const root = await realpath(tmpdir()), target = await realpath(dir)
  assert.equal(dirname(target), root, `unsafe fixture deletion target: ${target}`)
  await rm(target, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} audit review checks passed`)
if (failures) process.exitCode = 1
