#!/usr/bin/env node
/**
 * latex-look MCP server (stdio, newline-delimited JSON-RPC, zero dependencies).
 *
 * Exposes exactly ONE tool — `latex_look` — because an agent should ask to
 * "look at the page", not to orchestrate three primitives.
 */
import { createInterface } from 'node:readline'
import { look } from '../lib/core.mjs'

const PROTOCOL = '2024-11-05'

const TOOL = {
  name: 'latex_look',
  description:
    'See what a LaTeX document actually looks like. Compiles the main .tex with enough passes for ' +
    'TOC/cross-references, renders the requested page to a PNG you can open with an image reader, ' +
    'optionally resolves a text anchor or a PDF point to the exact source file and line via SyncTeX, ' +
    'and optionally diffs the page against the PDF from before this compile so you can see what your ' +
    'last edit changed. It also reports compile errors with file:line, LaTeX/Overfull/Underfull ' +
    'warnings, and flags a \\tableofcontents that came out EMPTY instead of silently passing. ' +
    'Call it BEFORE editing (to see the problem) and AFTER editing (to verify).',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the main .tex file.' },
      page: { type: 'number', description: '1-based page to render. Defaults to 1, or to the page a text anchor lands on.' },
      text: { type: 'string', description: 'Text anchor: locate this string in the sources and show the page it renders on.' },
      point: {
        type: 'object',
        description: 'PDF point to resolve to a source line: {x, y} in PDF points (72/inch), origin at the top-left of the page.',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
      },
      compare: {
        type: 'string',
        description: "'previous' (default) diffs against the PDF as it was before this compile. Or a path to another PDF to diff against.",
      },
      dpi: { type: 'number', description: 'Render resolution. Default 140; use 200+ to examine fine detail.' },
      engine: { type: 'string', description: 'xelatex | lualatex | pdflatex | latexmk | tectonic. Default: auto-detect.' },
      maxPasses: { type: 'number', description: 'Maximum passes for classic engines (pdflatex/xelatex/lualatex) before the TOC and cross-references settle. Default 3.' },
      timeoutSeconds: { type: 'number', description: 'Per-pass time budget in seconds before the engine is killed. Default 300.' },
    },
    required: ['file'],
  },
}

function text(t) {
  return { content: [{ type: 'text', text: t }] }
}

function format(r) {
  const L = []
  L.push(`${r.ok ? 'OK' : 'FAILED'} — ${r.file}`)
  L.push(`engine: ${r.engine} | passes: ${r.passes} | pages: ${r.pages ?? '?'} | showing page ${r.page}`)
  if (r.toc?.expected) L.push(`toc: ${r.toc.entries ?? 0} entries`)
  if (r.aux?.length) {
    L.push(`aux: ${r.aux.map((a) => `${a.tool}${a.ok ? '' : ' FAILED'}`).join(', ')}`)
  }
  L.push(`image (open it with an image reader): ${r.images.after}`)
  if (r.images.before) L.push(`image before the edit: ${r.images.before}`)
  if (r.fatal) L.push(`FATAL: ${r.fatal}`)
  if (r.problems?.length) {
    L.push('')
    L.push(`PROBLEMS (${r.problems.length}):`)
    for (const p of r.problems.slice(0, 15)) {
      const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : p.line ? `line ${p.line}: ` : ''
      L.push(`  ${where}${p.message}`)
    }
  }
  if (r.warnings?.length) {
    L.push('')
    L.push(`WARNINGS (${r.warnings.length}${r.warnings.length > 10 ? ', first 10' : ''}):`)
    for (const w of r.warnings.slice(0, 10)) L.push(`  ${w.message}`)
  }
  if (r.located?.length) {
    L.push('')
    L.push('LOCATED IN SOURCE:')
    for (const h of r.located.slice(0, 8)) {
      const y = typeof h.y === 'number' ? ` y=${h.y.toFixed(1)}` : ''
      L.push(`  ${h.file}:${h.line}  →  page ${h.page}${y}`)
      if (h.context) L.push(`      ${h.context}`)
    }
  }
  if (r.diff) {
    L.push('')
    if (!r.diff.changedRatio) L.push('DIFF: this page did not change.')
    else {
      L.push(`DIFF: ${(r.diff.changedRatio * 100).toFixed(2)}% of the page changed.`)
      if (r.diff.bbox) {
        L.push(`  changed region: x=${r.diff.bbox.x} y=${r.diff.bbox.y} w=${r.diff.bbox.width} h=${r.diff.bbox.height} (PDF points)`)
        L.push('  use the `point` argument with the centre of that region to find the source line that draws it.')
      }
    }
  }
  return L.join('\n')
}

async function callTool(name, args) {
  if (name !== 'latex_look') throw new Error(`unknown tool: ${name}`)
  const result = await look(args.file, {
    page: args.page,
    at: args.point ? { x: Number(args.point.x), y: Number(args.point.y) } : args.text ? { text: args.text } : undefined,
    compare: args.compare ?? 'previous',
    dpi: args.dpi ?? 140,
    engine: args.engine,
    maxPasses: args.maxPasses,
    timeoutSeconds: args.timeoutSeconds,
  })
  return { content: [{ type: 'text', text: format(result) }, { type: 'text', text: JSON.stringify(result) }], isError: !result.ok }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const raw = line.trim()
  if (!raw) return
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  const { id, method, params } = msg
  const isNotification = id === undefined
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'latex-look', version: '0.1.0' },
          },
        })
        break
      case 'notifications/initialized':
        break
      case 'ping':
        if (!isNotification) send({ jsonrpc: '2.0', id, result: {} })
        break
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })
        break
      case 'tools/call': {
        const { name, arguments: a } = params || {}
        const result = await callTool(name, a || {})
        send({ jsonrpc: '2.0', id, result })
        break
      }
      default:
        if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (err) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err.message || err) } })
  }
})
