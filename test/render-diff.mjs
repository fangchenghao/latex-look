import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeRgbPng } from '../lib/read-png.mjs'
import { diffRaster, look } from '../lib/core.mjs'

// Four pixels per row. Row y uses PNG filter y, and the deflate stream
// crosses an IDAT boundary. The RGB formula below is the unfiltered image.
const filtered = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAIAAADtz9qMAAAADUlEQVR4nGMQnCxpdUcnWdW+hjmlGAAAACRJREFUJy+IUW9Bi6anMAQxyfJmwxGzc8pjZW17CGIBiwlDEAAKkw3Py/tyqQAAAABJRU5ErkJggg==',
  'base64',
)
const decoded = await decodeRgbPng(filtered)
const rgb = []
for (let y = 0; y < 5; y++) {
  for (let x = 0; x < 4; x++) rgb.push(17 + 41*x + 29*y, 147 + 73*x + 13*y, 25 + 19*x + 107*y)
}
assert.deepEqual(decoded, { width: 4, height: 5, data: Buffer.from(rgb) })
console.log('  ok   RGB decoding covers all five PNG filters and multiple IDAT chunks')

const changed = { ...decoded, data: Buffer.from(decoded.data) }
changed.data[(2 * 4 + 3) * 3 + 2]++
assert.deepEqual(diffRaster(decoded, changed, 144), {
  dpi: 144, changedPixels: 1, changedRatio: 1 / 20, bbox: { x: 1.5, y: 1, width: 0.5, height: 0.5 },
})
console.log('  ok   a one-channel edit has a one-pixel bounding box in physical points')

const dir = await mkdtemp(join(tmpdir(), 'latex-look-diff-'))
try {
  const file = join(dir, 'rule.tex')
  const rule = shade => [
    '\\documentclass{article}', '\\usepackage{xcolor}', '\\pagestyle{empty}', '\\begin{document}',
    `\\noindent{\\color[RGB]{${shade},${shade},${shade}}\\rule{100bp}{36bp}}`, '\\end{document}',
  ].join('\n')
  const opts = { engine: 'pdflatex', page: 1, dpi: 144 }
  await writeFile(file, rule(240))
  assert.equal((await look(file, { ...opts, compare: null })).ok, true)
  await writeFile(file, rule(234))
  const r = await look(file, opts)
  assert.equal(r.ok, true)
  assert.equal(r.diff.dpi, opts.dpi)
  assert.ok(r.diff.changedPixels >= 200 * 72)
  assert.ok(Math.abs(r.diff.bbox.width - 100) <= 1 && Math.abs(r.diff.bbox.height - 36) <= 1)
  const [left, right, both] = await Promise.all([r.images.before, r.images.after, r.images.sideBySide]
    .map(async path => decodeRgbPng(await readFile(path))))
  assert.equal(both.width, left.width + 24 + right.width)
  assert.equal(both.height, right.height)
  for (let y = 0; y < both.height; y++) {
    const source = y * right.width * 3, dest = y * both.width * 3
    const end = source + right.width * 3
    assert.ok(both.data.subarray(dest, dest + right.width * 3).equals(left.data.subarray(source, end)))
    const rightStart = dest + (left.width + 24) * 3
    assert.ok(both.data.subarray(rightStart, rightStart + right.width * 3).equals(right.data.subarray(source, end)))
  }
  console.log('  ok   a subtle gray change is measured at preview DPI and both composite halves match')

  const same = await look(file, { ...opts, dpi: 72, at: { x: 150, y: 130 }, compare: r.pdf })
  assert.equal(same.ok, true)
  assert.equal(same.diff.changedPixels, 0)
  assert.equal(same.images.sideBySide, null)
  console.log('  ok   two encodings of the same page have zero changed pixels')
} finally {
  await rm(dir, { recursive: true, force: true })
}
