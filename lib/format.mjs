// The reply a caller reads, shared by every front end: the DSH plugin, the CLI and the
// MCP server must describe the same measurement in the same words, or the three drift
// into three different tools.

/**
 * A moved page number is a whole-page change to the reader, yet it lights up about
 * 0.004% of the pixels: `toFixed(2)` printed "0.00%", which reads as "nothing
 * changed" — the one message this tool must never get wrong. Keep the precision the
 * change deserves, and say how many pixels actually differ.
 */
export function formatDiff(d) {
  if (!d.changedPixels) return '0% of the page (no pixel differs)'
  const pct = d.changedRatio * 100
  const text = pct >= 0.01 ? pct.toFixed(2) : pct >= 0.001 ? pct.toFixed(3) : pct.toFixed(4)
  return `${text}% of the page changed (${d.changedPixels} px)`
}

export function formatResult(r, { hint = null } = {}) {
  const L = []
  L.push(`${r.ok ? 'OK' : 'FAILED'} — ${r.file}`)
  L.push(`engine: ${r.engine} | ${r.cached ? 'reused (nothing changed since the last build)' : `passes: ${r.passes}`} | pages: ${r.pages ?? '?'} | showing page ${r.page}`)
  if (r.toc?.expected) L.push(`toc: ${r.toc.entries ?? 0} entries`)
  if (r.aux?.length) {
    L.push(`aux: ${r.aux.map((a) => `${a.tool}${a.ok ? '' : ' FAILED'}`).join(', ')}`)
  }
  if (r.images?.after) L.push(`image (open it with an image reader): ${r.images.after}`)
  if (r.images?.before) L.push(`image before the edit: ${r.images.before}`)
  if (r.images?.sideBySide) L.push(`before | after in one image: ${r.images.sideBySide}`)
  if (r.fatal) L.push(`FATAL: ${r.fatal}`)
  if (r.sequence && !r.sequence.error) {
    L.push('')
    if (r.sequence.unreliable) {
      L.push(`ORDER: cannot check the order — ${r.sequence.unreliable}`)
      L.push('  Nothing is reported as in order, because nothing was read.')
    } else if (!r.sequence.inversions.length) {
      L.push(`ORDER: ${r.sequence.total} ${r.sequence.label}-label(s), all in reading order`)
    } else {
      L.push(`ORDER: ${r.sequence.inversions.length} inversion(s) — the numbers go backwards on the page:`)
      for (const v of r.sequence.inversions.slice(0, 8)) {
        L.push(`  ${v.before.label} is on page ${v.before.page}, but ${v.after.label} is on page ${v.after.page}`)
      }
    }
  }
  if (r.audit) {
    if (r.audit.error) L.push(`AUDIT FAILED: ${r.audit.error}`)
    else if (r.audit.calibration) {
      L.push(`AUDIT: cannot measure — ${r.audit.calibration}`)
      L.push('  Nothing is reported as fine, because nothing was compared.')
    } else if (!r.audit.hadBaseline) {
      L.push('')
      const why = r.audit.repaginatedFrom
        ? `the baseline was a ${r.audit.repaginatedFrom}-page build and this one has ${r.audit.pages}: the document repaginated, so findings are matched by the text at the break, not by page number`
        : `no baseline yet`
      L.push(`AUDIT (baseline recorded: ${r.audit.findings.length} page(s) currently stop short, ${r.audit.sectionEnds} of them at a chapter or section end)`)
      L.push(`      ${why} — nothing is reported as new until the next build to compare against`)
      L.push('      the next audit will only report what THIS build changed')
    } else if (!r.audit.newFindings.length) {
      L.push('')
      L.push(`AUDIT: nothing new — the same ${r.audit.findings.length} page(s) stop short, none introduced by this build`)
    } else {
      L.push('')
      L.push(`AUDIT: ${r.audit.newFindings.length} NEW layout finding(s) introduced by this build (of ${r.audit.findings.length} in total)`)
      for (const f of r.audit.newFindings.slice(0, 10)) {
        L.push(`  ${f.kind} page ${f.page}: ${f.mm.toFixed(0)}mm — ${f.detail}`)
        if (f.lastLine) L.push(`      the page ends with: …${f.lastLine.slice(-40)}`)
      }
    }
  }
  if (r.compareError) L.push(`COMPARE: ${r.compareError}`)
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
      // Say when SyncTeX was overruled: a silently corrected page hides a real
      // limitation of the source→PDF mapping.
      const fixed =
        h.pageVerified && h.synctexPage && h.synctexPage !== h.page
          ? ` (SyncTeX said ${h.synctexPage}; the page text says otherwise)`
          : ''
      L.push(`  ${h.file}:${h.line} → page ${h.page}${y}${fixed}`)
      if (h.ink && h.ink.kind === 'rule' && h.ink.origin === 'command' && h.ink.sourceLine) {
        L.push(`      ^ ink at this point: horizontal rule at y=${h.ink.y}pt, ${Math.round(h.ink.span * 100)}% of page width`)
        L.push(`        drawn by line ${h.ink.sourceLine.line}: ${h.ink.sourceLine.text}`)
      } else if (h.ink && h.ink.kind === 'rule') {
        // Facts only: what to do about a rule is the reader's knowledge, not the
        // tool's. A hint here would be wrong on any document that does not match it.
        L.push(`      ^ ink at this point: horizontal rule at y=${h.ink.y}pt, ${Math.round(h.ink.span * 100)}% of page width`)
        L.push(`        no rule-drawing command on line ${h.line} or any of the 4 lines around it`)
        L.push('        so it is drawn somewhere else: a package, the page style, or a macro')
      } else if (h.ink && h.ink.kind === 'blank') {
        L.push('      ^ ink at this point: none (blank paper; the nearest box belongs to a different spot)')
      }
    }
  }
  if (r.diff) {
    const b = r.diff.bbox
    L.push('')
    L.push(
      `DIFF: ${formatDiff(r.diff)}` +
        (b ? ` | bbox x=${b.x} y=${b.y} w=${b.width} h=${b.height} (PDF points, origin top-left)` : ''),
    )
  }
  if (hint) {
    L.push('')
    L.push(hint)
  }
  return L.join('\n')
}
