// Extract plain text from a PDF (pure Node, pdf-parse v2). Accepts a Buffer.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { PDFParse } = require('pdf-parse')

export async function extractPdfText(buffer) {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    const res = await parser.getText()
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
