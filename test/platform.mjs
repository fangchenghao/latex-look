/**
 * Platform tests: the parts that answer "does this run on Windows?" without
 * needing Windows.
 *
 * The lookup functions take `platform` and `env` as arguments, so the win32
 * branches are exercised here on macOS. The failures they guard against are not
 * hypothetical: PATH was split on ':' (Windows separates with ';'), so every
 * lookup fell through to the bare command name; and Ghostscript was asked for as
 * `gs`, which no Windows installer creates.
 *
 * Everything else in this file is a real end-to-end check, so this suite also
 * runs on Windows CI against a real TeX and Ghostscript.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { look, resolveBinary, findGhostscript } from '../lib/core.mjs'
import { formatResult } from '../lib/format.mjs'

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

// --- executable lookup, without a Windows machine --------------------------

// `join` uses the separator of the machine running the test, while some of the
// fake directories here are Windows paths: compare with one separator on both
// sides. The implementation is unaffected — there, both sides agree already.
// PATH may spell PATHEXT as `.EXE` while the file on disk is `xelatex.exe`; a real
// existsSync on Windows is case-insensitive, so the stand-in has to be too.
const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
const hasIn = (present) => (p) => present.map(norm).includes(norm(p))
// A resolved path is only meaningful as a file; `join` here uses the separator of
// the machine running the test, and PATHEXT may spell `.EXE`. Compare identity.
const samePath = (actual, expected) => assert.equal(norm(actual), norm(expected))

await check('resolveBinary splits PATH on ";" on Windows', () => {
  // The regression: with ':' this becomes one giant "directory" and never matches.
  const env = { PATH: 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64;C:\\Windows\\system32', PATHEXT: '.EXE;.CMD' }
  const exists = hasIn(['C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe'])
  samePath(resolveBinary('xelatex', { env, platform: 'win32', exists }), 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe')
})

await check('resolveBinary appends a PATHEXT suffix on Windows', () => {
  // There is no file called `synctex` on Windows, only `synctex.exe`.
  const env = { PATH: 'C:\\texlive\\2024\\bin\\windows', PATHEXT: '.EXE' }
  const exists = hasIn(['C:\\texlive\\2024\\bin\\windows\\synctex.exe'])
  samePath(resolveBinary('synctex', { env, platform: 'win32', exists }), 'C:\\texlive\\2024\\bin\\windows\\synctex.exe')
})

await check('resolveBinary still splits PATH on ":" everywhere else', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/bin' }
  const exists = hasIn(['/opt/homebrew/bin/xelatex'])
  samePath(resolveBinary('xelatex', { env, platform: 'darwin', exists }), '/opt/homebrew/bin/xelatex')
})

await check('resolveBinary reads Path when PATH is absent', () => {
  // Windows sets the variable as `Path`; Node usually normalises it, not always.
  const env = { Path: 'C:\\tools' }
  const exists = hasIn(['C:\\tools\\latexmk.exe'])
  samePath(resolveBinary('latexmk', { env, platform: 'win32', exists }), 'C:\\tools\\latexmk.exe')
})

await check('resolveBinary leaves a path that is already a path alone', () => {
  const cmd = 'C:\\Program Files\\TeX\\xelatex.exe'
  samePath(resolveBinary(cmd, { env: {}, platform: 'win32', exists: () => false }), cmd)
})

await check('an unresolved command is returned as written, not as an empty path', () => {
  // Callers report "missing binary", so they need the name back to name it.
  assert.equal(resolveBinary('pdflatex', { env: { PATH: '' }, platform: 'win32', exists: () => false }), 'pdflatex')
})

await check('ghostscript is asked for as gswin64c on Windows', () => {
  const env = { PATH: 'C:\\Program Files\\gs\\gs10.05.1\\bin' }
  const exists = hasIn(['C:\\Program Files\\gs\\gs10.05.1\\bin\\gswin64c.exe'])
  samePath(findGhostscript({ env, platform: 'win32', exists }), 'C:\\Program Files\\gs\\gs10.05.1\\bin\\gswin64c.exe')
})

await check('ghostscript falls back to gswin32c, then to gs', () => {
  const env = { PATH: 'C:\\gs' }
  samePath(findGhostscript({ env, platform: 'win32', exists: hasIn(['C:\\gs\\gswin32c.exe']) }), 'C:\\gs\\gswin32c.exe')
  samePath(findGhostscript({ env, platform: 'darwin', exists: hasIn(['C:\\gs\\gs']) }), 'gs')
})

// --- the paths themselves ---------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'latex-look-platform-'))

await check('a document in a directory holding a backslash still compiles and reports', async () => {
  // Windows paths are all backslashes, and they are handed to Ghostscript inside a
  // PostScript string, where a backslash is an escape character: (C:\Users\r)
  // does not open a file, it opens "C:Usersr" or throws a syntax error. This is
  // the same code path, on a platform where such a directory name is legal.
  const odd = join(dir, 'a\\b')
  await mkdir(odd, { recursive: true })
  const file = join(odd, 'odd.tex')
  await writeFile(file, '\\documentclass{article}\n\\begin{document}\nEscaped path.\n\\end{document}\n')
  const r = await look(file, { page: 1 })
  const text = formatResult(r)
  assert.match(text, /OK — /, text)
  assert.match(text, /showing page 1/, text)
})

await check('a document in a directory with a space in its name works', async () => {
  const spaced = join(dir, 'a b')
  await mkdir(spaced, { recursive: true })
  const file = join(spaced, 'spaced.tex')
  await writeFile(file, '\\documentclass{article}\n\\begin{document}\nSpace.\n\\end{document}\n')
  const r = await look(file, { page: 1 })
  assert.match(formatResult(r), /OK — /)
})

await rm(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\n  all platform checks passed' : `\n  ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
