#!/usr/bin/env node
// `latex-look mcp` — the MCP server entry point that Claude Desktop, Cursor and Codex
// launch. Everything it does lives in lib/mcp.mjs and lib/core.mjs.

import { serveStdio } from '../lib/mcp.mjs'

serveStdio().catch((e) => {
  process.stderr.write(`latex-look mcp: ${e instanceof Error ? e.stack || e.message : String(e)}\n`)
  process.exit(1)
})
