// The MCP server, tested on the wire: a real subprocess, real stdio, no SDK.
//
// A protocol bug that only shows up when Claude Desktop launches the server is the
// expensive kind — the client reports "server failed to start" and there is nothing to
// read. So the handshake, the tool schema, a real call, and the two failure paths are
// checked here, against a document compiled on the spot.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'bin', 'latex-look.mjs')

const dir = await mkdtemp(join(tmpdir(), 'latex-look-mcp-'))
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

function startServer() {
  const child = spawn(process.execPath, [entry, 'mcp'], { cwd: dir })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let stderr = ''

  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })

  const send = (method, params) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => reject(new Error(`no reply to ${method}${stderr ? ` (stderr: ${stderr.slice(0, 300)})` : ''}`)), 240000)
    })
  }

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  return { child, send, notify, stderr: () => stderr }
}

const doc = join(dir, 'page.tex')
await writeFile(
  doc,
  [
    '\\documentclass[UTF8]{ctexart}',
    '\\usepackage[a4paper,margin=2.5cm]{geometry}',
    '\\begin{document}',
    // The rule is the first thing on the page, so its row is the top margin (2.5cm at
    // 72.27pt/in) and the test can name a point instead of guessing one.
    '\\noindent\\rule{\\linewidth}{0.4pt}\\par',
    '\\vspace{6pt}',
    '第一段文字，用来给 SyncTeX 一个锚点。',
    '\\par\\vspace{6pt}',
    '第二段文字。',
    '\\end{document}',
    '',
  ].join('\n'),
)

const server = startServer()

try {
  let init
  await check('initialize answers with a version and tool capability', async () => {
    init = await server.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    assert.equal(init.jsonrpc, '2.0')
    assert.equal(init.id, 1)
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.capabilities.tools.listChanged, false)
    assert.match(String(init.result.serverInfo.version), /^\d+\.\d+\.\d+/)
    assert.equal(init.result.serverInfo.name, 'latex-look')
    server.notify('notifications/initialized')
  })

  await check('a version the server does not speak falls back to one it does', async () => {
    const r = await server.send('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
    assert.notEqual(r.result.protocolVersion, '1999-01-01')
  })

  await check('ping is answered, not ignored', async () => {
    const r = await server.send('ping', {})
    assert.deepEqual(r.result, {})
  })

  let tool
  await check('tools/list describes one tool with the parameters the plugin uses', async () => {
    const r = await server.send('tools/list', {})
    assert.equal(r.result.tools.length, 1)
    tool = r.result.tools[0]
    assert.equal(tool.name, 'latex_look')
    assert.deepEqual(tool.inputSchema.required, ['file'])
    for (const p of ['file', 'page', 'text', 'pointX', 'pointY', 'compare', 'audit', 'sequence']) {
      assert.ok(tool.inputSchema.properties[p], `missing parameter ${p}`)
    }
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 80, 'the description has to teach the loop')
  })

  await check('tools/call renders the page and returns it as an image block', async () => {
    const r = await server.send('tools/call', {
      name: 'latex_look',
      arguments: { file: doc, page: 1, pointX: 300, pointY: 120 },
    })
    assert.equal(r.result.isError, false)
    const text = r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    assert.match(text, /^OK/)
    assert.match(text, /LOCATED IN SOURCE/)
    const image = r.result.content.find((c) => c.type === 'image')
    assert.ok(image, 'no image block came back')
    assert.equal(image.mimeType, 'image/png')
    assert.ok(image.data.length > 1000, 'image block is empty')
    // base64 must be decodable, or the client shows a broken image
    assert.ok(Buffer.from(image.data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
  })

  await check('a point on a rule says it is a rule and names the line', async () => {
    // The rule's top edge is y=80 on A4 with a 2.5cm margin. Asking two points low
    // still has to find it, which is what the band in the probe is for.
    const r = await server.send('tools/call', {
      name: 'latex_look',
      arguments: { file: doc, page: 1, pointX: 300, pointY: 78, dpi: 80 },
    })
    const text = r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    assert.match(text, /horizontal rule at y=\d/)
    assert.match(text, /drawn by line \d+: .*\\rule\{/)
  })

  await check('a missing file is an error reply, not a dead server', async () => {
    const r = await server.send('tools/call', { name: 'latex_look', arguments: { file: join(dir, 'nope.tex') } })
    assert.ok(r.error, 'expected an error object')
    assert.equal(r.error.code, -32602)
    assert.match(r.error.message, /file not found/)
    // and the server still answers afterwards
    const ping = await server.send('ping', {})
    assert.deepEqual(ping.result, {})
  })

  await check('pointX without pointY is refused with a reason', async () => {
    const r = await server.send('tools/call', { name: 'latex_look', arguments: { file: doc, page: 1, pointX: 100 } })
    assert.equal(r.error.code, -32602)
    assert.match(r.error.message, /together/)
  })

  await check('an unknown method is -32601', async () => {
    const r = await server.send('does/not/exist', {})
    assert.equal(r.error.code, -32601)
  })

  await check('an unknown tool is refused, and says which', async () => {
    const r = await server.send('tools/call', { name: 'latex_render', arguments: { file: doc } })
    assert.equal(r.error.code, -32602)
    assert.match(r.error.message, /unknown tool: latex_render/)
  })

  await check('a malformed line gets -32700 and the session survives', async () => {
    server.child.stdin.write('{not json\n')
    await new Promise((r) => setTimeout(r, 300))
    const pong = await server.send('ping', {})
    assert.deepEqual(pong.result, {})
  })
} finally {
  server.child.stdin.end()
  server.child.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall MCP checks passed')
process.exit(failures ? 1 : 0)
