#!/usr/bin/env node
/**
 * latex-look — CLI. Compile a document, render the page, locate the source,
 * and show what your last edit actually changed.
 *
 *   latex-look book.tex --page 37 --text "表3.1"
 *   latex-look book.tex --page 12 --compare previous --json
 */
import { look } from '../lib/core.mjs'
import { checkForUpdate, currentVersion } from '../lib/update.mjs'
import { serveStdio } from '../lib/mcp.mjs'

// `latex-look mcp` is the Model Context Protocol server: one command a client can
// launch, instead of a path into node_modules. It shares everything with the CLI.
if (process.argv[2] === 'mcp') {
  await serveStdio()
} else {
  await cli()
}

async function cli() {

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) out[key] = true
      else { out[key] = val; i++ }
    } else out._.push(a)
  }
  return out
}

function summary(r) {
  const L = []
  L.push(`${r.ok ? 'OK' : 'FAILED'}  ${r.file}`)
  L.push(`engine ${r.engine} · ${r.cached ? 'reused (nothing changed)' : `${r.passes} pass(es)`} · ${r.pages ?? '?'} pages · showing page ${r.page}`)
  if (r.toc?.expected) L.push(`toc    ${r.toc.entries ?? 0} entries`)
  if (r.sequence && !r.sequence.error) {
    L.push('')
    if (r.sequence.unreliable) L.push(`ORDER  cannot check the order: ${r.sequence.unreliable}`)
    else if (!r.sequence.inversions.length) L.push(`ORDER  ${r.sequence.total} ${r.sequence.label}-label(s), all in reading order`)
    else {
      L.push(`ORDER  ${r.sequence.inversions.length} inversion(s) among ${r.sequence.total} ${r.sequence.label}-label(s):`)
      for (const v of r.sequence.inversions.slice(0, 8)) {
        L.push(`  ${v.before.label} on page ${v.before.page} comes before ${v.after.label} on page ${v.after.page}`)
      }
    }
  }
  if (r.audit) {
    if (r.audit.error) L.push(`audit  FAILED: ${r.audit.error}`)
    else if (r.audit.calibration) L.push(`AUDIT  cannot measure: ${r.audit.calibration}`)
    else {
      const n = r.audit.findings.length
      const fresh = r.audit.newFindings.length
      L.push('')
      if (!r.audit.hadBaseline) {
        const why = r.audit.repaginatedFrom
          ? ` (baseline: ${r.audit.repaginatedFrom} pages, now ${r.audit.pages} — matched by the text at each break, not by page number)`
          : ''
        L.push(`AUDIT  baseline recorded: ${n} page(s) stop short (${r.audit.sectionEnds} of them a chapter or section end)${why}`)
      }
      else if (!fresh) L.push(`AUDIT  nothing new: still the same ${n} page(s) stop short, none introduced by this build`)
      else L.push(`AUDIT  ${fresh} NEW finding(s) since the last run (${n} in total):`)
      for (const f of (fresh ? r.audit.newFindings : []).slice(0, 8)) {
        L.push(`  ${f.kind.padEnd(12)} p${f.page}  ${f.mm.toFixed(0)}mm  ${f.lastLine ? '…' + f.lastLine.slice(-28) : ''}`)
      }
    }
  }
  if (r.aux?.length) L.push(`aux    ${r.aux.map((a) => `${a.tool}${a.ok ? '' : ' FAILED'}`).join(', ')}`)
  if (r.images?.after) L.push(`image  ${r.images.after}`)
  if (r.fatal) L.push(`FATAL  ${r.fatal}`)
  if (r.problems?.length) {
    L.push('')
    L.push(`PROBLEMS (${r.problems.length})`)
    for (const p of r.problems.slice(0, 10)) {
      const where = p.file ? `${p.file}${p.line ? ':' + p.line : ''}: ` : p.line ? 'line ' + p.line + ': ' : ''
      L.push(`  ${where}${p.message}`)
    }
  }
  if (r.warnings?.length) {
    L.push('')
    L.push(`WARNINGS (${r.warnings.length})`)
    for (const w of r.warnings.slice(0, 8)) L.push(`  ${w.message}`)
  }
  if (r.located?.length) {
    L.push('')
    L.push('LOCATED')
    for (const h of r.located.slice(0, 5)) {
      const fixed = h.pageVerified && h.synctexPage && h.synctexPage !== h.page ? `  (synctex: p${h.synctexPage})` : ''
      const at = typeof h.x === 'number' && typeof h.y === 'number' ? ` x=${h.x.toFixed(1)} y=${h.y.toFixed(1)}` : ''
      L.push(`  ${h.file}:${h.line}  → p${h.page}${at}${fixed}`)
      if (h.ink && h.ink.kind === 'rule' && h.ink.origin === 'command' && h.ink.sourceLine) {
        L.push(`      ^ ink at this point: horizontal rule at y=${h.ink.y}pt, ${Math.round(h.ink.span * 100)}% of page width`)
        L.push(`        drawn by line ${h.ink.sourceLine.line}: ${h.ink.sourceLine.text}`)
      } else if (h.ink && h.ink.kind === 'rule') {
        // Facts only. What to do about it is the reader's knowledge, not this tool's,
        // and a hint here would be wrong on any document that does not match the guess.
        L.push(`      ^ ink at this point: horizontal rule at y=${h.ink.y}pt, ${Math.round(h.ink.span * 100)}% of page width`)
        L.push(`        no rule-drawing command on line ${h.line} or any of the 4 lines around it`)
        L.push('        so it is drawn somewhere else: a package, the page style, or a macro')
      } else if (h.ink && h.ink.kind === 'blank') {
        L.push('      ^ ink at this point: none (blank paper; the nearest box belongs to a different spot)')
      }
    }
  }
  if (r.diff) {
    L.push('')
    if (!r.diff.changedPixels) L.push('DIFF   nothing changed on this page')
    else {
      const pct = r.diff.changedRatio * 100
      const shown = pct >= 0.01 ? pct.toFixed(2) : pct >= 0.001 ? pct.toFixed(3) : pct.toFixed(4)
      L.push(`DIFF   ${shown}% of the page changed (${r.diff.changedPixels} px)`)
      if (r.diff.bbox) L.push(`       bbox x=${r.diff.bbox.x} y=${r.diff.bbox.y} w=${r.diff.bbox.width} h=${r.diff.bbox.height} (points)`)
      if (r.images.before) L.push(`before ${r.images.before}`)
      if (r.images.sideBySide) L.push(`both   ${r.images.sideBySide}`)
    }
  }
  return L.join('\n')
}

  const args = parseArgs(process.argv.slice(2))

  if (args.version || args['check-update']) {
    if (args.version) console.log(await currentVersion())
    if (args['check-update']) {
      const r = await checkForUpdate({ ttlMs: 0 })
      // "Up to date" would be a lie when the registry never answered.
      if (r.error && !r.latest) console.log(`could not check: ${r.error}`)
      else if (r.outdated) console.log(`update available: ${r.latest} (running ${r.current})`)
      else console.log(`up to date: ${r.current}${r.error ? ` (registry said ${r.error}, cached answer)` : ''}`)
    }
    process.exit(0)
  }

  if (args.help || !args._[0]) {
    console.log(`latex-look — see what your LaTeX actually looks like

  Usage:
    latex-look <main.tex> [options]

  Options:
    --page <n>          page to render (default 1)
    --text <anchor>     locate this text and show the page it lands on
    --point <x,y>       locate the source of a point (PDF points, origin top-left)
    --compare <p>       'previous' (default) diffs against the PDF from before this
                        compile; or a path to another PDF
    --dpi <n>           render resolution (default 140)
    --engine <e>        xelatex | lualatex | pdflatex | latexmk | tectonic
    --max-passes <n>    max compile passes (default 3)
    --fresh             ignore the build cache and recompile
    --timeout <s>       per-pass time budget in seconds (default 120)
    --json              machine-readable output

  Requires: a TeX engine, synctex, ghostscript.`)
    process.exit(args.help ? 0 : 1)
  }

  const file = args._[0]
  const at = args.text ? { text: args.text }
    : args.point ? (([x, y]) => ({ x: Number(x), y: Number(y) }))(String(args.point).split(',')) : undefined

  try {
    const result = await look(file, {
      page: args.page ? Number(args.page) : undefined,
      at,
      compare: args.compare || 'previous',
      dpi: args.dpi ? Number(args.dpi) : 140,
      engine: args.engine,
      maxPasses: args['max-passes'] ? Number(args['max-passes']) : undefined,
      timeoutSeconds: args.timeout ? Number(args.timeout) : undefined,
      fresh: args.fresh === true || args.fresh === 'true',
      audit: args.audit === true || args.audit === 'true',
      sequence: args.sequence ? String(args.sequence) : null,
      auditBlankMm: args['audit-blank'] ? Number(args['audit-blank']) : undefined,
    })
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(summary(result))
    process.exit(result.ok ? 0 : 2)
  } catch (err) {
    console.error(`latex-look: ${err.message}`)
    process.exit(1)
  }
}

