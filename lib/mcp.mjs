// A Model Context Protocol server over stdio, for the clients that do not run DSH:
// Claude Desktop, Cursor, Codex, anything that speaks MCP. It is a thin shell around
// the same `look()` the plugin calls, so the measurement, the wording and the traps
// are identical in both places — the plugin is the DSH shape, this is the universal one.

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import { ENGINES, look } from './core.mjs'
import { formatResult } from './format.mjs'
import { currentVersion } from './update.mjs'

// Only the tools a visual-fix loop needs. Two tools that do the same thing with
// different names is how a caller ends up using the wrong one.
const TOOLS = [
  {
    name: 'latex_look',
    title: 'See what a LaTeX page actually looks like',
    description:
      'Compile a LaTeX document, render a page to a PNG you can see, and map a point or a text anchor back to the ' +
      'exact source line. Use this whenever someone describes a page visually — a table style, a rule to remove, ' +
      'spacing, a line running into the margin, a figure that is too large — and before saying a layout change is ' +
      'done. Note that `page` is the PDF page index, not the number printed on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the main .tex file (absolute, or relative to the current directory).',
        },
        page: {
          type: 'number',
          description: 'PDF page to render, 1-based. Omit when using `text`, which finds the page itself.',
        },
        text: {
          type: 'string',
          description:
            'A short string visible on the page (a caption, a heading, a unique phrase). Resolves to its source file:line and page.',
        },
        pointX: {
          type: 'number',
          description:
            'X of a point on the page, together with pointY. Feed back the bbox of a previous diff to inspect what changed.',
        },
        pointY: {
          type: 'number',
          description: 'Y of the same point, in PDF points from the top-left corner of the page.',
        },
        compare: {
          type: 'string',
          description:
            'Path to an earlier PDF of the same document. The page is diffed against it and a before image is rendered.',
        },
        dpi: { type: 'number', description: 'Render resolution, 50-300. Defaults to 120.' },
        engine: {
          type: 'string',
          description: `auto | ${ENGINES.join(' | ')}. Defaults to auto, which picks from what the document uses.`,
        },
        fresh: {
          type: 'boolean',
          description: 'Ignore the build cache and compile from scratch. Use only if you suspect the cache is stale.',
        },
        audit: {
          type: 'boolean',
          description:
            'Audit every page for layout regressions against the previous audit of this document: pages that stop ' +
            'short, pages that start low, nearly empty pages — but only the ones this edit introduced. Run it after ' +
            'changing a whole class of pages (captions, headers, spacing).',
        },
        auditBlankMm: {
          type: 'number',
          description: 'How deep a hole at the foot of a page must be (mm) before the audit calls it one. Defaults to 30.',
        },
        sequence: {
          type: 'string',
          description:
            "Check reading order for numbered labels with this prefix (e.g. '图' or 'Figure'). An inversion is what a " +
            'figure that became a float while its neighbours stayed inline causes: the reader turns the page to see ' +
            '图 3-4 before 图 3-3.',
        },
      },
      required: ['file'],
    },
  },
]

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST = PROTOCOLS[0]

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Resolve and validate the arguments of one `tools/call`. */
function resolveArgs(args = {}) {
  const file = isAbsolute(String(args.file || '')) ? String(args.file) : resolve(String(args.file || ''))
  if (!args.file) throw new RpcError(-32602, 'file is required')
  if (!existsSync(file)) throw new RpcError(-32602, `file not found: ${file}`)
  if (args.engine && args.engine !== 'auto' && !ENGINES.includes(String(args.engine))) {
    throw new RpcError(-32602, `unknown engine "${args.engine}"; expected auto or one of ${ENGINES.join(', ')}`)
  }
  const hasX = Number.isFinite(args.pointX)
  const hasY = Number.isFinite(args.pointY)
  if (hasX !== hasY) throw new RpcError(-32602, 'pointX and pointY must be given together')
  const text = args.text == null ? '' : String(args.text).trim()
  return {
    file,
    options: {
      page: args.page,
      at: text ? { text } : hasX ? { x: args.pointX, y: args.pointY } : null,
      compare: args.compare,
      dpi: clampInt(args.dpi, 50, 300, 120),
      engine: args.engine,
      fresh: args.fresh === true,
      audit: args.audit === true,
      auditBlankMm: clampInt(args.auditBlankMm, 5, 200, 30),
      sequence: args.sequence ? String(args.sequence) : null,
    },
  }
}

/** The page render travels as an image block, so the model sees it without a file. */
async function imageBlocks(result) {
  const blocks = []
  for (const [label, path] of [
    ['the page', result.images?.after],
    ['the page before this edit', result.images?.before],
    ['before (left) and after (right)', result.images?.sideBySide],
  ]) {
    if (!path || !existsSync(path)) continue
    try {
      const data = await readFile(path)
      blocks.push({ type: 'text', text: `${label}:` })
      blocks.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' })
    } catch {
      // A missing render is not worth failing the call: the text still says what happened.
    }
  }
  return blocks
}

async function callTool(name, args) {
  if (name !== 'latex_look') throw new RpcError(-32602, `unknown tool: ${name}`)
  const { file, options } = resolveArgs(args)
  const result = await look(file, options)
  const text = formatResult(result)
  return {
    content: [{ type: 'text', text }, ...(await imageBlocks(result))],
    isError: !result.ok,
  }
}

/**
 * One JSON-RPC message in, at most one message out. Kept separate from stdio so the
 * protocol can be tested without a subprocess.
 */
export async function handleMessage(msg) {
  const { id, method, params } = msg || {}
  if (method === undefined) return null
  const isNotification = id === undefined || id === null
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result })
  const fail = (code, message) =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } }

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return reply({
          // Echo a version we speak; the client falls back on its own if it must.
          protocolVersion: PROTOCOLS.includes(asked) ? asked : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'latex-look', title: 'latex-look', version: await currentVersion() },
          instructions:
            'Compiles LaTeX and shows you the page. Work in a loop: look at the page, change the source, look again ' +
            'with compare pointing at the previous PDF so the diff shows exactly what your edit did. Never claim a ' +
            'layout fix is done without looking at the rendered page afterwards.',
        })
      }
      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = params?.name
        const result = await callTool(name, params?.arguments || {})
        return reply(result)
      }
      case 'resources/list':
        return reply({ resources: [] })
      case 'prompts/list':
        return reply({ prompts: [] })
      default:
        return fail(-32601, `method not found: ${method}`)
    }
  } catch (e) {
    if (isNotification) return null
    const code = e instanceof RpcError ? e.code : -32603
    return fail(code, e instanceof Error ? e.message : String(e))
  }
}

/** Serve MCP on stdin/stdout until the client closes the pipe. */
export async function serveStdio({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = ''
  let chain = Promise.resolve()

  const write = (msg) => {
    if (!msg) return
    output.write(JSON.stringify(msg) + '\n')
  }

  input.setEncoding('utf8')
  for await (const chunk of input) {
    buffer += chunk
    let nl
    // Newline-delimited JSON is what every MCP client sends on stdio. Batch on the same
    // line is not a thing here, so one line is one message.
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }
      // Serialise the work: one compile at a time, in the order the client asked.
      chain = chain.then(async () => write(await handleMessage(msg))).catch(() => {})
    }
  }
  await chain
}
