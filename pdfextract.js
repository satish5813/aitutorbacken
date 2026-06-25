// Extract plain text from a PDF (pure Node, pdf-parse v1 — works on Node 18+ with no
// browser polyfills). Import the inner lib directly to skip v1's index.js debug block
// (which otherwise tries to read a bundled test PDF and crashes).
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pdf = require('pdf-parse/lib/pdf-parse.js')

export async function extractPdfText(buffer) {
  try {
    const res = await pdf(buffer)
    const text = (res.text || '').replace(/\n{3,}/g, '\n\n').trim()
    return text || null
  } catch {
    return null
  }
}

// split extracted text into display blocks: short lines = headings, rest = paragraphs
export function textToBlocks(text) {
  if (!text) return []
  return text.split(/\n\s*\n|\n/).map((l) => l.trim()).filter(Boolean)
    .map((line) => ({ t: line.length < 60 && !/[.!?]$/.test(line) ? 'h' : 'p', x: line }))
}
