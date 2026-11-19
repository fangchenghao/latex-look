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
  const resolution = d.dpi ? ` at ${d.dpi} dpi` : ''
  if (!d.changedPixels) return `0% of the page (no pixel differs)${resolution}`
  const pct = d.changedRatio * 100
  const places = Math.max(2, Math.ceil(-Math.log10(pct)))
  return `${pct.toFixed(places)}% of the page changed (${d.changedPixels} px)${resolution}`
}

export function formatPointInk({ ink, line }) {
  if (ink?.kind === 'blank') return ['      ^ ink at this point: none (blank paper; the nearest box belongs to a different spot)']
  if (ink?.kind !== 'rule') return []
  return [
    `      ^ ink at this point: horizontal rule at y=${ink.y}pt, ${Math.round(ink.span * 100)}% of page width`,
    ink.origin === 'command' && ink.sourceLine
      ? `        drawn by line ${ink.sourceLine.line}: ${ink.sourceLine.text}`
      : `        line ${line} is the nearest SyncTeX box. The source of this rule is unconfirmed.`,
  ]
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
  if (r.sequence) {
    L.push('')
    if (r.sequence.error || r.sequence.unreliable) {
      L.push(`ORDER: cannot check the order — ${r.sequence.error || r.sequence.unreliable}`)
      L.push('  Nothing is reported as in order, because the check is incomplete.')
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
      L.push(`AUDIT (baseline recorded at ${r.audit.blankMm} mm) — ${r.audit.findings.length} layout finding(s) and ${r.audit.sectionEnds} section end(s)`)
      if (r.audit.baselineNote) L.push(`      ${r.audit.baselineNote}`)
    } else if (!r.audit.newFindings.length) {
      L.push('')
      L.push(`AUDIT: nothing new or worse since the previous audited PDF (${r.audit.findings.length} layout finding(s) at ${r.audit.blankMm} mm)`)
    } else {
      L.push('')
      const change = r.audit.newFindings.some(f => f.previousMm != null) ? 'new or worsened' : 'NEW'
      L.push(`AUDIT: ${r.audit.newFindings.length} ${change} layout finding(s) since the previous audited PDF (threshold ${r.audit.blankMm} mm)`)
      for (const f of r.audit.newFindings.slice(0, 10)) {
        const previous = f.previousMm != null ? ` (previously ${f.previousMm.toFixed(0)} mm)` : ''
        L.push(`  ${f.kind} page ${f.page}: ${f.mm.toFixed(0)} mm${previous} — ${f.detail}`)
        if (f.lastLine) L.push(`      the page ends with: …${f.lastLine.slice(-40)}`)
      }
    }
    if (r.audit.repaginatedFrom) L.push(`  PDF page count changed from ${r.audit.repaginatedFrom} to ${r.audit.pages}.`)
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
      L.push(...formatPointInk(h))
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
