// Convert PPT/PPTX → PDF using LibreOffice headless (reliable, any deck).
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CANDIDATES = [
  process.env.SOFFICE_PATH,
  'C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  'C:/tools/LibreOfficePortable/App/libreoffice/program/soffice.exe',
  '/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice',
].filter(Boolean)

// only return a path that actually exists (no false positives)
export function findSoffice() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}
export const pptSupported = () => !!findSoffice()

export async function pptxToPdf(buffer, name = 'deck.pptx') {
  const soffice = findSoffice()
  if (!soffice) throw new Error('LibreOffice not installed')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'))
  const inFile = path.join(dir, (name || 'deck.pptx').replace(/[^\w.\-]/g, '_'))
  fs.writeFileSync(inFile, buffer)
  await new Promise((resolve, reject) =>
    execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', dir, inFile],
      { timeout: 90000 }, (e) => (e ? reject(e) : resolve())))
  const pdfFile = inFile.replace(/\.[^.]+$/, '.pdf')
  const pdf = fs.readFileSync(pdfFile)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return pdf
}
