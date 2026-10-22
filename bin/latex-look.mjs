#!/usr/bin/env node
/**
 * latex-look — CLI. Compile a document, render the page, locate the source,
 * and show what your last edit actually changed.
 *
 *   latex-look book.tex --page 37 --text "表3.1"
 *   latex-look book.tex --page 12 --compare previous --json
 */
import { look } from '../lib/core.mjs'

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
  L.push(`engine ${r.engine} · ${r.passes} pass(es) · ${r.pages ?? '?'} pages · showing page ${r.page}`)
  if (r.toc?.expected) L.push(`toc    ${r.toc.entries ?? 0} entries`)
  if (r.aux?.length) L.push(`aux    ${r.aux.map((a) => `${a.tool}${a.ok ? '' : ' FAILED'}`).join(', ')}`)
  L.push(`image  ${r.images.after}`)
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
    for (const h of r.located.slice(0, 5)) L.push(`  ${h.file}:${h.line}  → p${h.page} x=${h.x?.toFixed?.(1)} y=${h.y?.toFixed?.(1)}`)
  }
  if (r.diff) {
    L.push('')
    if (!r.diff.changedRatio) L.push('DIFF   nothing changed on this page')
    else {
      L.push(`DIFF   ${(r.diff.changedRatio * 100).toFixed(2)}% of the page changed`)
      if (r.diff.bbox) L.push(`       bbox x=${r.diff.bbox.x} y=${r.diff.bbox.y} w=${r.diff.bbox.width} h=${r.diff.bbox.height} (points)`)
      if (r.images.before) L.push(`before ${r.images.before}`)
    }
  }
  return L.join('\n')
}

const args = parseArgs(process.argv.slice(2))

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
  --timeout <s>       per-pass time budget in seconds (default 300)
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
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(summary(result))
  process.exit(result.ok ? 0 : 2)
} catch (err) {
  console.error(`latex-look: ${err.message}`)
  process.exit(1)
}
