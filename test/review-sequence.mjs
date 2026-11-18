// Second-review regressions: real CLI builds, not mocked engine output.
// Run: node test/review-sequence.mjs (TeX + Ghostscript on PATH).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBinary, pdfPageText } from '../lib/core.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = resolve(tmpdir())
const dir = await mkdtemp(join(temporaryRoot, "latex-look-review sequence 中文's-"))
const entry = join(repo, 'bin', 'latex-look.mjs')
let failures = 0
let checks = 0
let fixture = 0
async function check(name, fn) {
  checks++
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
}
async function cli(source, { sequence, engine = 'xelatex', maxPasses = 3, tocSeed } = {}) {
  const work = join(dir, String(++fixture))
  await mkdir(work)
  const file = join(work, 'main.tex')
  await writeFile(file, source)
  if (tocSeed !== undefined) await writeFile(join(work, 'main.toc'), tocSeed)
  const args = [entry, file, '--engine', engine, '--max-passes', String(maxPasses), '--dpi', '72']
  if (sequence) args.push('--sequence', sequence)
  const run = spawnSync(process.execPath, [...args, '--json'], { cwd: repo, encoding: 'utf8' })
  assert.ifError(run.error)
  assert.ok([0, 2].includes(run.status), `CLI exit ${run.status}: ${run.stderr}`)
  const result = JSON.parse(run.stdout)
  await writeFile(join(work, 'result.json'), run.stdout)
  return { ...result, exit: run.status, args }
}
function assertDeclined(r, count) {
  assert.equal(r.ok, true, JSON.stringify(r.problems))
  assert.ok(r.sequence.unreliable, JSON.stringify(r.sequence))
  assert.equal(r.sequence.total, count)
  assert.deepEqual(r.sequence.inversions, [])
  const run = spawnSync(process.execPath, r.args, { cwd: repo, encoding: 'utf8' })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /cannot check the order/)
  assert.doesNotMatch(run.stdout, /all in reading order/)
}
const toc = numbered => String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\clearpage
` + (numbered ? '\\section{VISIBLE SECTION}\n' : '\\section*{UNNUMBERED SECTION}\n') + String.raw`Body text.
\end{document}
`
const sequenceDoc = lines => String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
` + lines.map(line => '\\noindent ' + line + '\\par\n').join('') + '\\end{document}\n'

try {
  for (const engine of ['xelatex', 'latexmk']) {
    if (findBinary(engine) === engine) {
      console.log(`  skip ${engine} TOC cases: engine not installed`)
      continue
    }
    await check(`${engine}: populated TOC succeeds with the right pass semantics`, async () => {
      const r = await cli(toc(true), { engine })
      assert.equal(r.exit, 0, JSON.stringify(r.problems))
      assert.equal(r.toc.entries, 1)
      assert.ok(engine === 'latexmk' ? r.passes === 1 : r.passes >= 2)
      assert.match(await pdfPageText(r.pdf, 1), /VISIBLE SECTION/)
    })
    for (const tocSeed of [undefined, '']) {
      await check(`${engine}: genuinely empty TOC fails (${tocSeed === '' ? 'preexisting empty .toc' : 'no .toc'})`, async () => {
        const r = await cli(toc(false), { engine, tocSeed })
        assert.equal(r.exit, 2)
        assert.equal(r.toc.entries, 0)
        assert.ok(r.problems.some(p => /contents is EMPTY/.test(p.message)), JSON.stringify(r.problems))
      })
    }
  }
  for (const [description, tocSeed] of [
    ['missing', undefined], ['zero-byte', ''], ['setup-only', '\\relax\n'],
    ['comment-only', '% \\contentsline {section}{Comment only}{2}{}\n'],
  ]) {
    await check(`one pass cannot fill a ${description} preexisting TOC`, async () => {
      const r = await cli(toc(true), { maxPasses: 1, tocSeed })
      assert.equal(r.exit, 2, JSON.stringify(r))
      assert.equal(r.toc.entries, 1, 'the newly written .toc is not what the PDF typeset')
      assert.ok(r.problems.some(p => /contents page is EMPTY/.test(p.message)))
      assert.doesNotMatch(await pdfPageText(r.pdf, 1), /VISIBLE SECTION/)
    })
  }
  await check('one pass over populated previous TOC remains a warning, not a false empty error', async () => {
    const tocSeed = String.raw`\contentsline {section}{\numberline {1}PREVIOUS SECTION}{2}{}%
`
    const r = await cli(toc(true), { maxPasses: 1, tocSeed })
    assert.equal(r.exit, 0, JSON.stringify(r.problems))
    assert.ok(r.warnings.some(w => /previous build wrote/.test(w.message)))
    assert.match(await pdfPageText(r.pdf, 1), /PREVIOUS SECTION/)
  })
  await check('dotted inversion retains observed labels rather than fabricating hyphens', async () => {
    const r = await cli(sequenceDoc(['Figure 3.2: first', 'Figure 3.1: second']), { sequence: 'Figure' })
    assert.equal(r.exit, 0, JSON.stringify(r.problems))
    assert.equal(r.sequence.total, 2)
    assert.equal(r.sequence.inversions.length, 1)
    assert.equal(r.sequence.inversions[0].before.label, 'Figure 3.2')
    assert.equal(r.sequence.inversions[0].after.label, 'Figure 3.1')
  })
  await check('literal Fig. prefix and hyphens detect an inversion', async () => {
    const r = await cli(sequenceDoc(['Fig. 3-2: first', 'Fig. 3-1: second']), { sequence: 'Fig.' })
    assert.equal(r.sequence.total, 2)
    assert.equal(r.sequence.inversions.length, 1)
    assert.equal(r.sequence.inversions[0].before.label, 'Fig. 3-2')
  })
  await check('ordered dotted labels remain supported', async () => {
    const r = await cli(sequenceDoc(['Figure 3.1: first', 'Figure 3.2: second']), { sequence: 'Figure' })
    assert.equal(r.sequence.total, 2)
    assert.equal(r.sequence.unreliable, undefined)
    assert.deepEqual(r.sequence.inversions, [])
  })
  await check('zero matches decline instead of reporting success', async () => {
    const r = await cli(sequenceDoc(['Figure 3.1: first', 'Figure 3.2: second']), { sequence: 'Figur' })
    assertDeclined(r, 0)
  })
  for (const [name, lines, matched] of [
    ['suffix-only', ['Figure 3.2b: first', 'Figure 3.2a: second'], 0],
    ['three-component', ['Figure 3.2.2: first', 'Figure 3.2.1: second'], 0],
    ['partial unsupported separator', ['Figure 3.1: first', 'Figure 3/3: second', 'Figure 3/2: third'], 1],
    ['partial suffixed labels', ['Figure 3.1: first', 'Figure 3.2b: second', 'Figure 3.2a: third'], 1],
    ['single-part numbering', ['Figure 2: first', 'Figure 1: second'], 0],
    ['parenthesized suffix', ['Figure 3.2(b): first', 'Figure 3.2(a): second'], 0],
  ]) {
    await check(`${name} declines the entire partial scan`, async () => {
      const r = await cli(sequenceDoc(lines), { sequence: 'Figure' })
      assertDeclined(r, matched)
      assert.equal(r.sequence.unsupported.length, lines.length - matched)
      assert.match(r.sequence.unreliable, /unsupported label form/)
    })
  }
  // Prefer an installed font with a useful Unicode map. Some Ghostscript/font
  // combinations extract CJK as unrelated glyphs; those must decline, not pass.
  const unicodeDoc = (first, second) => String.raw`\documentclass[UTF8,fontset=fandol]{ctexart}
\IfFontExistsTF{Songti SC}{\setmainfont{Songti SC}\setCJKmainfont{Songti SC}}{}
\pagestyle{empty}
\begin{document}
` + [first, second].map(text => `\\noindent ${text}: caption\\par\n`).join('') + '\\end{document}\n'
  for (const [prefix, first, second] of [['图', '图2.2', '图2.1'], ['Figure', 'Figure 3·2', 'Figure 3·1']]) {
    await check(`${first} is read verbatim or declines an unusable text mapping`, async () => {
      const r = await cli(unicodeDoc(first, second), { sequence: prefix })
      assert.equal(r.exit, 0, JSON.stringify(r.problems))
      const text = await pdfPageText(r.pdf, 1)
      if (!text.includes(first) || !text.includes(second)) {
        assertDeclined(r, 0)
        return
      }
      assert.equal(r.sequence.total, 2, JSON.stringify(r.sequence))
      assert.equal(r.sequence.inversions.length, 1)
      assert.equal(r.sequence.inversions[0].before.label, first)
      assert.equal(r.sequence.inversions[0].after.label, second)
    })
  }
} finally {
  // Only remove the fresh directory created by this test, never a computed parent.
  assert.equal(dirname(resolve(dir)), temporaryRoot)
  assert.ok(dir.startsWith(join(temporaryRoot, 'latex-look-review sequence ')))
  await rm(dir, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} sequence/TOC checks passed`)
if (failures) process.exitCode = 1
