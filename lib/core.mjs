/**
 * latex-look core — the four senses an agent needs to see a LaTeX document:
 *   compile (multi-pass, verified) · render (PDF → PNG) · locate (PDF ↔ source)
 *   · diff (pixel-level before/after).
 *
 * Zero npm dependencies. External binaries: a TeX engine, `synctex`, and
 * Ghostscript (named `gswin64c` on Windows, which is why it is looked up by
 * `findGhostscript()` rather than by the POSIX name).
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'

const IS_WIN = process.platform === 'win32'

/**
 * Move a file onto an existing destination.
 *
 * `rename` replaces the target on POSIX and fails with EEXIST/EPERM on Windows,
 * where a rename to an existing path is refused. The snapshot that keeps
 * "compare to previous" honest is written every build onto a fixed name, so on
 * Windows it failed on the second build and after — silently, because the caller
 * has to tolerate a missing snapshot. Unlink first, and retry briefly: an
 * antivirus or an indexer holding the old file open is a matter of milliseconds.
 */
export async function replaceFile(from, to) {
  // Check the source before touching the destination. `rm` runs first because Windows
  // refuses to rename onto an existing path, but if the source is missing that order
  // destroys the last good file and then fails: `replaceFile(prevTmp, prevCommitted)`
  // with no pre-build snapshot deleted the committed baseline and returned ENOENT, so
  // a build that wrote no snapshot also lost the one it had. A missing source is a
  // no-op, not a wipe.
  try {
    await stat(from)
  } catch {
    return false
  }
  const attempts = IS_WIN ? 4 : 1
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(to, { force: true })
      await rename(from, to)
      return true
    } catch (err) {
      last = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 40 * (i + 1)))
    }
  }
  if (last && last.code !== 'ENOENT') throw last
  return false
}

/** Content identity survives restored timestamps, equal sizes and clock skew. */
async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// Small, bounded caches for the expensive whole-document Ghostscript passes.
const wholeDocCache = new Map()

async function cachedByPdf(key, pdf, produce) {
  const stamp = await fileDigest(pdf)
  const cacheKey = `${key}|${pdf}|${stamp}`
  if (wholeDocCache.has(cacheKey)) return wholeDocCache.get(cacheKey)
  const value = await produce()
  // Four documents is more than any session works on at once, and bounds the
  // memory a long session can hold.
  if (wholeDocCache.size >= 4) wholeDocCache.delete(wholeDocCache.keys().next().value)
  wholeDocCache.set(cacheKey, value)
  return value
}

export const ENGINES = ['xelatex', 'lualatex', 'pdflatex', 'latexmk', 'tectonic']

// ---------------------------------------------------------------------------
// process helper
// ---------------------------------------------------------------------------

export function run(cmd, args, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((done) => {
    let settled = false
    let timer = null
    const finish = (v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      done(v)
    }
    let child
    try {
      // windowsHide: without it every xelatex and gs call flashes a console window.
      child = spawn(cmd, args, { cwd, detached: !IS_WIN, windowsHide: true })
    } catch (err) {
      return finish({ code: null, stdout: '', stderr: String(err.message), error: String(err.message) })
    }
    let stdout = ''
    let stderr = ''
    // A negative PID is the POSIX process group; Windows has no such thing, and
    // child.kill there terminates one process while latexmk's children keep running
    // and keep the .pdf open. taskkill /T is the only way to take the whole tree.
    const killTree = () => {
      if (IS_WIN) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
        try { child.kill('SIGKILL') } catch {}
        return
      }
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    if (timeoutMs > 0) timer = setTimeout(() => { killTree(); finish({ code: null, stdout, stderr, timedOut: true }) }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message), error: String(e.message) }))
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }))
  })
}

/** Where TeX lives when the installer kept it off PATH, per platform. */
const TEX_DIRS = IS_WIN
  ? [
      'C:\\texlive\\2025\\bin\\windows',
      'C:\\texlive\\2024\\bin\\windows',
      'C:\\texlive\\2023\\bin\\windows',
      'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
      join(process.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
      join(process.env.APPDATA || '', 'TinyTeX', 'bin', 'windows'),
      join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'TinyTeX', 'bin', 'windows'),
    ]
  : ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']

/**
 * Resolve an executable the way the shell would.
 *
 * The first version split PATH on ':' — correct everywhere except the platform
 * this was then reported broken on, where the separator is ';'. On Windows it also
 * has to try the PATHEXT suffixes: there is no file called `xelatex` there, only
 * `xelatex.exe`, so every lookup fell through to the bare name and every caller
 * inherited whatever the spawn did with it.
 *
 * Exported with injectable env/platform so the win32 branches are covered by a
 * test that runs on macOS.
 */
export function resolveBinary(cmd, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const win = platform === 'win32'
  const delimiter = win ? ';' : ':'
  const exts = win ? (env.PATHEXT ? env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT', '.COM']) : ['']
  const home = env.USERPROFILE || env.HOME || ''
  const extra = win
    ? [
        'C:\\texlive\\2025\\bin\\windows',
        'C:\\texlive\\2024\\bin\\windows',
        'C:\\texlive\\2023\\bin\\windows',
        'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
        join(env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
        join(home, 'AppData', 'Roaming', 'TinyTeX', 'bin', 'windows'),
        join(env.APPDATA || '', 'TinyTeX', 'bin', 'windows'),
      ]
    : ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  const dirs = [...(env.PATH || env.Path || '').split(delimiter), ...extra]
  // A command that already carries a path or an extension is used as given.
  if (/[\\/]/.test(cmd)) return exists(cmd) ? cmd : cmd
  for (const d of dirs) {
    if (!d) continue
    for (const ext of exts) {
      const p = join(d, cmd + ext)
      if (exists(p)) return p
    }
  }
  return cmd
}

export function findBinary(cmd) {
  return resolveBinary(cmd)
}

/**
 * Ghostscript's executable name. On Windows it is `gswin64c.exe` (or `gswin32c`),
 * never `gs` — the installer puts it under `C:\Program Files\gs\gs10.0X.X\bin`.
 * Asking for `gs` there fails with ENOENT, which every later step reports as
 * "ghostscript is missing" even though it is installed.
 */
export const GS_NAMES = IS_WIN ? ['gswin64c', 'gswin32c', 'gs'] : ['gs']

export function findGhostscript(opts = {}) {
  const win = (opts.platform || process.platform) === 'win32'
  const names = win ? ['gswin64c', 'gswin32c', 'gs'] : ['gs']
  const resolved = names.map((n) => ({ n, p: resolveBinary(n, opts) }))
  const hit = resolved.find((r) => r.p !== r.n)
  if (hit) return hit.p
  // Windows installers default to "C:\Program Files\gs\gs10.05.1\bin", whose
  // version number nobody can guess: glob the version directory.
  if (win) {
    const roots = ['C:\\Program Files\\gs', 'C:\\Program Files (x86)\\gs']
    for (const root of roots) {
      let versions = []
      try { versions = readdirSync(root).sort().reverse() } catch { continue }
      for (const v of versions) {
        for (const n of ['gswin64c.exe', 'gswin32c.exe']) {
          const p = join(root, v, 'bin', n)
          try { if (existsSync(p)) return p } catch {}
        }
      }
    }
  }
  return names[names.length - 1]
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

const AUX = ['.aux', '.toc', '.out', '.lof', '.lot', '.bbl', '.idx', '.gls']
const LOCAL_EXTENSIONS = {
  usepackage: '.sty', documentclass: '.cls', bibliography: '.bib', bibliographystyle: '.bst', addbibresource: '.bib',
}

// Keep line numbers and escaped percent signs. A pair of backslashes consumes
// itself, so a following percent still introduces a comment.
function withoutComments(source) {
  return source.replace(/\\[^\r\n]|%[^\r\n]*/g, token => token[0] === '%' ? '' : token)
}

async function* texSources(texPath, { activeOnly = false } = {}) {
  const main = resolve(texPath)
  const dir = dirname(main)
  const files = new Set([main])
  let includes = null
  // Set iteration also visits newly added entries, once each, including cycles.
  for (const file of files) {
    const source = withoutComments(await readFile(file, 'utf8').catch(() => ''))
    if (activeOnly && file === main) includes = includedChapters(source, dir)
    for (const m of source.matchAll(/\\(input|include)\s*\{([^}]+)\}/g)) {
      const name = m[2].trim()
      if (m[1] === 'include' && includes && !includes.has(resolve(dir, name.replace(/\.tex$/i, '')))) continue
      files.add(resolve(dir, name.endsWith('.tex') ? name : name + '.tex'))
    }
    yield { file, source }
  }
}

async function collectReachable(texPath) {
  const dir = dirname(resolve(texPath))
  const files = new Set()
  const graphicsDirs = new Set()
  for await (const { file, source: src } of texSources(texPath, { activeOnly: true })) {
    files.add(file)
    // Also check literal references on every lookup. A local package can be
    // added after the previous build used the TeX distribution's copy.
    for (const m of src.matchAll(/\\(usepackage|documentclass|bibliography|bibliographystyle|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      const ext = LOCAL_EXTENSIONS[m[1]]
      for (const part of m[2].split(',')) {
        const name = part.trim()
        const path = resolve(dir, name.endsWith(ext) ? name : name + ext)
        if (existsSync(path)) files.add(path)
      }
    }
    for (const gm of src.matchAll(/\\graphicspath\s*\{([\s\S]*?)\}\s*(?=%|\n|$)/g)) {
      for (const dm of gm[1].matchAll(/\{([^}]*)\}/g)) {
        const rel = dm[1].trim()
        if (rel) graphicsDirs.add(resolve(dir, rel))
      }
    }
    for (const m of src.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const raw = m[1].trim()
      const exts = ['.png', '.jpg', '.jpeg', '.pdf', '.eps']
      let found = false
      for (const base of [dir, ...graphicsDirs]) {
        for (const cand of [raw, ...exts.map((e) => raw + e)]) {
          const p = resolve(base, cand)
          if (existsSync(p)) { files.add(p); found = true; break }
        }
        if (found) break
      }
    }
  }
  return files
}

// The TeX recorder knows which files macros, classes and packages actually
// opened. Save project-relative names with the successful build so deleting or
// replacing the .fls later cannot silently drop a dependency from a cache hit.
async function recordedProjectInputs(texPath) {
  const dir = dirname(texPath)
  const fls = await readFile(texPath.replace(/\.tex$/i, '.fls'), 'utf8')
  const pwd = /^PWD (.+)$/m.exec(fls)?.[1] || dir
  const inputs = new Set()
  for (const m of fls.matchAll(/^INPUT (.+)$/gm)) {
    const name = relative(pwd, resolve(pwd, m[1]))
    if (name && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)) inputs.add(name)
  }
  return [...inputs]
}

async function sourceSignature(texPath, tag, recordedInputs) {
  const main = resolve(texPath)
  const dir = dirname(main)
  const stem = basename(main).replace(/\.tex$/i, '')
  const files = await collectReachable(main)
  for (const input of recordedInputs) files.add(resolve(dir, input))
  for (const e of AUX) files.add(join(dir, stem + e))
  const h = createHash('sha1')
  h.update(JSON.stringify(tag))
  for (const f of [...files].sort()) {
    let s = null
    try { s = await stat(f) } catch {}
    h.update(`\n${f}\u0000${s ? s.mtimeMs : '-'}\u0000${s ? s.size : '-'}`)
    if (s?.isFile()) h.update(await fileDigest(f))
  }
  return h.digest('hex')
}

async function auxSignature(texPath) {
  const base = texPath.replace(/\.tex$/i, '')
  const parts = []
  for (const ext of AUX) {
    try {
      const s = await stat(base + ext)
      if (s.isFile()) parts.push(ext + ':' + (await readFile(base + ext, 'utf8')))
    } catch {}
  }
  return createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

function splitFileLine(s) {
  const m = /^(.+?\.(?:tex|sty|cls|ltx)):(\d+):\s*(.*)$/.exec(s)
  if (m) return { file: m[1], line: Number(m[2]), message: m[3].trim() }
  return { file: null, line: null, message: String(s).trim() }
}

/**
 * Parse engine output into errors and warnings.
 * Handles tectonic's structured `error: file:line: msg` stderr, the classic
 * `! msg` + `l.<n>` transcript, LaTeX/Package/Class warnings, and the
 * Overfull/Underfull box diagnostics that make a page look wrong.
 */
export function parseProblems(tex) {
  const errors = []
  const warnings = []
  const seen = new Set()
  const lines = String(tex).split(/\r?\n/)

  const push = (arr, item) => {
    const key = `${item.file || ''}|${item.line || ''}|${item.message}`
    if (seen.has(key)) return
    seen.add(key)
    arr.push(item)
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    // tectonic / rust-style structured stderr
    const err = /^error:\s*(.+)$/.exec(raw)
    if (err) { push(errors, { severity: 'error', ...splitFileLine(err[1]) }); continue }

    const warn = /^warning:\s*(.+)$/.exec(raw)
    if (warn) { push(warnings, { severity: 'warning', ...splitFileLine(warn[1]) }); continue }

    // Classic engines are run with -file-line-error, so their errors arrive as
    // `./doc.tex:12: Undefined control sequence.` and never carry a `! ` prefix.
    // Without this branch a failing compile parsed as zero problems, and the
    // tool reported FAILED with no explanation at all.
    const ffl = /^(.+?\.(?:tex|sty|cls|ltx|def|cfg|clo)):(\d+):\s*(.+)$/.exec(raw)
    if (ffl && !/Warning/i.test(ffl[3])) {
      push(errors, { severity: 'error', file: ffl[1], line: Number(ffl[2]), message: ffl[3].trim().slice(0, 240) })
      continue
    }

    // classic bang error, with the line number on a following `l.<n>` line
    if (/^! /.test(raw)) {
      let line = null
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const m = /^l\.(\d+)/.exec(lines[j])
        if (m) { line = Number(m[1]); break }
      }
      push(errors, { severity: 'error', file: null, line, message: raw.slice(2).trim() })
      continue
    }

    // boxes that overflow the text block — the usual cause of an ugly page
    const box = /^(Overfull|Underfull)\s+\\([hv])box\b(.*)$/.exec(raw)
    if (box) {
      push(warnings, {
        severity: 'warning',
        file: null,
        line: null,
        kind: `${box[1].toLowerCase()}-${box[2]}box`,
        message: raw.trim().slice(0, 240),
      })
      continue
    }

    const w = /^(LaTeX Warning:|Package .+? Warning:|Class .+? Warning:|pdfTeX warning|LaTeX Font Warning:)\s*(.*)$/.exec(raw)
    if (w) {
      push(warnings, { severity: 'warning', file: null, line: null, message: `${w[1]} ${w[2]}`.trim().slice(0, 240) })
    }
  }

  return { errors: errors.slice(0, 40), warnings: warnings.slice(0, 40) }
}

function needsRerun(text) {
  return /Label\(s\) may have changed|Rerun to get (cross-references|outlines|citations) right|There were undefined references|Package rerunfilecheck Warning/i.test(text)
}

/**
 * Run the external tools a document asks for (glossaries, index, bibliography).
 * Skipping them is the same class of silent failure as an empty TOC: the PDF
 * builds cleanly, but \printglossaries shows stale or empty data.
 */
async function runAuxTools(texPath, dir, stem) {
  const ran = []
  const call = async (tool, args) => {
    const r = await run(findBinary(tool), args, { cwd: dir, timeoutMs: 180000 })
    ran.push({ tool, ok: r.code === 0, code: r.code })
    return r.code === 0
  }
  const has = async (ext) => {
    try {
      const s = await stat(join(dir, stem + ext))
      return s.isFile() && s.size > 0
    } catch { return false }
  }

  // Decide from the artifacts pass 1 wrote, not from the root file's text: in a
  // multi-file project \makeglossaries usually lives in an \input'ed preamble,
  // so scanning only the root file silently misses it.
  if (await has('.glo')) await call('makeglossaries', [stem])
  else if (await has('.idx')) await call('makeindex', [stem + '.idx'])

  if (await has('.bcf')) {
    await call('biber', [stem])
  } else {
    const aux = await readFile(join(dir, stem + '.aux'), 'utf8').catch(() => '')
    if (/\\bibdata\{/.test(aux)) await call('bibtex', [stem])
  }

  return ran
}

/**
 * Compile with enough passes for TOC/cross-refs, then verify the PDF.
 * Always injects -synctex=1 so `locate` works afterwards.
 */
// --- one build per document at a time --------------------------------------
// Two compiles of the same document at once share its .aux/.toc files and destroy
// each other: racing two processes on this very book, one of them died with an
// unreadable error and produced no PDF. Serialise in-process with a promise queue
// (the plugin host can be handed two tool calls at once) and across processes with
// a lock file (a CLI run next to a plugin build).
const docQueues = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function serialise(key, fn) {
  const prev = docQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(() => {}, () => {})
  docQueues.set(key, tail)
  tail.then(() => { if (docQueues.get(key) === tail) docQueues.delete(key) })
  return run
}

async function withDocLock(file, fn) {
  const key = createHash('sha1').update(resolve(file)).digest('hex').slice(0, 16)
  return serialise(key, () => withFileLock(key, fn))
}

async function withFileLock(key, fn) {
  const dir = join(tmpdir(), 'latex-look-locks')
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, `${key}.lock`)
  const deadline = Date.now() + 180000
  let fd = null
  for (;;) {
    try {
      fd = await open(lockPath, 'wx')
      await fd.writeFile(String(process.pid))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // A crashed build leaves the lock behind. Trust its PID over the clock, so a
      // killed run does not wedge the document for ten minutes.
      let stale = false
      try {
        const pid = Number((await readFile(lockPath, 'utf8')).trim())
        if (pid > 0) {
          try { process.kill(pid, 0) } catch (err) { if (err.code === 'ESRCH') stale = true }
        }
      } catch { stale = true }
      if (!stale) {
        try {
          const st = await stat(lockPath)
          if (Date.now() - st.mtimeMs > 600000) stale = true
        } catch {}
      }
      if (stale) { await rm(lockPath, { force: true }); continue }
      if (Date.now() > deadline) {
        throw new Error('another build of this document is still running; gave up waiting after 3 minutes')
      }
      await sleep(250)
    }
  }
  try {
    return await fn()
  } finally {
    try { await fd.close() } catch {}
    try { await rm(lockPath, { force: true }) } catch {}
  }
}

export async function compile(texPath, options = {}) {
  return withDocLock(texPath, () => compileDoc(texPath, options))
}

async function compileDoc(texPath, { engine, maxPasses = 3, timeoutMs = 120000, noCache = false } = {}, beforeCompile) {
  const file = resolve(texPath)
  await stat(file)
  const dir = dirname(file)
  const base = basename(file)
  const stem = base.replace(/\.tex$/i, '')
  const auto = !engine || engine === 'auto'
  const preferred = auto || engine === 'latexmk' ? await documentEngine(file) : null
  const want = auto ? autoEngine(preferred) : engine
  const bin = findBinary(want)
  const pdf = join(dir, stem + '.pdf')

  const classic = ['xelatex', 'lualatex', 'pdflatex'].includes(want)
  const args = want === 'tectonic'
    ? ['--synctex', '--keep-logs', base]
    : ['-recorder', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', base]
  if (want === 'latexmk') {
    args.unshift(preferred && preferred !== 'pdflatex' ? '-' + preferred : '-pdf')
  }

  let passes = 0
  let last = null
  let prevSig = null
  let aux = []
  let auxDone = false
  const limit = classic ? Math.max(1, Math.min(10, maxPasses)) : 1
  const tocPath = join(dir, stem + '.toc')
  // A .toc can exist and contain only \relax/package setup. Bytes are not
  // entries: one pass over that file still typesets an empty contents page.
  const tocBefore = await readFile(tocPath, 'utf8').catch(() => '')
  const tocEntriesBefore = (tocBefore.match(/^[ \t]*\\contentsline\b/gm) || []).length

  // Recompiling an unchanged document is pure latency: a 208-page book costs ~16s
  // per call and an agent typically looks at a dozen pages in a row. Remember the
  // shape of every input and reuse the PDF when none of them moved.
  const cacheDir = join(tmpdir(), 'latex-look-cache')
  const cachePath = join(cacheDir, createHash('sha1').update(file).digest('hex') + '.json')
  const cacheTag = { v: 2, want, limit }
  try {
    const hit = noCache ? null : JSON.parse(await readFile(cachePath, 'utf8'))
    if (hit?.want === want && Array.isArray(hit.inputs) &&
        hit.sig === await sourceSignature(file, cacheTag, hit.inputs) && hit.pdfDigest === await fileDigest(pdf)) {
      // The PDF digest and source/aux signature cover the page count and TOC.
      // Retry inspection if the previous build could not measure the page count.
      const art = hit.artifacts?.valid && hit.artifacts.pages > 0 ? hit.artifacts : await inspectPdf(pdf, file)
      if (art.exists && art.valid) {
        return {
          engine: want, passes: hit.passes || 0, code: 0, pdf,
          problems: [], warnings: hit.warnings || [], artifacts: art,
          log: '', ok: true, fatal: null, aux: hit.aux || [], cached: true,
        }
      }
    }
  } catch {}

  await beforeCompile?.()
  while (passes < limit) {
    last = await run(bin, args, { cwd: dir, timeoutMs })
    passes += 1
    if (last.error) { last.fatal = `failed to run ${want}: ${last.error}`; break }
    if (last.timedOut) {
      // A pass that blows the budget is nearly always a loop, not a slow machine:
      // ulem's \\uline inside a tabular is the classic one. Say so, and say how to raise it.
      last.fatal =
        `pass ${passes} did not finish within ${Math.round(timeoutMs / 1000)}s — an infinite loop in a macro is the usual cause ` +
        `(ulem's \\uline inside a tabular, or a \\loop with no exit). Raise timeoutSeconds if the document is genuinely that slow.`
      break
    }
    if (last.code !== 0) break
    if (!classic) break
    // Glossaries/index/bibliography run once, after pass 1 has written .glo/.idx,
    // so the remaining passes pick up the regenerated data.
    if (!auxDone) { aux = await runAuxTools(file, dir, stem); auxDone = true }
    const sig = await auxSignature(file)
    const log = (await readFile(join(dir, stem + '.log'), 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
    if (prevSig !== null && sig === prevSig && !needsRerun([last.stdout, last.stderr, log].join('\n'))) break
    prevSig = sig
  }

  const log = (await readFile(join(dir, stem + '.log'), 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
  const parsed = parseProblems([log, last?.stdout || '', last?.stderr || ''].join('\n'))
  const art = await inspectPdf(pdf, file)
  const problems = [...parsed.errors]
  for (const step of aux.filter((a) => !a.ok)) {
    problems.push({ severity: 'error', file: null, line: null,
      message: `${step.tool} failed (exit ${step.code ?? 'unavailable'}); its generated output could not be refreshed` })
  }
  // The reason a pass was killed (an infinite loop, or the engine could not be run at
  // all) used to live only in `fatal`, so the reader saw "no PDF was produced" and had
  // to guess why. Put it first: it is the only message that says what to do.
  if (last?.fatal) problems.unshift({ severity: 'error', file: null, line: null, message: last.fatal })
  if (!art.exists) {
    problems.push({ severity: 'error', file: null, line: null, message: `no PDF was produced (expected ${pdf})` })
  } else if (!art.valid) {
    problems.push({ severity: 'error', file: null, line: null, message: 'the produced PDF is invalid or truncated (missing %PDF- header or %%EOF marker)' })
  }
  if (art.tocExpected && !art.tocEntries) {
    problems.push({
      severity: 'error', file: null, line: null,
      message: 'the document declares \\tableofcontents but the table of contents is EMPTY (not enough passes, or there are no numbered sections)',
    })
  }
  // The .toc file is written as sections are processed, i.e. AFTER the TOC page
  // has already been typeset. So a single-pass build still finds entries in .toc
  // while the TOC page in the PDF is blank — the exact silent failure this tool
  // exists to catch. Only a pass count tells the two apart.
  //
  // And it only tells them apart for the engines whose passes this tool drives. A
  // `latexmk` or `tectonic` invocation is ONE call from here but a full convergent run
  // inside, so `passes` is 1 however many times the engine was actually run. Applying
  // the rule there reported a hard error — `the table of contents page is EMPTY ...
  // maxPasses allowed only 1` — on a document whose TOC had just been typeset
  // correctly, with exit code 2. Those engines converge themselves and say so in their
  // log; if the TOC really is empty, `tocExpected && !tocEntries` above already failed
  // the build. So the pass-count judgement applies only where we counted the passes.
  if (art.tocExpected && classic && passes < 2) {
    if (tocEntriesBefore > 0) {
      // unshift: a real book produces dozens of package warnings, and the display
      // only keeps the first few — this one must not be buried among them.
      parsed.warnings.unshift({
        severity: 'warning', file: null, line: null,
        message: `only ${passes} compile pass ran, so the table of contents is what the previous build wrote; at least 2 passes are needed for it to reflect this build — raise maxPasses`,
      })
    } else {
      problems.push({
        severity: 'error', file: null, line: null,
        message: `the table of contents page is EMPTY: \\tableofcontents needs at least 2 passes and maxPasses allowed only ${passes}`,
      })
    }
  }
  // A failing engine that yielded no parsed error must still explain itself;
  // silence here is exactly the failure mode this tool exists to prevent.
  if (last && last.code !== 0 && problems.length === 0) {
    problems.push({
      severity: 'error',
      file: null,
      line: null,
      message: `the engine exited with code ${last.code} but produced no recognisable error message; read ${join(dir, stem + '.log')}`,
    })
  }
  const ok = last?.code === 0 && !last?.timedOut && !last?.fatal && problems.length === 0

  // Only a clean build is worth remembering; a failing one is being edited right now.
  try {
    if (ok) {
      await mkdir(cacheDir, { recursive: true })
      const inputs = want === 'tectonic' ? [] : await recordedProjectInputs(file)
      const sigAfter = await sourceSignature(file, cacheTag, inputs)
      await writeFile(cachePath, JSON.stringify({
        sig: sigAfter, pdfDigest: await fileDigest(pdf), inputs, artifacts: art, want, passes, warnings: parsed.warnings, aux, at: Date.now(),
      }))
    } else {
      await rm(cachePath, { force: true })
    }
  } catch {}

  return {
    engine: want, passes, code: last?.code ?? null, pdf,
    problems, warnings: parsed.warnings, artifacts: art, log, ok, fatal: last?.fatal, aux,
  }
}

function autoEngine(requested) {
  if (requested && findBinary(requested) !== requested) return requested
  for (const e of ENGINES) {
    if (findBinary(e) !== e) return e
  }
  return 'xelatex'
}

async function documentEngine(texPath) {
  let fd
  try {
    fd = await open(texPath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
    const head = buffer.toString('utf8', 0, bytesRead)
    const magic = /^[ \t]*%[ \t]*!TeX[ \t]+(?:TS-)?program[ \t]*=[ \t]*(xelatex|lualatex|pdflatex)\b/im.exec(head)
    if (magic) return magic[1].toLowerCase()
    const preamble = withoutComments(head).split('\\begin{document}')[0]
    if (/luatexja/i.test(preamble)) return 'lualatex'
    if (/ctex|xeCJK|fontspec/.test(preamble)) return 'xelatex'
  } catch {} finally {
    await fd?.close()
  }
  return null
}

/** Escape a path for use inside a PostScript string literal: ( ) and \ end it early. */
function psString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Does any .tex reachable through \input/\include match `pattern`?
 * Scanning only the root file misses declarations that live in an included
 * preamble — the usual layout in multi-file books, where the root is a one-line
 * wrapper around \input{main}.
 */
async function anySourceMatches(texPath, pattern) {
  for await (const { source } of texSources(texPath, { activeOnly: true })) {
    if (pattern.test(source)) return true
  }
  return false
}

async function inspectPdf(pdf, texPath) {
  const info = {
    path: pdf, exists: false, valid: false, bytes: 0, pages: null,
    tocExpected: false, tocEntries: null,
  }
  let fd
  try {
    fd = await open(pdf, 'r')
    const s = await fd.stat()
    if (!s.isFile()) return info
    info.exists = true
    info.bytes = s.size
    const head = Buffer.alloc(5)
    const tail = Buffer.alloc(Math.min(2048, s.size))
    await fd.read(head, 0, head.length, 0)
    await fd.read(tail, 0, tail.length, s.size - tail.length)
    info.valid = head.toString('latin1') === '%PDF-' && tail.includes('%%EOF')
  } catch {} finally {
    await fd?.close()
  }
  if (info.valid) {
    const r = await run(findGhostscript(), [
      '-q', '-dNODISPLAY', '-dNOSAFER', '-c',
      `(${psString(pdf)}) (r) file runpdfbegin pdfpagecount = quit`,
    ])
    const n = parseInt((r.stdout || '').trim(), 10)
    if (r.code === 0 && Number.isFinite(n)) info.pages = n
  }

  // A document that asks for a table of contents and gets an empty one is the
  // classic silent failure: clean log, exit code 0, blank TOC page. The
  // declaration often lives in an \input'ed preamble, so scan the whole tree.
  if (texPath) {
    info.tocExpected = await anySourceMatches(texPath, /\\tableofcontents\b/)
    if (info.tocExpected) {
      const toc = await readFile(String(texPath).replace(/\.tex$/i, '.toc'), 'utf8').catch(() => '')
      info.tocEntries = (toc.match(/^[ \t]*\\contentsline\b/gm) || []).length
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * Rasterise every page in ONE gs invocation and measure the ink profile of each.
 *
 * A one-page-at-a-time loop is 200+ process spawns on a book; gs writes the whole
 * sequence in a single run (the `%04d` in the output name is the page counter).
 *
 * Rows are "ink" when they hold at least `minInkPixels` dark pixels, so a stray
 * anti-aliasing speck cannot extend the text block by a millimetre.
 */
async function inkProfiles(pdf, opts = {}) {
  const { dpi = 72, minInkPixels = 2, dark = 200 } = opts
  // Rasterising a book is seconds, and audit is the kind of call a session makes
  // repeatedly while fixing pages one at a time; the PDF digest is the key, so an
  // edit still invalidates it.
  return cachedByPdf(`ink:${dpi}:${minInkPixels}:${dark}`, pdf, () =>
    inkProfilesUncached(pdf, { dpi, minInkPixels, dark }),
  )
}

async function inkProfilesUncached(pdf, { dpi = 72, minInkPixels = 2, dark = 200 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'latex-look-audit-'))
  try {
    const r = await run(findGhostscript(), [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', `-r${dpi}`,
      '-sOutputFile=' + join(dir, 'p%04d.ppm'), pdf,
    ])
    if (r.code !== 0) throw new Error(`gs failed while profiling pages: ${r.stderr || r.stdout}`)
    const files = (await readdir(dir)).filter(f => /^p\d+\.ppm$/.test(f)).sort(byPageNumber)
    const profiles = []
    for (const f of files) {
      const img = parsePpm(await readFile(join(dir, f)))
      if (!img) throw new Error(`gs produced an incomplete page raster: ${f}`)
      const { width, height, data } = img
      const rows = new Uint8Array(height)
      const ink = []
      for (let y = 0; y < height; y++) {
        let count = 0
        const end = (y + 1) * width * 3
        for (let i = y * width * 3; i < end; i += 3) {
          if (data[i] < dark && data[i + 1] < dark && data[i + 2] < dark) {
            if (++count >= minInkPixels) {
              rows[y] = 1
              ink.push(y)
              break
            }
          }
        }
      }
      profiles.push({ height, rows, ink })
      await rm(join(dir, f))
    }
    return profiles
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Find the pages a reader would call broken: a big hole at the page bottom, a page
 * that starts far below the top (a lone caption or a one-line paragraph), or a
 * nearly empty page.
 *
 * The reference text block is taken from the document itself (the highest and
 * lowest ink any page reaches), so no margin has to be guessed: a page whose last
 * ink sits 60 mm above the lowest ink of the whole book is a hole by any measure.
 *
 * @param {number} [opts.blankMm] a bottom hole this deep (mm) is reported
 */
export async function auditLayout(pdf, {
  blankMm = 30, minCoverage = 0.02, withText = true, furniture = true,
} = {}) {
  const profiles = await inkProfiles(pdf, { dpi: 72 })
  const n = profiles.length
  if (!n) return { pages: 0, findings: [], calibration: 'the PDF has no pages, so there is no reference text block to measure' }

  // Running heads, rules and page numbers sit at nearly the same height on every
  // page; body lines do not. A row that carries ink on >80% of the pages AND lies in
  // the outer 8% of the sheet is furniture, not content. Without this step a book's
  // page number becomes "the lowest ink of the book" and every single page looks
  // like it stops short.
  let furnitureRows = new Set()
  if (furniture) {
    const height = profiles[0].height
    const counts = new Array(height).fill(0)
    for (const p of profiles) for (const y of p.ink) counts[y]++
    for (let y = 0; y < height; y++) {
      const inBand = y < height * 0.08 || y > height * 0.92
      // 0.35, not 0.8: a running head is set in different words on different pages,
      // so its ascender rows light up on 70% of pages and its descender rows on 20%.
      // A per-row threshold high enough to keep body text out would let the head
      // through, and then "the deepest text of the book" becomes the page number.
      if (inBand && counts[y] / n > 0.35) furnitureRows.add(y)
    }
  }

  // A row mask is not enough: on a page whose running head has an ascender one row
  // higher than its neighbours', that row is *not* a majority row, so the page keeps
  // a "content top" up in the header. Once ANY row of the head/foot is recognised, the
  // whole band it belongs to is furniture.
  const height = profiles[0].height
  const headRows = [...furnitureRows].filter((y) => y < height * 0.08)
  const footRows = [...furnitureRows].filter((y) => y > height * 0.92)
  const headBandEnd = headRows.length ? Math.max(...headRows) + 2 : -1
  const footBandStart = footRows.length ? Math.min(...footRows) - 2 : height + 1
  const isFurniture = (y) => y <= headBandEnd || y >= footBandStart

  const pages = profiles.map((p, i) => {
    const keep = p.ink.filter((y) => !isFurniture(y))
    const top = keep.length ? keep[0] : null
    const bottom = keep.length ? keep[keep.length - 1] : null
    let gap = { height: 0, start: null }
    if (top != null) {
      let runStart = null
      for (let y = top; y <= bottom; y++) {
        if (isFurniture(y)) continue
        if (!p.rows[y]) { if (runStart == null) runStart = y }
        else {
          if (runStart != null && y - runStart > gap.height) gap = { height: y - runStart, start: runStart }
          runStart = null
        }
      }
    }
    return { page: i + 1, top, bottom, gap, coverage: keep.length / p.height, height: p.height }
  })

  const bounded = pages.filter((p) => p.top != null)
  if (!bounded.length) {
    return { pages: n, findings: [], furnitureRows: furnitureRows.size, calibration: 'every page is blank once page furniture is removed, so there is no reference text block to measure' }
  }
  const percentile = (arr, q) => {
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]
  }
  // The reference text block: how far the fullest pages reach. Percentiles rather
  // than min/max, so one deliberately short title page cannot redefine the block.
  const blockTop = percentile(bounded.map((p) => p.top), 0.05)
  const blockBottom = percentile(bounded.map((p) => p.bottom), 0.95)
  const mm = (pt) => (pt / 72) * 25.4
  const findings = []
  for (const p of pages) {
    if (p.top == null) {
      findings.push({ kind: 'blank-page', page: p.page, mm: mm(p.height), detail: 'no ink at all' })
      continue
    }
    if (p.coverage < minCoverage) {
      findings.push({ kind: 'nearly-empty', page: p.page, mm: mm(p.bottom - p.top), detail: `only ${(p.coverage * 100).toFixed(1)}% of the page carries ink` })
      continue
    }
    const bottomHole = blockBottom - p.bottom
    const topHole = p.top - blockTop
    if (mm(bottomHole) >= blankMm) {
      // A chapter or a section ends here, or content was pushed off the page. The
      // difference is visible: when a heading starts the next page it is set lower
      // than body text, so the next page begins well below the normal top. If the
      // next page starts at the normal top, the same section is still running and
      // this page simply stopped early — that is the hole a reader complains about.
      const next = pages[p.page] // pages[] is 0-based, so this is page+1
      const blockHeight = blockBottom - blockTop
      const continues = next && next.top != null && next.top - blockTop < blockHeight * 0.3
      findings.push({
        kind: continues ? 'bottom-hole' : 'section-end',
        page: p.page,
        mm: mm(bottomHole),
        detail: continues
          ? `content stops ${mm(bottomHole).toFixed(0)} mm above the deepest text of the book, and the next page resumes at the normal top — the text did not end here, it was pushed`
          : `content stops ${mm(bottomHole).toFixed(0)} mm above the deepest text of the book, and the next page opens a new chapter or section`,
      })
    } else if (mm(topHole) >= blankMm) {
      findings.push({ kind: 'starts-low', page: p.page, mm: mm(topHole), detail: `page starts ${mm(topHole).toFixed(0)} mm below the highest text of the book` })
    }
    if (mm(p.gap.height) >= Math.max(blankMm, 35)) {
      findings.push({ kind: 'hole-inside', page: p.page, mm: mm(p.gap.height), detail: `${mm(p.gap.height).toFixed(0)} mm of blank space inside the content` })
    }
  }
  // "The page stops short and the next page opens with a caption" is the single most
  // common complaint a reader makes about a LaTeX book: the figure did not fit, so it
  // moved. Naming the figure turns the finding from a measurement into a lead.
  if (withText && findings.length) {
    const texts = await pageTexts(pdf).catch(() => null)
    for (const [i, f] of findings.entries()) {
      const nextText = texts?.[f.page] || ''
      const opening = nextText.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3)
      for (const line of opening) {
        const cap = line.match(/^([^\s\d]{1,6})\s*(\d+)\s*[-–—.]\s*(\d+)\s+\S/)
        if (cap) { f.nextPageOpensWith = `${cap[1]} ${cap[2]}-${cap[3]}`; break }
      }
      // The batch already includes this page. Retain the bounded single-page
      // fallback only when extraction of the whole document failed.
      let t = texts?.[f.page - 1]
      if (!texts && i < 40) t = await pdfPageText(pdf, f.page)
      const lines = (t || '').split('\n').map(l => l.trim()).filter(l => l && !/^[0-9ivxlc]+$/i.test(l))
      if (lines.length) {
        f.lastLine = lines[lines.length - 1].slice(0, 60)
        f.firstLine = lines[0].slice(0, 60)
      }
    }
  }
  // A document with one or two pages has no reference to measure against: the block
  // bottom IS the page bottom, so every page looks full and the audit reports no
  // holes without ever having looked for one. Say that instead of returning a pass.
  const calibration = n < 3
    ? `the audit measures pages against each other, and this document has ${n} page(s); a page cannot be the reference for itself`
    : null
  return { pages: n, blockTop, blockBottom, furnitureRows: furnitureRows.size, findings, calibration }
}

export async function renderPage(pdf, page, { dpi = 140, outDir = tmpdir(), raster } = {}) {
  await mkdir(outDir, { recursive: true })
  // gs treats %d in -sOutputFile as a page-number template, so a literal % in a
  // filename would quietly write a different file and look like a render failure.
  const label = basename(pdf).replace(/\.pdf$/i, '').replace(/%/g, '_')
  const out = join(outDir, `${label}-${randomUUID()}-p${page}@${dpi}dpi.png`)
  if (raster) {
    const png = encodePng(raster.width, raster.height, raster.data, dpi)
    await writeFile(out, png)
    return { path: out, bytes: png.length, width: raster.width, height: raster.height }
  }
  const r = await run(findGhostscript(), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', `-r${dpi}`,
    '-dFirstPage=' + page, '-dLastPage=' + page, '-sOutputFile=' + out, pdf,
  ])
  if (r.code !== 0) throw new Error(`gs render failed: ${r.stderr || r.stdout}`)
  if (!existsSync(out)) {
    throw new Error(`gs produced no image for page ${page} of ${basename(pdf)} (the page number is probably out of range)`)
  }
  const s = await stat(out)
  return { path: out, bytes: s.size, width: null, height: null }
}

async function renderPpm(pdf, page, dpi) {
  // Unique per call: the name used to be `<pid>-<Date.now()>-p<page>.ppm`, and two
  // renders of the same page within one millisecond (the before/after pair, or the
  // probe plus the ink raster) wrote to one file and read each other's pixels.
  const out = join(tmpdir(), `latex-look-${process.pid}-${randomUUID()}-p${page}.ppm`)
  const r = await run(findGhostscript(), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', `-r${dpi}`,
    '-dFirstPage=' + page, '-dLastPage=' + page, '-sOutputFile=' + out, pdf,
  ])
  // gs exits 0 having written nothing when the page does not exist, so `readFile`
  // threw ENOENT straight out of the tool: `--page 99 --point 80,110` on a two-page
  // document died with a bare `ENOENT ... -p99.ppm` instead of saying the page is out
  // of range. A page that is not there is an answer, not a crash.
  let buf = null
  try { buf = await readFile(out) } catch { buf = null }
  await rm(out, { force: true })
  if (r.code !== 0 || !buf) return null
  return parsePpm(buf)
}

/**
 * What is actually drawn at this PDF point?
 *
 * SyncTeX answers "which source line is nearest this point", which is the right
 * question for text and the wrong one for a rule: a rule drawn by `fancyhdr` has
 * no line of its own, so inverse search returns whichever box happens to be
 * closest — often `\end{document}`. Someone asking "remove the line at the top of
 * the page" then gets a confident, wrong answer.
 *
 * So measure the ink instead of trusting the mapping: a long thin dark run is a
 * rule, ink in a small neighbourhood is text, and neither is blank.
 */
export function classifyInk(raster, { x, y, dpi = 72 } = {}) {
  if (!raster) return null
  const px = Math.round((x / 72) * dpi)
  const py = Math.round((y / 72) * dpi)
  if (py < 0 || py >= raster.height || px < 0 || px >= raster.width) return { kind: 'outside' }
  const dark = (xx, yy) => {
    const o = (yy * raster.width + xx) * 3
    return raster.data[o] < 200 && raster.data[o + 1] < 200 && raster.data[o + 2] < 200
  }
  // Longest unbroken run of ink in a row, not the fraction of the row that is inked.
  // A rule is one continuous run; a line of text is many short ones. Fraction alone
  // called a 30%-wide table rule "nothing here", and silence reads as "no feature".
  const rowRun = (yy) => {
    let best = 0
    let start = 0
    for (let xx = 0; xx <= raster.width; xx++) {
      if (xx < raster.width && dark(xx, yy)) continue
      if (px >= start - 4 && px <= xx + 4) best = Math.max(best, xx - start)
      start = xx + 1
    }
    return best / raster.width
  }
  const band = Math.max(1, Math.round((4 / 72) * dpi))
  let best = { run: 0, row: py }
  for (let yy = Math.max(0, py - band); yy <= Math.min(raster.height - 1, py + band); yy++) {
    const run = rowRun(yy)
    if (run > best.run) best = { run, row: yy }
  }
  let thin = true
  for (const yy of [best.row - 3, best.row + 3]) {
    if (yy < 0 || yy >= raster.height) continue
    if (rowRun(yy) > best.run * 0.6) { thin = false; break }
  }
  if (best.run >= 0.12 && thin) {
    return { kind: 'rule', span: Number(best.run.toFixed(2)), y: Number(((best.row / dpi) * 72).toFixed(1)) }
  }
  let near = 0
  for (let yy = Math.max(0, py - 4); yy <= Math.min(raster.height - 1, py + 4); yy++) {
    for (let xx = Math.max(0, px - 4); xx <= Math.min(raster.width - 1, px + 4); xx++) if (dark(xx, yy)) near++
  }
  return { kind: near > 0 ? 'text' : 'blank' }
}

/**
 * The line that draws a rule near `line`, if the source contains one.
 *
 * Null is an answer, not a failure: it means the rule comes from the page style
 * rather than from the body, which is exactly what the caller needs to know.
 */
async function findRuleCommand(file, line, radius = 4) {
  let lines
  try { lines = withoutComments(await readFile(file, 'utf8')).split(/\r?\n/) } catch { return null }
  const draws = /\\(rule|hrule|hline|toprule|midrule|bottomrule|cline|hrulefill)\b/
  for (let d = 0; d <= radius; d++) {
    for (const i of d === 0 ? [line] : [line - d, line + d]) {
      const idx = i - 1
      if (idx < 0 || idx >= lines.length) continue
      if (draws.test(lines[idx])) return { line: i, text: lines[idx].trim().slice(0, 80) }
    }
  }
  return null
}

/** Parse a binary P6 PPM. */
export function parsePpm(buf) {
  let i = 0
  const token = () => {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++
    if (buf[i] === 0x23) { while (i < buf.length && buf[i] !== 0x0a) i++; return token() }
    const start = i
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++
    return buf.subarray(start, i).toString('latin1')
  }
  if (token() !== 'P6') return null
  const w = parseInt(token(), 10)
  const h = parseInt(token(), 10)
  const maxv = parseInt(token(), 10)
  i++ // single whitespace after header
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  // A truncated raster would make diffRaster read past the buffer, produce NaN,
  // and silently report a 0% change. Refuse it instead.
  if (buf.length - i < w * h * 3) return null
  return { width: w, height: h, max: maxv, data: buf.subarray(i) }
}

/**
 * Pixel diff between two PPM rasters.
 * Returns the fraction of changed pixels and the bounding box of the change,
 * expressed in points (72/inch) so it can feed straight into `synctex edit`.
 */
export function diffRaster(a, b, dpi = 72) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null
  const n = a.width * a.height
  let changed = 0
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  const ch = 3
  for (let p = 0; p < n; p++) {
    const o = p * ch
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])
    if (d > 24) {
      changed++
      const x = p % a.width
      const y = (p - x) / a.width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!changed) return { changedRatio: 0, changedPixels: 0, bbox: null }
  const k = 72 / dpi
  return {
    changedRatio: changed / n,
    changedPixels: changed,
    bbox: {
      x: +(minX * k).toFixed(2), y: +(minY * k).toFixed(2),
      width: +((maxX - minX + 1) * k).toFixed(2), height: +((maxY - minY + 1) * k).toFixed(2),
    },
  }
}

// ---------------------------------------------------------------------------
// one picture instead of two: the page before | the page after
// ---------------------------------------------------------------------------
//
// Handing back two separate PNGs asks the reader to open both and hunt for the
// difference — for someone who only reads the PDF, that is the hard part. One
// side-by-side image answers "did it change and how" at a glance.
//
// A PNG needs no dependency: signature, IHDR, IDAT (zlib), IEND. zlib ships with
// node, so the encoder is twenty lines of chunk framing plus a CRC table.

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Encode 8-bit RGB pixels as a PNG buffer. */
export function encodePng(width, height, rgb, dpi = 72) {
  const stride = width * 3
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0, per row
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const phys = Buffer.alloc(9)
  const pixelsPerMetre = Math.round(dpi / 0.0254)
  phys.writeUInt32BE(pixelsPerMetre, 0)
  phys.writeUInt32BE(pixelsPerMetre, 4)
  phys[8] = 1
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw, { level: 4 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Compose two parsed PPM rasters: left | gutter | right, on white. */
export function sideBySide(left, right, gap = 24) {
  const width = left.width + gap + right.width
  const height = Math.max(left.height, right.height)
  const out = Buffer.alloc(width * height * 3, 0xff)
  const blit = (img, x) => {
    for (let y = 0; y < img.height; y++) {
      const from = y * img.width * 3
      img.data.copy(out, (y * width + x) * 3, from, from + img.width * 3)
    }
  }
  blit(left, 0)
  blit(right, left.width + gap)
  return { width, height, data: out }
}

// ---------------------------------------------------------------------------
// locate (SyncTeX, both directions)
// ---------------------------------------------------------------------------

/** PDF point (72/inch, origin top-left) → source location. */
export async function locateFromPoint(pdf, page, x, y) {
  const r = await run(findBinary('synctex'), ['edit', '-o', `${page}:${x}:${y}:${pdf}`])
  const out = (r.stdout || '') + (r.stderr || '')
  const input = /^Input:\s*(.+)$/m.exec(out)
  const line = /^Line:\s*(-?\d+)/m.exec(out)
  const col = /^Column:\s*(-?\d+)/m.exec(out)
  if (!input || !line || Number(line[1]) < 0) return null
  // synctex prints paths as it stored them, which can be `/tmp/./main.tex`;
  // normalise so one file does not appear under two spellings in one report.
  const file = input[1].trim().replace(/\/\.\//g, '/')
  // Carry the queried point back: a caller asking "what is at (300,118)" wants the
  // answer in the coordinates it asked about, not in the coordinates of the box.
  return { file, line: Number(line[1]), column: col ? Number(col[1]) : null, page: Number(page), x: Number(x), y: Number(y) }
}

/** Source line → PDF page and point. */
export async function locateFromLine(texPath, pdf, line) {
  const r = await run(findBinary('synctex'), ['view', '-i', `${line}:1:${texPath}`, '-o', pdf])
  const out = (r.stdout || '') + (r.stderr || '')
  const page = /^Page:\s*(\d+)/m.exec(out)
  const px = /^x:\s*([\d.]+)/m.exec(out)
  const py = /^y:\s*([\d.]+)/m.exec(out)
  if (!page || !px || !py) return null
  return { page: Number(page[1]), x: Number(px[1]), y: Number(py[1]) }
}

/**
 * Find a text anchor in the source, forward-map it to PDF coordinates, and
 * return the candidates together with their source lines.
 *
 * Searches every file reachable through literal \input/\include, not just
 * the root: a real book is root → main → chap1, so a one-level scan finds nothing
 * in it, which is exactly the case this tool exists for. Returns the hits plus how
 * many files were searched, so a miss can say something useful instead of nothing.
 */
// --- the PDF's own text layer, to check where a box really landed ------------
//
// SyncTeX records the page on which a box was BUILT. A float that TeX moves to the
// next page therefore gets the previous page's number: the revision-history table in
// the test book is on page 206, SyncTeX says 205, and page 205 is the acknowledgements.
// An agent following that number renders the wrong page and concludes the text is gone.

const pageTextCache = new Map()

/** The text layer of every page, in one gs run. */
export async function pageTexts(pdf) {
  return cachedByPdf('text', pdf, () => pageTextsUncached(pdf))
}

function byPageNumber(a, b) {
  return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
}

async function pageTextsUncached(pdf) {
  const dir = await mkdtemp(join(tmpdir(), 'latex-look-text-'))
  try {
    const r = await run(findGhostscript(), [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', '-sOutputFile=' + join(dir, 'p%04d.txt'), pdf,
    ])
    if (r.code !== 0) throw new Error(`gs text extraction failed: ${r.stderr || r.stdout}`)
    const files = (await readdir(dir)).filter(f => /^p\d+\.txt$/.test(f))
    const pages = []
    for (const f of files) {
      const index = parseInt(f.slice(1), 10) - 1
      pages[index] = await readFile(join(dir, f), 'utf8')
    }
    return Array.from(pages, text => text ?? '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Reading order of numbered things — figures, tables, equations.
 *
 * A numbered object that becomes a float can land AFTER an object with a larger
 * number that stayed inline, and the reader turns the page to see 图 3-4 before
 * 图 3-3. Nothing else in the tool looks at order, and the source order is exactly
 * what a float does not preserve.
 *
 * Only labels that START a line are counted: a caption begins its own line in the
 * text layer, while a reference in the middle of a paragraph ("如图 3-4 所示") does
 * not, and references are legitimately out of order.
 */
/**
 * Is the PDF's text layer worth reading at all?
 *
 * A PDF can carry pages whose glyphs have no Unicode mapping — a document built with
 * a font that ships no ToUnicode table. gs then emits U+FFFF for every character, and
 * a label scan finds nothing and reports "everything is in order", which is the worst
 * possible answer: it is not a failed check, it is a check that never happened.
 */
export function textLayerHealth(pages) {
  let chars = 0
  let unmapped = 0
  for (const page of pages) {
    for (const ch of String(page || '').replace(/\s/g, '')) {
      chars++
      const cp = ch.codePointAt(0)
      if (cp === 0xfffd || cp === 0xffff || cp < 0x20) unmapped++
    }
  }
  const ratio = chars === 0 ? 0 : unmapped / chars
  return {
    chars,
    unmappedRatio: Number(ratio.toFixed(3)),
    usable: chars > 0 && ratio < 0.3,
    reason: chars === 0
      ? 'the PDF carries no text layer at all (every page is a picture)'
      : ratio >= 0.3
        ? `the PDF's text layer is unreadable: ${Math.round(ratio * 100)}% of its characters are glyphs with no Unicode mapping`
        : null,
  }
}

export async function findSequence(pdf, { label = '图', maxGap = 6 } = {}) {
  const pages = await pageTexts(pdf)
  const health = textLayerHealth(pages)
  if (!health.usable) {
    // Refuse to answer rather than answer "in order" about a document whose labels
    // could not be read.
    return { labels: [], inversions: [], pages: pages.length, unreliable: health.reason, health }
  }
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Scan numeric candidates separately from supported labels. Otherwise 3.2b is
  // truncated to 3.2 (then merged with 3.2a), and a mixed 3.1 / 3/3 / 3/2 run
  // falsely passes based on its only supported label. Do not infer an ordering
  // for suffixes or longer identifiers; decline with the observed candidates.
  const candidate = new RegExp(`^[ \\t]*${esc}[ \\t]*(?=\\d)`)
  const re = new RegExp(
    `^[ \\t]*(${esc}[ \\t]*(\\d+)[ \\t]*[-–—.·][ \\t]*(\\d+))` +
    `(?![ \\t]*[-–—.·/][ \\t]*\\d)(?=$|[ \\t:：,，;；。)\\]）]|\\.(?!\\d))`,
  )
  const seen = []
  const unsupported = []
  for (let i = 0; i < pages.length; i++) {
    for (const line of pages[i].split(/\r?\n/)) {
      if (!candidate.test(line)) continue
      const m = re.exec(line)
      if (!m) {
        unsupported.push({ page: i + 1, text: line.trim().slice(0, 160) })
        continue
      }
      seen.push({ chapter: Number(m[2]), number: Number(m[3]), page: i + 1, label: m[1] })
    }
  }
  if (unsupported.length) {
    const examples = unsupported.slice(0, 3).map(s => `"${s.text}" (page ${s.page})`).join('; ')
    return {
      label, total: seen.length, inversions: [], firstOnEachPage: [], pages: pages.length, unsupported,
      unreliable: `${unsupported.length} numbered "${label}" line(s) use an unsupported label form: ${examples}. ` +
        `Only ${seen.length} complete two-part label(s) matched; the order was not checked for this partial scan. ` +
        `Supported forms have two integer parts separated by -, –, —, . or ·, without suffixes or further number parts`,
    }
  }
  // The same label can appear twice on a page (a long caption wraps, the number is
  // repeated in a continuation line). Consecutive duplicates are one object.
  const unique = []
  for (const s of seen) {
    const last = unique[unique.length - 1]
    if (last && last.chapter === s.chapter && last.number === s.number) continue
    unique.push(s)
  }
  const inversions = []
  for (let i = 1; i < unique.length; i++) {
    const a = unique[i - 1], b = unique[i]
    if (b.chapter < a.chapter || (b.chapter === a.chapter && b.number < a.number)) {
      inversions.push({ before: a, after: b, gap: a.page - b.page })
    }
  }
  const firstOnEachPage = []
  for (const s of unique) {
    const last = firstOnEachPage[firstOnEachPage.length - 1]
    if (last && last.page === s.page) continue
    firstOnEachPage.push(s)
  }
  // Nothing matched is not the same as nothing out of order. A label prefix that is
  // mistyped, in the other language, or a different separator still produced
  // `0 label(s), all in reading order` — a pass for a scan that found no label at all,
  // on a page with two captions in front of it. Decline, and say what was searched.
  if (!unique.length) {
    return {
      label, total: 0, inversions: [], firstOnEachPage, pages: pages.length,
      unreliable:
        `no line begins with "${label} <n><separator><n>", so no label could be compared — ` +
        `checked all ${pages.length} page(s) of the text layer. Check the prefix; note that labels ` +
        `are matched in the two-part form this reports ("图 1-1", "Figure 3.2"), so a document that ` +
        `numbers its figures 1, 2, 3 has nothing for this check to order`,
    }
  }
  return { label, total: unique.length, inversions, firstOnEachPage }
}

export async function pdfPageText(pdf, page) {
  // mtime+size can repeat after a restore or an equal-size same-tick write.
  let stamp
  try { stamp = await fileDigest(pdf) } catch { return null }
  const key = `${pdf}\u0000${stamp}\u0000${page}`
  if (pageTextCache.has(key)) return pageTextCache.get(key)
  const out = join(tmpdir(), `latex-look-${process.pid}-${randomUUID()}-t${page}.txt`)
  let text = null
  try {
    const r = await run(findGhostscript(), [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite',
      `-dFirstPage=${page}`, `-dLastPage=${page}`, '-sOutputFile=' + out, pdf,
    ])
    if (r.code === 0) text = await readFile(out, 'utf8')
  } catch {
    text = null
  } finally {
    await rm(out, { force: true })
  }
  // Bounded like wholeDocCache: a long session that rebuilds a book many times would
  // otherwise hold one text layer per build for the life of the process.
  if (text !== null) {
    if (pageTextCache.size >= 512) pageTextCache.delete(pageTextCache.keys().next().value)
    pageTextCache.set(key, text)
  }
  return text
}

// Whitespace differs between the source and the typeset page (line breaks, indentation),
// so compare with all whitespace removed.
const squeeze = (s) => String(s).replace(/\s+/g, '')

/**
 * Which page actually carries `needle`? Trust SyncTeX's guess only if the page's text
 * layer agrees; otherwise look one and two pages either side.
 */
export async function pageCarryingText(pdf, guess, needle) {
  const want = squeeze(needle)
  if (!want) return { page: guess, verified: false }
  for (const candidate of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (!Number.isInteger(candidate) || candidate < 1) continue
    const text = await pdfPageText(pdf, candidate)
    if (text && squeeze(text).includes(want)) return { page: candidate, verified: true }
  }
  return { page: guess, verified: false }
}

/**
 * The `\includeonly` list of the main document, or null when it has none.
 *
 * TeX compiles only those children; every other `\include` is skipped without a
 * word in the log. So a file that plainly contains the text can be absent from the
 * PDF, and the reason is this line — not SyncTeX, which is what the reply used to
 * blame. Comments are stripped first: a commented-out `\includeonly` excludes
 * nothing.
 */
function includedChapters(source, dir) {
  const m = /\\includeonly\s*\{([^{}]*)\}/.exec(source)
  if (!m || /[\\#]/.test(m[1])) return null
  const names = m[1].split(',').map(part => part.trim()).filter(Boolean)
  return new Set(names.map(name => resolve(dir, name.replace(/\.tex$/i, ''))))
}

export async function includeOnly(main) {
  const src = await readFile(resolve(main), 'utf8').catch(() => '')
  const includes = includedChapters(withoutComments(src), dirname(resolve(main)))
  return includes ? [...includes].map(path => path.replace(/\\/g, '/')) : null
}

/**
 * When every source line that matched is in a file `\includeonly` excluded, name
 * the first of them; otherwise null and the caller keeps its SyncTeX explanation.
 */
async function excludedMatches(main, unlocated) {
  if (!Array.isArray(unlocated) || !unlocated.length) return null
  const matched = new Set(unlocated.map(u => u.file))
  for await (const { file } of texSources(main, { activeOnly: true })) {
    if (matched.has(file)) return null
  }
  const first = unlocated[0]
  const rel = first.file.replace(/\\/g, '/').split('/').pop()
  return { where: `${rel}:${first.line}`, file: first.file }
}

export async function locateText(texPath, pdf, text) {
  const main = resolve(texPath)
  const needle = String(text).trim()
  const hits = []
  const unlocated = []
  let matches = 0
  // A whitespace-only needle matches every line, which produced eight confident
  // "locations" that were pure noise.
  if (!needle) return { hits, searched: 0 }
  let searched = 0
  for await (const { file: f, source } of texSources(main)) {
    searched++
    const lines = source.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue
      matches++
      const pos = await locateFromLine(f, pdf, i + 1)
      if (pos) {
        const where = await pageCarryingText(pdf, pos.page, needle)
        hits.push({
          file: f,
          line: i + 1,
          ...pos,
          page: where.page,
          synctexPage: pos.page,
          pageVerified: where.verified,
          context: lines[i].trim().slice(0, 120),
        })
      } else {
        unlocated.push({ file: f, line: i + 1, context: lines[i].trim().slice(0, 120) })
      }
      if (hits.length >= 8) return { hits, searched, matches, unlocated }
    }
  }
  return { hits, searched, matches, unlocated }
}

// ---------------------------------------------------------------------------
// one-call convenience: the whole "look" verb
// ---------------------------------------------------------------------------

/**
 * Compile, render, optionally locate and diff. This is what both the CLI and
 * the MCP tool call.
 */
export async function look(file, options = {}) {
  return withDocLock(file, () => lookDoc(file, options))
}

async function lookDoc(file, {
  page, at, compare = 'previous', dpi = 140, engine,
  maxPasses = 3, timeoutSeconds = 300, outDir, fresh = false,
  audit = false, auditBlankMm = 30, sequence = null,
} = {}) {
  const texPath = resolve(file)
  const stem = basename(texPath).replace(/\.tex$/i, '')
  const dir = dirname(texPath)
  const pdf = join(dir, stem + '.pdf')
  // One directory per DOCUMENT, not per process. `renderPage` names its PNG after the
  // PDF's basename, so `a/main.tex` and `b/main.tex` — two projects, or two chapters
  // both called main — wrote to one path under `latex-look-<pid>/`, and the second look
  // silently replaced the image the first call had already handed back. The agent then
  // opened a picture of a different document. The subdirectory keeps the readable name
  // and makes the path unique; it stays under the documented `latex-look-<pid>/`.
  const workDir = outDir || join(tmpdir(), `latex-look-${process.pid}`, createHash('sha1').update(texPath).digest('hex').slice(0, 12))
  await mkdir(workDir, { recursive: true })

  // An `engine` value reached spawn() unvalidated, so a caller could name any
  // executable on disk. Only the engines this tool actually supports are allowed.
  if (engine && engine !== 'auto' && !ENGINES.includes(String(engine))) {
    const msg = `unknown engine "${engine}": expected auto or one of ${ENGINES.join(', ')}`
    return {
      ok: false, engine: String(engine), passes: 0, file: texPath, pdf,
      pages: null, page: 1,
      images: { after: null, before: null }, located: null, diff: null,
      problems: [{ severity: 'error', file: null, line: null, message: msg }],
      warnings: [], toc: { expected: false, entries: null },
      aux: [], fatal: msg, compareError: null,
    }
  }

  // Snapshot the comparison PDF BEFORE compiling: a caller-supplied compare path
  // is very often the document's own PDF, which the compile is about to overwrite.
  //
  // The "previous" snapshot is kept per document rather than per call. An agent
  // that just edited something inspects several pages of the SAME build; with a
  // per-call snapshot only the first of those pages could be diffed, because every
  // later call is served from the build cache and has nothing left to compare to.
  const prevKey = createHash('sha1').update(texPath).digest('hex')
  // One directory per document, and the snapshot keeps the document's own name: a
  // snapshot called 1ec06dee....pdf produced a "before" image called
  // 1ec06dee...-p11.png, which tells the user nothing about which file it is.
  const prevDir = join(tmpdir(), 'latex-look-prev', prevKey)
  const prevTmp = join(prevDir, `${stem}-before.tmp.pdf`)
  const prevCommitted = join(prevDir, `${stem}-before.pdf`)
  let beforePdf = null
  let compareError = null
  // The caller named a PDF: it is the baseline, and the "previous build" snapshot
  // must not be substituted for it below.
  let compareIsExplicit = false
  if (typeof compare === 'string' && compare !== 'previous') {
    const abs = resolve(compare)
    compareIsExplicit = true
    try {
      await stat(abs)
      beforePdf = join(workDir, `compare-${stem}.pdf`)
      await copyFile(abs, beforePdf, constants.COPYFILE_FICLONE)
    } catch {
      beforePdf = null
      compareError = `could not read the compare PDF: ${abs}`
    }
  }

  let pdfBefore = null
  let haveSnapshot = false
  const snapshotBeforeCompile = async () => {
    // Only a real compile can overwrite the current PDF. A cache hit can use
    // the committed predecessor directly, even for a different page of the book.
    try {
      pdfBefore = await stat(pdf)
      if (pdfBefore.isFile() && pdfBefore.size > 0) {
        await mkdir(prevDir, { recursive: true })
        await copyFile(pdf, prevTmp, constants.COPYFILE_FICLONE)
        haveSnapshot = true
        if (compare === 'previous') beforePdf = prevTmp
      }
    } catch {}
  }
  const build = await compileDoc(texPath, {
    engine, maxPasses, noCache: fresh, timeoutMs: Math.max(5, timeoutSeconds) * 1000,
  }, snapshotBeforeCompile)
  const pages = build.artifacts.pages

  // Publish the pre-build snapshot after EVERY real build, not only when a diff was
  // requested. Otherwise a plain look leaves the baseline one edit behind, and the
  // next "compare to previous" silently spans two edits — the user's last edit plus
  // the one before it.
  //
  // Only `beforePdf` may be repointed when the caller asked for the previous build.
  // When the caller named a file, that file is the baseline: publishing the snapshot
  // over it compared the new page against its own pre-edit self instead, so
  // `compare: "/some/other/build.pdf"` reported the few pixels of the last edit as
  // the whole difference — a different document's page diffed to 0.02% and read as
  // "nothing changed".
  if (!build.cached && build.ok) {
    if (haveSnapshot) {
      try {
        if (await replaceFile(prevTmp, prevCommitted) && compare === 'previous') beforePdf = prevCommitted
      } catch (e) {
        if (compare === 'previous') compareError = `could not record the previous build: ${e.message}`
      }
    } else {
      await rm(prevCommitted, { force: true })
    }
  }

  if (compare === 'previous') {
    if (build.cached) {
      // Nothing was rebuilt, so the state worth comparing against is the snapshot
      // published by the last real build — the PDF on disk IS that build.
      beforePdf = existsSync(prevCommitted) ? prevCommitted : null
      if (!beforePdf) {
        compareError = 'nothing was recompiled and no earlier build was recorded, so there is nothing to compare against'
      }
    }
  }

  // A failed compile leaves the previous PDF untouched. Rendering that file and
  // diffing it against the pre-compile snapshot reports "0.00% changed", which
  // reads as "your edit changed nothing" when nothing compiled at all. A fixed
  // time window is not enough (two runs a second apart defeat it), so compare the
  // file's identity before and after the compile instead.
  let pdfStale = false
  if (!build.cached && !build.ok) {
    try {
      const s = await stat(build.pdf)
      pdfStale = pdfBefore ? (s.mtimeMs === pdfBefore.mtimeMs && s.size === pdfBefore.size) : false
    } catch {
      pdfStale = true
    }
  }

  if (pdfStale) {
    // When a pass was killed, that reason is the whole story ("did not finish within
    // 120s — infinite loop"), and it is more useful than "produced no PDF".
    const killed = build.fatal ? `${build.fatal.replace(/\s+$/, '')} — so there is no page to show` : null
    const msg = killed || (!build.artifacts.exists
      ? 'the document did not compile and produced no PDF, so there is no page to show'
      : build.problems.length
        ? 'the document did not compile, so no page is shown (the PDF on disk is left over from an earlier run)'
        : 'the document produced no PDF, so no page is shown')
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: Number.isInteger(page) ? page : 1,
      images: { after: null, before: null },
      located: null, diff: null,
      problems: [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal: msg,
    }
  }

  // which page to show. A non-integer must stay visible so badPage can reject it;
  // mapping it to null made "page 2.5" quietly render page 1.
  let targetPage = page == null ? null : Number.isInteger(page) ? page : NaN
  // What the caller actually asked for. `targetPage` is NaN by the time the message is
  // built, so "page must be a whole number, got NaN" was what a caller who typed 2.5
  // was told — a message that hides the value it is complaining about.
  const pageAsAsked = page
  // A point probe, a diff and the PNGs can all need the same pixels. Keep at
  // most the two resolutions of each side for this look, under the document lock.
  const rasters = new Map()
  const rasterFor = (path, page, dpi) => {
    const key = `${path}\0${page}\0${dpi}`
    if (!rasters.has(key)) rasters.set(key, renderPpm(path, page, dpi))
    return rasters.get(key)
  }
  let located = null
  const validRequestedPage = targetPage === null ||
    (Number.isInteger(targetPage) && targetPage >= 1 && (pages == null || targetPage <= pages))
  if (validRequestedPage && at && typeof at === 'object' && at.text) {
    located = (await locateText(texPath, build.pdf, at.text))
    const found = Array.isArray(located) ? { hits: located, searched: 0 } : located
    located = found.hits
    if (targetPage === null && located.length) targetPage = located[0].page
    if (!located.length && found.searched > 0) {
      // Silence is the worst possible answer to "where is this text?". Naming the
      // wrong cause is nearly as bad: a file excluded by \includeonly is simply not
      // in the PDF, and blaming SyncTeX sends the reader looking in the wrong place.
      const needle = String(at.text).slice(0, 60)
      const excluded = await excludedMatches(texPath, found.unlocated)
      ;(build.warnings || (build.warnings = [])).unshift({
        severity: 'warning', file: null, line: null,
        message: excluded
          ? `the text "${needle}" is on ${excluded.where}, which \\includeonly leaves out of this build — the page cannot show it`
          : found.matches
            ? `the text "${needle}" matched ${found.matches} source line(s), but SyncTeX returned no position; no source-to-page mapping is available`
            : `the text "${needle}" was not found in any of the ${found.searched} source files reached through \\input/\\include`,
      })
    }
  } else if (validRequestedPage && at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    // A point outside the paper has no ink and no source line, but synctex answers
    // anyway -- with a confident line number. Refuse before it can be mistaken for
    // an answer, and say what the page actually measures.
    const probe = await rasterFor(build.pdf, targetPage || 1, 72)
    const outside = probe && (at.x < 0 || at.y < 0 || at.x >= probe.width || at.y >= probe.height)
    if (outside) {
      build.warnings.unshift({
        severity: 'warning', file: null, line: null,
        message: `the point (${at.x}, ${at.y}) is outside page ${targetPage || 1}, which is ${probe.width}x${probe.height} pt; nothing was located`,
      })
    } else if (!probe) {
      ;(build.warnings || (build.warnings = [])).unshift({
        severity: 'warning', file: null, line: null,
        message: 'could not rasterise the requested page to check the point; nothing was located',
      })
    }
    const hit = outside || !probe ? null : await locateFromPoint(build.pdf, targetPage || 1, at.x, at.y)
    if (probe && !outside && !hit) {
      ;(build.warnings || (build.warnings = [])).unshift({
        severity: 'warning', file: null, line: null,
        message: 'SyncTeX returned no source position for the requested point (mapping unavailable or no matching box); nothing was located',
      })
    }
    if (hit) {
      // Ask the raster what is there, so a rule drawn by a package cannot be
      // reported as if it were a line of the document.
      const ink = classifyInk(probe, { x: at.x, y: at.y, dpi: 72 })
      if (ink && ink.kind === 'rule' && hit.file) {
        // A rule is drawn by a command; find it, so "where does this line come
        // from" gets an answer instead of a disclaimer. Search a few lines either
        // way, because the box SyncTeX reports can be the paragraph, not the rule.
        ink.sourceLine = await findRuleCommand(hit.file, hit.line, 4)
        ink.origin = ink.sourceLine ? 'command' : 'furniture'
      }
      if (ink) hit.ink = ink
    }
    located = hit ? [hit] : []
  }
  // Default only when the caller said nothing. `!targetPage` also swallowed an
  // explicit page 0, which then silently rendered page 1 instead of complaining.
  if (targetPage === null) targetPage = 1

  // Asking for a page the document does not have used to reach stat() inside
  // renderPage and throw ENOENT straight out of the tool. That is a wrong page
  // number, not a crash: report it and skip rendering.
  const badPage =
    !Number.isInteger(targetPage) || targetPage < 1 || (Number.isInteger(pages) && targetPage > pages)
  if (badPage) {
    const msg = !Number.isInteger(targetPage)
      ? `page must be a whole number, got ${pageAsAsked ?? targetPage}`
      : Number.isInteger(pages)
        ? `page ${targetPage} is out of range: the document has ${pages} page(s)`
        : `page ${targetPage} is not a valid page number`
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: targetPage,
      images: { after: null, before: null },
      located, diff: null,
      problems: [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal: msg,
    }
  }

  let diff = null
  if (beforePdf && build.ok) {
    try {
      const [pa, pb] = await Promise.all([rasterFor(beforePdf, targetPage, 72), rasterFor(build.pdf, targetPage, 72)])
      diff = diffRaster(pa, pb, 72)
      if (!pa || !pb) compareError = 'could not rasterise both pages, so no pixel diff was computed'
      else if (!diff) compareError = `page dimensions differ (${pa.width}x${pa.height} vs ${pb.width}x${pb.height} pt), so no pixel diff was computed`
    } catch (e) {
      compareError = `could not compute the pixel diff: ${e.message}`
    }
  }

  const preview = async (path, outDir) => {
    // Retain display-size RGB buffers only if the composite needs them.
    // An unchanged high-resolution page can go straight from gs to a PNG.
    const reuse = diff?.changedPixels > 0 || (dpi === 72 && rasters.size > 0)
    const raster = reuse ? await rasterFor(path, targetPage, dpi) : null
    return renderPage(path, targetPage, { dpi, outDir, raster })
  }
  let after
  try {
    after = await preview(build.pdf, workDir)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // If the compile itself failed, that is the cause. "the page number is probably
    // out of range" is a misdiagnosis for a document that produced no pages at all.
    const compileFailed = build.problems.length > 0
    const fatal = compileFailed
      ? 'the document did not compile, so no page could be rendered (see PROBLEMS)'
      : msg
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: targetPage,
      images: { after: null, before: null },
      located, diff: null,
      problems: compileFailed
        ? build.problems
        : [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal,
    }
  }
  let before = null
  // A diff only means something when the build succeeded. Comparing against a page
  // that failed to compile invites reading a broken render as the intended result.
  if (beforePdf && build.ok) {
    try {
      // A separate directory: the compared PDF usually has the SAME basename as
      // the document's own PDF, and renderPage names its image after that
      // basename — so both renders landed on one file and the "after" image was
      // silently replaced by the pre-edit one.
      before = await preview(beforePdf, join(workDir, 'before'))
    } catch (e) {
      diff = null
      const baselineName = compareIsExplicit ? `compare PDF "${compare}"` : 'previous build'
      const bp = await inspectPdf(beforePdf).catch(() => null)
      compareError = bp?.pages && targetPage > bp.pages
        ? `page ${targetPage} does not exist in the ${baselineName}; it had ${bp.pages} page(s), so there is nothing to diff`
        : `could not compare page ${targetPage} with the ${baselineName}: ${e.message}`
    }
  } else if (beforePdf && !build.ok && !compareError) {
    compareError = 'the compile failed, so no before/after diff was computed'
  } else if (compare === 'previous' && !beforePdf && !compareError) {
    // No earlier PDF to copy: the first look of a document, or the PDF was removed.
    // Saying nothing would read as "your edit changed nothing".
    compareError = 'there was no earlier build of this document to compare against'
  }

  // One file instead of two: the page before on the left, the page after on the
  // right, at the same resolution as the single-page renders.
  let sideBySideImage = null
  // Reuse the display-resolution pixels from the two single-page previews.
  if (before && build.ok && diff && diff.changedPixels > 0) {
    try {
      const [pl, pr] = await Promise.all([rasterFor(beforePdf, targetPage, dpi), rasterFor(build.pdf, targetPage, dpi)])
      if (pl && pr) {
        const merged = sideBySide(pl, pr)
        sideBySideImage = join(workDir, `compare-${randomUUID()}-p${targetPage}@${dpi}dpi.png`)
        await writeFile(sideBySideImage, encodePng(merged.width, merged.height, merged.data, dpi))
      }
    } catch {
      sideBySideImage = null
    }
  }

  rasters.clear()

  // Reading order: a float can land after an object with a larger number that stayed
  // inline, and the reader turns the page to see 图 3-4 before 图 3-3.
  let sequenceReport = null
  if (sequence && !build.ok) {
    sequenceReport = { error: 'the compile failed, so the reading order of a partial PDF was not checked' }
  } else if (sequence) {
    try {
      sequenceReport = await findSequence(build.pdf, { label: String(sequence) })
    } catch (e) {
      sequenceReport = { error: e instanceof Error ? e.message : String(e) }
    }
  }

  // Whole-document audit with a BASELINE: a chapter that ends two thirds down a page
  // is normal typography, and reporting all of them buries the one page the reader is
  // complaining about. The first run records a baseline; after an edit only findings
  // that were not there before are worth the reader's attention — those are the ones
  // the edit itself introduced.
  let auditReport = null
  if (audit && !build.ok) {
    auditReport = { error: 'the compile failed, so no layout audit was run and its baseline was left unchanged' }
  } else if (audit) {
    try {
      const current = await auditLayout(build.pdf, { blankMm: auditBlankMm, withText: true })
      const baseDir = join(tmpdir(), 'latex-look-audit-baseline', prevKey)
      const baseFile = join(baseDir, `${stem}.json`)
      let baseline = null
      try { baseline = JSON.parse(await readFile(baseFile, 'utf8')) } catch { baseline = null }
      // Match on the TEXT at the break, not on the page number: any edit that adds or
      // removes a line repaginates the whole book, so "the page that stops short" moves
      // even when it is the same hole. The last line of text before the hole is the
      // stable identity; the page number is only a fallback for pages with no text.
      const anchor = (f) => (f.lastLine ? f.lastLine.replace(/\s+/g, '').slice(0, 14) : '')
      const same = (a, b) => {
        const aa = anchor(a), bb = anchor(b)
        if (aa && bb && aa.length >= 6 && bb.length >= 6) return aa.slice(0, 8) === bb.slice(0, 8)
        return a.kind === b.kind && Math.abs(a.page - b.page) <= 2 && Math.abs(a.mm - b.mm) <= Math.max(8, b.mm * 0.4)
      }
      // With no baseline there is nothing to have changed from: every finding is
      // pre-existing, so none of them is "new". Reporting them as new made a first
      // audit of an untouched book look like the book had just been broken.
      // Keep the baseline across a repagination: the edit most likely to create a hole
      // (new content, a caption, a page break) is also an edit that moves every page
      // number. Refusing to compare there would silence the tool exactly when it is
      // needed. Identity comes from the text at the break, not from the page number.
      const repaginated = baseline && baseline.pages !== current.pages
      const baselinePagesBefore = repaginated ? baseline.pages : null
      const fresh = []
      // An audit that could not establish a reference is not a clean measurement.
      // Do not compare or publish its empty/partial findings over a usable baseline.
      if (baseline && !current.calibration) {
        for (const f of current.findings) {
          if (f.kind === 'section-end') continue
          if (!baseline.findings.some((b) => same(f, b))) fresh.push(f)
        }
      }
      if (!current.calibration) {
        await mkdir(baseDir, { recursive: true })
        await writeFile(baseFile, JSON.stringify({
          at: new Date().toISOString(),
          pages: current.pages,
          blockTop: current.blockTop,
          blockBottom: current.blockBottom,
          findings: current.findings,
        }))
      }
      auditReport = {
        pages: current.pages,
        calibration: current.calibration || null,
        repaginatedFrom: repaginated ? baselinePagesBefore : null,
        findings: current.findings.filter((f) => f.kind !== 'section-end'),
        sectionEnds: current.findings.filter((f) => f.kind === 'section-end').length,
        newFindings: fresh,
        hadBaseline: !!baseline,
        baselinePages: baseline?.pages ?? null,
      }
    } catch (e) {
      auditReport = { error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    ok: build.ok,
    engine: build.engine,
    passes: build.passes,
    file: texPath,
    pdf: build.pdf,
    pages,
    page: targetPage,
    audit: auditReport,
    sequence: sequenceReport,
    images: { after: after.path, before: before?.path || null, sideBySide: sideBySideImage },
    located,
    diff,
    problems: build.problems,
    warnings: build.warnings || [],
    toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
    aux: build.aux || [],
    compareError,
    cached: !!build.cached,
    fatal: build.fatal || null,
  }
}
