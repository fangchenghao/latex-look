// Reproductions from the second review. Real TeX/Ghostscript; no module mocks.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, stat, utimes, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { look, pdfPageText, pageTexts, pageCarryingText, renderPage, replaceFile } from '../lib/core.mjs'
import { formatResult } from '../lib/format.mjs'

const dir = await mkdtemp(join(tmpdir(), 'latex-look-review-'))
const document = (body, preamble = '') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`
let count = 0, failures = 0
async function check(name, fn) {
  count++
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.stack}`) }
}
async function fixture(name, body, preamble) {
  const file = join(dir, name + '.tex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, document(body, preamble))
  const result = await look(file, { engine: 'pdflatex', page: 1, compare: null })
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  return { file, result }
}
const options = { engine: 'pdflatex', page: 1 }
try {
  const a = await fixture('a/main', 'AAAA MARKER.')
  const b = await fixture('b/main', 'BBBB MARKER.')
  await check('equal-size PDF restores invalidate both text caches and verification', async () => {
    const target = join(dir, 'restored.pdf')
    const buffers = await Promise.all([readFile(a.result.pdf), readFile(b.result.pdf)])
    const length = Math.max(...buffers.map(b => b.length))
    const padded = buffers.map(b => Buffer.concat([b, Buffer.alloc(length - b.length, 32)]))
    const stamp = new Date(1700000000000)
    await writeFile(target, padded[0]); await utimes(target, stamp, stamp)
    assert.match(await pdfPageText(target, 1), /AAAA/)
    assert.match((await pageTexts(target))[0], /AAAA/)
    await writeFile(target, padded[1]); await utimes(target, stamp, stamp)
    assert.equal((await stat(target)).mtimeMs, stamp.getTime())
    assert.match(await pdfPageText(target, 1), /BBBB/)
    assert.match((await pageTexts(target))[0], /BBBB/)
    assert.equal((await pageCarryingText(target, 1, 'AAAA MARKER')).verified, false)
    // Restoring an older, previously cached generation is safe too.
    await writeFile(target, padded[0]); await utimes(target, stamp, stamp)
    assert.match(await pdfPageText(target, 1), /AAAA/)
  })
  await check('same-millisecond text extraction never reads the other document', async () => {
    const oldNow = Date.now
    Date.now = () => 1800000000000
    try {
      const [ta, tb] = await Promise.all([pdfPageText(a.result.pdf, 1), pdfPageText(b.result.pdf, 1)])
      assert.match(ta, /AAAA/); assert.doesNotMatch(ta, /BBBB/)
      assert.match(tb, /BBBB/); assert.doesNotMatch(tb, /AAAA/)
    } finally { Date.now = oldNow }
  })
  await check('same-basename concurrent renders and point rasters stay separate', async () => {
    const oldNow = Date.now
    Date.now = () => 1800000000000
    try {
      const rs = await Promise.all([a, b].map(f => look(f.file, { ...options, at: { x: 150, y: 128 }, compare: null })))
      assert.ok(rs.every(r => r.ok && r.located.length && r.located[0].ink))
      assert.notEqual(rs[0].images.after, rs[1].images.after)
      assert.notDeepEqual(await readFile(rs[0].images.after), await readFile(rs[1].images.after))
    } finally { Date.now = oldNow }
  })
  await check('a render of a missing page never returns an earlier PNG', async () => {
    const two = await fixture('two', 'First.\\newpage Second.')
    const target = join(dir, 'shrunk.pdf'), outDir = join(dir, 'renders')
    await copyFile(two.result.pdf, target)
    const before = await renderPage(target, 2, { outDir })
    const bytes = await readFile(before.path)
    await copyFile(a.result.pdf, target)
    await assert.rejects(renderPage(target, 2, { outDir }), /no image.*page 2/)
    assert.deepEqual(await readFile(before.path), bytes)
  })
  await check('same-document renders remain immutable after a later edit', async () => {
    const f = await fixture('immutable', 'OLD RENDER.')
    const bytes = await readFile(f.result.images.after)
    await writeFile(f.file, document('DIFFERENT RENDER.'))
    const next = await look(f.file, options)
    assert.equal(next.ok, true)
    assert.notEqual(next.images.after, f.result.images.after)
    assert.deepEqual(await readFile(f.result.images.after), bytes)
  })
  await check('missing replacement preserves target; empty replacement is actually empty', async () => {
    const from = join(dir, 'empty.pdf'), to = join(dir, 'target.pdf')
    await writeFile(to, 'OLD')
    assert.equal(await replaceFile(from, to), false)
    assert.equal(await readFile(to, 'utf8'), 'OLD')
    await writeFile(from, '')
    assert.equal(await replaceFile(from, to), true)
    assert.equal((await stat(to)).size, 0)
  })
  await check('nested input paths use the compilation directory for locate and cache', async () => {
    const file = join(dir, 'nested.tex'), body = join(dir, 'body.tex')
    await mkdir(join(dir, 'chap'))
    await writeFile(file, document('\\input{chap/wrapper}'))
    await writeFile(join(dir, 'chap/wrapper.tex'), '\\input{body}\n')
    await writeFile(body, 'NESTED-OLD\n')
    const first = await look(file, { ...options, at: { text: 'NESTED-OLD' } })
    assert.equal(first.ok, true)
    assert.equal(first.located[0]?.file, body)
    assert.equal(first.located[0]?.line, 1)
    await writeFile(body, 'NESTED-NEW\n')
    const next = await look(file, { ...options, at: { text: 'NESTED-NEW' } })
    assert.equal(next.ok, true)
    assert.equal(next.cached, false)
    assert.equal(next.located[0]?.file, body)
    assert.match(await pdfPageText(next.pdf, 1), /NESTED-NEW/)
  })
  await check('equal-size source edits with restored mtime invalidate the build', async () => {
    const f = await fixture('restored-source', 'OLD-SOURCE')
    const stamp = new Date(1700000000000)
    await utimes(f.file, stamp, stamp)
    await look(f.file, options)
    await writeFile(f.file, document('NEW-SOURCE'))
    await utimes(f.file, stamp, stamp)
    const next = await look(f.file, options)
    assert.equal(next.cached, false)
    assert.match(await pdfPageText(next.pdf, 1), /NEW-SOURCE/)
  })
  await check('a style can load a project dependency through a macro and still invalidate the cache', async () => {
    const folder = join(dir, 'local style')
    await mkdir(folder)
    const main = join(folder, 'main.tex'), defs = join(folder, 'layout.def')
    await writeFile(main, document('\\heading', '\\usepackage{house}'))
    await writeFile(join(folder, 'house.sty'), '\\def\\layoutfile{layout.def}\n\\input{\\layoutfile}\n')
    const stamp = new Date(1700000000000)
    await writeFile(defs, '\\def\\heading{BEFORE}\n'); await utimes(defs, stamp, stamp)
    const first = await look(main, options)
    assert.equal(first.ok, true, JSON.stringify(first.problems))
    await rm(join(folder, 'main.fls'))
    assert.equal((await look(main, options)).cached, true)
    await writeFile(defs, '\\def\\heading{EDITED}\n'); await utimes(defs, stamp, stamp)
    const next = await look(main, options)
    assert.equal(next.cached, false)
    assert.match(await pdfPageText(next.pdf, 1), /EDITED/)
    assert.ok(next.diff?.changedPixels > 0)
  })
  await check('editing a local bibliography refreshes the references', async () => {
    const file = join(dir, 'refs.tex'), bib = join(dir, 'sources.bib')
    const entry = title => `@book{demo,author={Ada Author},title={${title}},publisher={Press},year={2020}}\n`
    await writeFile(file, document('\\nocite{demo}\\bibliographystyle{plain}\\bibliography{sources}'))
    await writeFile(bib, entry('Firsttitle'))
    assert.equal((await look(file, options)).ok, true)
    await writeFile(bib, entry('Newtitle'))
    const next = await look(file, options)
    assert.equal(next.ok, true)
    assert.equal(next.cached, false)
    assert.match(await pdfPageText(next.pdf, 1), /Newtitle/i)
  })
  await check('deep sources are located and commented anchors and TOCs are ignored', async () => {
    const folder = join(dir, 'deep')
    await mkdir(folder)
    const file = join(folder, 'main.tex')
    await writeFile(file, document('% comment with MARKER and \\tableofcontents\n\\input{a}'))
    for (const [name, child] of [['a', 'b'], ['b', 'c'], ['c', 'd']]) {
      await writeFile(join(folder, name + '.tex'), `\\input{${child}}\n`)
    }
    await writeFile(join(folder, 'd.tex'), '100\\% MARKER.\n')
    const r = await look(file, { ...options, at: { text: 'MARKER' } })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.toc.expected, false)
    assert.deepEqual(r.located.map(h => [h.file, h.line]), [[join(folder, 'd.tex'), 1]])
  })
  await check('an empty includeonly omits the chapter TOC and keeps ordinary inputs active', async () => {
    const folder = join(dir, 'partial')
    await mkdir(folder)
    const file = join(folder, 'main.tex'), chapter = join(folder, 'chapter.tex')
    await writeFile(file, document('\\input{body}\\include{chapter}', '\\includeonly{}'))
    await writeFile(join(folder, 'body.tex'), 'ACTIVE BODY.\n')
    await writeFile(chapter, 'OMITTED TEXT.\\tableofcontents\n')
    const r = await look(file, { ...options, at: { text: 'OMITTED TEXT' } })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.toc.expected, false)
    assert.ok(r.warnings.some(w => /includeonly leaves out/.test(w.message)))
    const again = await look(file, { ...options, at: { text: 'ACTIVE BODY' } })
    assert.equal(again.cached, true)
    assert.equal(again.located[0]?.file, join(folder, 'body.tex'))
  })
  await check('auto and latexmk honor the TeX program directive', async () => {
    const file = join(dir, 'magic.tex')
    await writeFile(file, '% !TeX program = lualatex\n' + document('\\directlua{tex.sprint("Lua engine")}'))
    const lua = await look(file, { engine: 'auto', compare: null })
    assert.equal(lua.engine, 'lualatex')
    assert.equal(lua.ok, true, JSON.stringify(lua.problems))
    await writeFile(file, '%!TeX TS-program = pdflatex\n' + document('\\ifdefined\\pdftexversion PDF engine\\else\\errmessage{Expected pdfTeX}\\fi'))
    const mk = await look(file, { engine: 'latexmk', compare: null })
    assert.equal(mk.ok, true, JSON.stringify(mk.problems))
    assert.match(await pdfPageText(mk.pdf, 1), /PDF\s*engine/)
  })
  await check('an externally replaced output PDF is not a valid build-cache hit', async () => {
    const f = await fixture('output-replaced', 'ACTUAL-SOURCE')
    await copyFile(b.result.pdf, f.result.pdf)
    const next = await look(f.file, options)
    assert.equal(next.cached, false)
    assert.match(await pdfPageText(next.pdf, 1), /ACTUAL-SOURCE/)
  })
  await check('compare null disables diff without disabling next-build snapshots', async () => {
    const f = await fixture('disabled', 'ONE')
    await writeFile(f.file, document('TWO'))
    const next = await look(f.file, { ...options, compare: null })
    assert.equal(next.diff, null)
    assert.equal(next.images.before, null)
    const cached = await look(f.file, options)
    assert.equal(cached.cached, true)
    assert.ok(cached.diff?.changedPixels > 0)
  })
  await check('a bad explicit baseline does not stop previous-snapshot publication', async () => {
    const f = await fixture('bad-baseline', 'ONE')
    await writeFile(f.file, document('TWO'))
    await look(f.file, options)
    const expected = join(dir, 'expected-two.pdf')
    await copyFile(f.result.pdf, expected)
    await writeFile(f.file, document('THREE'))
    const bad = await look(f.file, { ...options, compare: join(dir, 'missing.pdf') })
    assert.match(bad.compareError, /could not read/)
    const cached = await look(f.file, options)
    const correct = await look(f.file, { ...options, compare: expected })
    assert.equal(cached.cached, true)
    assert.deepEqual(cached.diff, correct.diff)
  })
  await check('fresh latexmk may correctly leave an already current PDF untouched', async () => {
    const f = await fixture('latexmk-noop', 'ALREADY CURRENT')
    const first = await look(f.file, { ...options, engine: 'latexmk' })
    const next = await look(f.file, { ...options, engine: 'latexmk', fresh: true })
    assert.equal(first.ok, true, JSON.stringify(first.problems))
    assert.equal(next.ok, true, JSON.stringify(next.problems))
    assert.ok(next.images.after)
  })
  await check('two fresh overlapping looks each compare their actual predecessor', async () => {
    const f = await fixture('concurrent', 'ONE')
    await writeFile(f.file, document('TWO'))
    const [first, second] = await Promise.all([look(f.file, { ...options, fresh: true }), look(f.file, { ...options, fresh: true })])
    assert.equal(first.ok, true); assert.equal(second.ok, true)
    assert.ok(first.diff?.changedPixels > 0)
    assert.equal(second.diff?.changedRatio, 0)
    assert.notEqual(first.images.after, second.images.after)
  })
  await check('a rule elsewhere on the row is not ink at the requested x', async () => {
    const f = await fixture('short-rule', 'Hello.\\par\\noindent\\rule{120pt}{0.4pt}')
    const beside = await look(f.file, { ...options, at: { x: 500, y: 142 } })
    assert.equal(beside.located[0]?.ink?.kind, 'blank')
    const on = await look(f.file, { ...options, at: { x: 180, y: 142 }, dpi: 72 })
    assert.equal(on.located[0]?.ink?.kind, 'rule')
    const outside = await look(f.file, { ...options, at: Object.freeze({ x: 2000, y: 142 }) })
    assert.ok(outside.warnings.some(w => /outside page/.test(w.message)))
  })
  await check('failed BibTeX is a failed build and cannot be reused', async () => {
    const file = join(dir, 'bib.tex')
    await writeFile(file, document('Hello.\n\\bibliographystyle{plain}\n\\bibliography{nonexistent-db}'))
    for (let i = 0; i < 2; i++) {
      const r = await look(file, options)
      assert.equal(r.ok, false)
      assert.equal(r.cached, false)
      assert.ok(r.problems.some(p => /bibtex failed/.test(p.message)))
      assert.equal(r.diff, null)
    }
  })
  await check('different paper sizes decline the pixel comparison with a reason', async () => {
    const f = await fixture('small', 'SMALL PAGE', '\\usepackage[paperwidth=300pt,paperheight=400pt,margin=20pt]{geometry}')
    const r = await look(f.file, { ...options, compare: a.result.pdf })
    assert.equal(r.diff, null)
    assert.match(r.compareError, /dimensions differ/)
  })
  await check('a corrupt explicit baseline is not called a missing previous page', async () => {
    const invalid = join(dir, 'invalid.pdf')
    await writeFile(invalid, 'not a PDF')
    const r = await look(a.file, { ...options, compare: invalid })
    assert.equal(r.diff, null)
    assert.match(r.compareError, /could not compare.*compare PDF/)
    assert.doesNotMatch(r.compareError, /repaginated|previous build/)
  })
  await check('missing SyncTeX declines points and distinguishes existing source matches', async () => {
    const f = await fixture('no-synctex', 'VISIBLE MARKER', '\\synctex=0')
    const point = await look(f.file, { ...options, at: { x: 300, y: 78 } })
    assert.deepEqual(point.located, [])
    assert.ok(point.warnings.some(w => /SyncTeX returned no source position/.test(w.message)))
    const text = await look(f.file, { ...options, at: { text: 'VISIBLE MARKER' } })
    assert.deepEqual(text.located, [])
    assert.ok(text.warnings.some(w => /matched 1 source line.*SyncTeX returned no position/.test(w.message)))
    assert.ok(!text.warnings.some(w => /was not found/.test(w.message)))
  })
  await check('an invalid page cannot carry a location from page one', async () => {
    for (const at of [{ x: 300, y: 78 }, { text: 'AAAA MARKER' }]) {
      const r = await look(a.file, { ...options, page: 0, at })
      assert.equal(r.ok, false)
      assert.ok(!r.located?.length)
      assert.match(r.fatal, /page 0 is out of range/)
    }
  })
  await check('the shared formatter exposes sequence extraction failures', async () => {
    const text = formatResult({ ...a.result, sequence: { error: 'extraction failed' } })
    assert.match(text, /ORDER: cannot check the order.*extraction failed/)
    assert.doesNotMatch(text, /all in reading order/)
  })
} finally {
  const target = await realpath(dir), root = await realpath(tmpdir())
  assert.equal(dirname(target), root)
  assert.ok(target.includes('latex-look-review-'))
  await rm(target, { recursive: true, force: true })
}
console.log(`\n${count - failures}/${count} review core checks passed`)
if (failures) process.exitCode = 1
