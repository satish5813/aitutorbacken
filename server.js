import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'

import { q } from './db.js'
import { signToken, auth, requireRole, ownsCourse, ownsModule, isEnrolled } from './auth.js'
import { fetchTranscript, extractVideoId } from './transcript.js'
import { translateTexts, LANGUAGES } from './translate.js'
import { extractPdfText } from './pdfextract.js'
import { r2Enabled, putObject, getObjectStream, deleteObject } from './r2.js'
import { migrate } from './migrate.js'
import { pptxToPdf, pptSupported } from './pptconvert.js'

// read a stored file (R2 or local) into a Buffer
async function readStored(storagePath) {
  const local = path.join(UPLOAD_DIR, storagePath)
  if (r2Enabled) {
    try {
      const { stream } = await getObjectStream(storagePath)
      const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks)
    } catch { if (fs.existsSync(local)) return fs.readFileSync(local); throw new Error('file not found') }
  }
  if (fs.existsSync(local)) return fs.readFileSync(local)
  throw new Error('file not found')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

// files are held in memory then pushed to R2 (or local disk as fallback)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })

// store an uploaded buffer; returns the storage key/path
async function storeFile(buffer, key, contentType) {
  if (r2Enabled) { await putObject(key, buffer, contentType); return key }
  const dest = path.join(UPLOAD_DIR, key)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buffer)
  return key
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e)
    res.status(500).json({ error: e.message || 'Server error' })
  })

// ===================================================================
// TRANSLATION (public — used for transcript/report language switch)
// ===================================================================
app.get('/api/languages', (_req, res) => res.json(LANGUAGES))

app.post('/api/translate', wrap(async (req, res) => {
  const { texts, lang } = req.body
  if (!Array.isArray(texts)) return res.status(400).json({ error: 'texts[] required' })
  res.json({ lang, texts: await translateTexts(texts, lang) })
}))

// ===================================================================
// AUTH
// ===================================================================
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body
  // accept email OR registration id as the login identifier
  const rows = await q('SELECT * FROM users WHERE email=? OR reg_id=? LIMIT 1', [email, email])
  const user = rows[0]
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid login or password' })
  if (!user.is_active)
    return res.status(403).json({ error: 'Account is deactivated. Contact the admin.' })
  const token = signToken(user)
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
}))

app.get('/api/auth/me', auth, wrap(async (req, res) => {
  const rows = await q('SELECT id, name, email, role FROM users WHERE id=?', [req.user.id])
  res.json(rows[0] || null)
}))

// ===================================================================
// ADMIN — courses
// ===================================================================
app.get('/api/courses', auth, requireRole('admin'), wrap(async (_req, res) => {
  res.json(await q(`
    SELECT c.id, c.title, c.description, c.code, c.academic_year, c.year, c.sem, c.created_at,
      (SELECT GROUP_CONCAT(u.name SEPARATOR ', ') FROM faculty_course fc JOIN users u ON u.id=fc.faculty_id WHERE fc.course_id=c.id) AS faculty
    FROM courses c ORDER BY c.academic_year DESC, c.year, c.sem, c.title`))
}))

app.post('/api/courses', auth, requireRole('admin'), wrap(async (req, res) => {
  const { title, description, code, academic_year, year, sem } = req.body
  if (!title) return res.status(400).json({ error: 'Course name required' })
  const r = await q(
    'INSERT INTO courses (title, description, code, academic_year, year, sem, created_by) VALUES (?,?,?,?,?,?,?)',
    [title, description || null, code || null, academic_year || null, year || null, sem || null, req.user.id])
  res.json({ id: r.insertId })
}))

app.patch('/api/courses/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const { title, description, code, academic_year, year, sem } = req.body
  await q(`UPDATE courses SET title=COALESCE(?,title), description=?, code=?, academic_year=?, year=?, sem=? WHERE id=?`,
    [title ?? null, description || null, code || null, academic_year || null, year || null, sem || null, req.params.id])
  res.json({ ok: true })
}))

// bulk create: body = { courses: [{title, description}, ...] }
app.post('/api/courses/bulk', auth, requireRole('admin'), wrap(async (req, res) => {
  const list = (req.body.courses || [])
    .map((c) => ({ title: String(c.title || '').trim(), description: c.description || null }))
    .filter((c) => c.title)
  if (list.length === 0) return res.status(400).json({ error: 'No valid course titles found' })
  for (const c of list)
    await q('INSERT INTO courses (title, description, created_by) VALUES (?,?,?)',
      [c.title, c.description, req.user.id])
  res.json({ added: list.length })
}))

app.delete('/api/courses/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  await q('DELETE FROM courses WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

// ===================================================================
// ADMIN — users / faculty
// ===================================================================
app.get('/api/users', auth, requireRole('admin'), wrap(async (_req, res) => {
  res.json(await q('SELECT id, name, email, reg_id, role, is_active FROM users ORDER BY role, name'))
}))

// ---- SELF profile (any logged-in user) ----
app.patch('/api/me', auth, wrap(async (req, res) => {
  const { name, email } = req.body
  try {
    await q('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email) WHERE id=?',
      [name ?? null, email ? email.toLowerCase() : null, req.user.id])
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already in use' })
    throw e
  }
  const rows = await q('SELECT id, name, email, role FROM users WHERE id=?', [req.user.id])
  res.json(rows[0])
}))

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' })
  const rows = await q('SELECT password_hash FROM users WHERE id=?', [req.user.id])
  if (!(await bcrypt.compare(current_password || '', rows[0].password_hash)))
    return res.status(400).json({ error: 'Current password is incorrect' })
  const hash = await bcrypt.hash(new_password, 10)
  await q('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id])
  res.json({ ok: true })
}))

// ---- ADMIN overrides on any user ----
app.patch('/api/users/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, email, role } = req.body
  try {
    await q('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), role=COALESCE(?,role) WHERE id=?',
      [name ?? null, email ? email.toLowerCase() : null, role ?? null, req.params.id])
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already in use' })
    throw e
  }
  res.json({ ok: true })
}))

app.post('/api/users/:id/password', auth, requireRole('admin'), wrap(async (req, res) => {
  const { new_password } = req.body
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  const hash = await bcrypt.hash(new_password, 10)
  await q('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.id])
  res.json({ ok: true })
}))

app.patch('/api/users/:id/active', auth, requireRole('admin'), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'You cannot deactivate your own account' })
  await q('UPDATE users SET is_active=? WHERE id=?', [req.body.is_active ? 1 : 0, req.params.id])
  res.json({ ok: true })
}))

app.delete('/api/users/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'You cannot delete your own account' })
  await q('DELETE FROM users WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

app.post('/api/faculty', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' })
  const hash = await bcrypt.hash(password, 10)
  try {
    const r = await q('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
      [name, email.toLowerCase(), hash, 'faculty'])
    res.json({ id: r.insertId })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' })
    throw e
  }
}))

app.patch('/api/users/:id/role', auth, requireRole('admin'), wrap(async (req, res) => {
  const { role } = req.body
  await q('UPDATE users SET role=? WHERE id=?', [role, req.params.id])
  res.json({ ok: true })
}))

// ===================================================================
// ADMIN — faculty<->course mapping
// ===================================================================
app.get('/api/mappings', auth, requireRole('admin'), wrap(async (_req, res) => {
  res.json(await q(`
    SELECT fc.faculty_id, fc.course_id, u.name AS faculty_name, u.email AS faculty_email, c.title AS course_title
    FROM faculty_course fc
    JOIN users u ON u.id = fc.faculty_id
    JOIN courses c ON c.id = fc.course_id`))
}))

app.post('/api/mappings', auth, requireRole('admin'), wrap(async (req, res) => {
  const { faculty_id, course_id } = req.body
  await q('INSERT IGNORE INTO faculty_course (faculty_id, course_id) VALUES (?,?)', [faculty_id, course_id])
  res.json({ ok: true })
}))

app.delete('/api/mappings', auth, requireRole('admin'), wrap(async (req, res) => {
  const { faculty_id, course_id } = req.body
  await q('DELETE FROM faculty_course WHERE faculty_id=? AND course_id=?', [faculty_id, course_id])
  res.json({ ok: true })
}))

// ===================================================================
// FACULTY — my courses + management
// ===================================================================
app.get('/api/my-courses', auth, wrap(async (req, res) => {
  if (req.user.role === 'admin')
    return res.json(await q('SELECT id, title, description FROM courses ORDER BY title'))
  res.json(await q(`
    SELECT c.id, c.title, c.description FROM courses c
    JOIN faculty_course fc ON fc.course_id = c.id
    WHERE fc.faculty_id = ? ORDER BY c.title`, [req.user.id]))
}))

app.get('/api/courses/:id', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  const rows = await q('SELECT id, title, description FROM courses WHERE id=?', [req.params.id])
  res.json(rows[0] || null)
}))

// ---- modules (Course → Modules → Sessions) ----
app.get('/api/courses/:id/modules', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  res.json(await q(`
    SELECT m.id, m.title, m.order_no,
      (SELECT COUNT(*) FROM sessions s WHERE s.module_id = m.id) AS session_count
    FROM modules m WHERE m.course_id=? ORDER BY m.order_no`, [req.params.id]))
}))

app.post('/api/courses/:id/modules', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  const cnt = await q('SELECT COUNT(*) AS n FROM modules WHERE course_id=?', [req.params.id])
  const r = await q('INSERT INTO modules (course_id, title, order_no) VALUES (?,?,?)',
    [req.params.id, req.body.title || 'Module', cnt[0].n + 1])
  res.json({ id: r.insertId })
}))

app.post('/api/courses/:id/modules/bulk', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  let titles = req.body.titles
  if (!Array.isArray(titles) && req.body.count) {
    const prefix = (req.body.prefix || 'Module').trim()
    titles = Array.from({ length: Math.min(Number(req.body.count) || 0, 50) }, (_, i) => `${prefix} ${i + 1}`)
  }
  titles = (titles || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 50)
  if (!titles.length) return res.status(400).json({ error: 'Add at least one module name' })
  const cnt = await q('SELECT COUNT(*) AS n FROM modules WHERE course_id=?', [req.params.id])
  let order = cnt[0].n
  for (const title of titles) { order++; await q('INSERT INTO modules (course_id, title, order_no) VALUES (?,?,?)', [req.params.id, title, order]) }
  res.json({ added: titles.length })
}))

app.patch('/api/modules/:id', auth, wrap(async (req, res) => {
  if (!(await ownsModule(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  await q('UPDATE modules SET title=? WHERE id=?', [String(req.body.title || '').trim() || 'Module', req.params.id])
  res.json({ ok: true })
}))

app.delete('/api/modules/:id', auth, wrap(async (req, res) => {
  if (!(await ownsModule(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  await q('DELETE FROM modules WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

// sessions within a module (+ nested contents)
app.get('/api/modules/:id/sessions', auth, wrap(async (req, res) => {
  if (!(await ownsModule(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const sessions = await q('SELECT id, title, order_no FROM sessions WHERE module_id=? ORDER BY order_no', [req.params.id])
  for (const s of sessions) {
    s.contents = await q(
      'SELECT id, type, title, url, storage_path, order_no, transcript, text_content, quiz_json FROM contents WHERE session_id=? ORDER BY order_no',
      [s.id])
  }
  res.json(sessions)
}))

app.post('/api/modules/:id/sessions', auth, wrap(async (req, res) => {
  if (!(await ownsModule(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const m = await q('SELECT course_id FROM modules WHERE id=?', [req.params.id])
  const cnt = await q('SELECT COUNT(*) AS n FROM sessions WHERE module_id=?', [req.params.id])
  const r = await q('INSERT INTO sessions (course_id, module_id, title, order_no) VALUES (?,?,?,?)',
    [m[0].course_id, req.params.id, req.body.title || 'Session', cnt[0].n + 1])
  res.json({ id: r.insertId })
}))

app.post('/api/modules/:id/sessions/bulk', auth, wrap(async (req, res) => {
  if (!(await ownsModule(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  let titles = req.body.titles
  if (!Array.isArray(titles) && req.body.count) {
    const prefix = (req.body.prefix || 'Session').trim()
    titles = Array.from({ length: Math.min(Number(req.body.count) || 0, 50) }, (_, i) => `${prefix} ${i + 1}`)
  }
  titles = (titles || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 50)
  if (!titles.length) return res.status(400).json({ error: 'Add at least one session name' })
  const m = await q('SELECT course_id FROM modules WHERE id=?', [req.params.id])
  const cnt = await q('SELECT COUNT(*) AS n FROM sessions WHERE module_id=?', [req.params.id])
  let order = cnt[0].n
  for (const title of titles) { order++; await q('INSERT INTO sessions (course_id, module_id, title, order_no) VALUES (?,?,?,?)', [m[0].course_id, req.params.id, title, order]) }
  res.json({ added: titles.length })
}))

// sessions (+ nested contents) for a course
app.get('/api/courses/:id/sessions', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  const sessions = await q('SELECT id, title, order_no FROM sessions WHERE course_id=? ORDER BY order_no', [req.params.id])
  for (const s of sessions) {
    s.contents = await q(
      'SELECT id, type, title, url, storage_path, order_no, transcript, text_content, quiz_json FROM contents WHERE session_id=? ORDER BY order_no',
      [s.id])
  }
  res.json(sessions)
}))

app.post('/api/courses/:id/sessions', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  const { title } = req.body
  const cnt = await q('SELECT COUNT(*) AS n FROM sessions WHERE course_id=?', [req.params.id])
  const r = await q('INSERT INTO sessions (course_id, title, order_no) VALUES (?,?,?)',
    [req.params.id, title, cnt[0].n + 1])
  res.json({ id: r.insertId })
}))

// bulk create sessions. Body: { titles:[...] }  OR  { count:N, prefix:"Session" }
app.post('/api/courses/:id/sessions/bulk', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  let titles = req.body.titles
  if (!Array.isArray(titles) && req.body.count) {
    const prefix = (req.body.prefix || 'Session').trim()
    titles = Array.from({ length: Math.min(Number(req.body.count) || 0, 50) }, (_, i) => `${prefix} ${i + 1}`)
  }
  titles = (titles || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 50)
  if (titles.length === 0) return res.status(400).json({ error: 'Add at least one session name' })
  const cnt = await q('SELECT COUNT(*) AS n FROM sessions WHERE course_id=?', [req.params.id])
  let order = cnt[0].n
  for (const title of titles) {
    order++
    await q('INSERT INTO sessions (course_id, title, order_no) VALUES (?,?,?)', [req.params.id, title, order])
  }
  res.json({ added: titles.length })
}))

app.patch('/api/sessions/:id', auth, wrap(async (req, res) => {
  const rows = await q('SELECT course_id FROM sessions WHERE id=?', [req.params.id])
  if (!rows[0] || !(await ownsCourse(req.user, rows[0].course_id)))
    return res.status(403).json({ error: 'Forbidden' })
  await q('UPDATE sessions SET title=? WHERE id=?', [String(req.body.title || '').trim() || 'Session', req.params.id])
  res.json({ ok: true })
}))

app.delete('/api/sessions/:id', auth, wrap(async (req, res) => {
  const rows = await q('SELECT course_id FROM sessions WHERE id=?', [req.params.id])
  if (!rows[0] || !(await ownsCourse(req.user, rows[0].course_id)))
    return res.status(403).json({ error: 'Forbidden' })
  await q('DELETE FROM sessions WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

// add content — YouTube (json) OR file upload (multipart)
// route carries courseId + session id so multer can path the file
app.post('/api/courses/:courseId/sessions/:id/contents',
  auth, upload.single('file'), wrap(async (req, res) => {
    if (!(await ownsCourse(req.user, req.params.courseId)))
      return res.status(403).json({ error: 'Forbidden' })
    const { type, title, url } = req.body
    const cnt = await q('SELECT COUNT(*) AS n FROM contents WHERE session_id=?', [req.params.id])
    const order_no = cnt[0].n + 1

    // store the uploaded file in R2 (key: course/session/timestamp-name)
    let storage_path = null
    if (req.file) {
      const safe = req.file.originalname.replace(/[^\w.\-]/g, '_')
      const key = `${req.params.courseId}/${req.params.id}/${Date.now()}-${safe}`
      await storeFile(req.file.buffer, key, req.file.mimetype)
      storage_path = key
    }
    const r = await q(
      'INSERT INTO contents (session_id, type, title, url, storage_path, order_no) VALUES (?,?,?,?,?,?)',
      [req.params.id, type, title || null, url || null, storage_path, order_no])

    // auto-generate transcript for YouTube links
    let transcript = null
    if (type === 'youtube' && url) {
      const vid = extractVideoId(url)
      if (vid) {
        const tr = await fetchTranscript(vid)   // [[seconds, text], ...] or null
        if (tr) {
          transcript = tr
          await q('UPDATE contents SET transcript=? WHERE id=?', [JSON.stringify(tr), r.insertId])
        }
      }
    }
    // auto-extract text from uploaded PDF reports
    let textLen = 0
    if (type === 'pdf' && req.file) {
      const text = await extractPdfText(req.file.buffer)
      if (text) {
        textLen = text.length
        await q('UPDATE contents SET text_content=? WHERE id=?', [text, r.insertId])
      }
    }
    res.json({ id: r.insertId, transcript_generated: !!transcript, lines: transcript?.length || 0, pdf_text_chars: textLen })
  }))

// (re)generate transcript for an existing YouTube content
app.post('/api/contents/:id/transcript', auth, wrap(async (req, res) => {
  const rows = await q(`
    SELECT c.url, s.course_id FROM contents c JOIN sessions s ON s.id=c.session_id WHERE c.id=?`,
    [req.params.id])
  if (!rows[0] || !(await ownsCourse(req.user, rows[0].course_id)))
    return res.status(403).json({ error: 'Forbidden' })
  const vid = extractVideoId(rows[0].url)
  if (!vid) return res.status(400).json({ error: 'Not a valid YouTube link' })
  const tr = await fetchTranscript(vid)
  if (!tr) return res.status(404).json({ error: 'No transcript/captions available for this video' })
  await q('UPDATE contents SET transcript=? WHERE id=?', [JSON.stringify(tr), req.params.id])
  res.json({ ok: true, lines: tr.length })
}))

app.delete('/api/contents/:id', auth, wrap(async (req, res) => {
  const rows = await q(`
    SELECT c.storage_path, s.course_id FROM contents c JOIN sessions s ON s.id=c.session_id WHERE c.id=?`,
    [req.params.id])
  if (!rows[0] || !(await ownsCourse(req.user, rows[0].course_id)))
    return res.status(403).json({ error: 'Forbidden' })
  if (r2Enabled && rows[0].storage_path) await deleteObject(rows[0].storage_path)
  await q('DELETE FROM contents WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

// ===================================================================
// QUIZ — max 10 questions per quiz (topic)
// ===================================================================
const MAX_QUIZ = 10

function sanitizeQuestions(list) {
  return (list || [])
    .map((qq) => ({
      q: String(qq.q || '').trim(),
      opts: (qq.opts || []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 4),
      a: Number(qq.a) || 0,
    }))
    .filter((qq) => qq.q && qq.opts.length >= 2)
    .slice(0, MAX_QUIZ)
}

// parse a quiz CSV: columns question,optionA,optionB,optionC,optionD,answer(1-4)
function parseQuizCsv(raw) {
  const rows = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (rows[0] && /question/i.test(rows[0]) && /option/i.test(rows[0])) rows.shift()
  const line = (s) => { const o = []; let c = '', q = false; for (const ch of s) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = '' } else c += ch } o.push(c); return o.map((x) => x.trim()) }
  return sanitizeQuestions(rows.map((l) => {
    const c = line(l)
    return { q: c[0], opts: [c[1], c[2], c[3], c[4]].filter(Boolean), a: (Number(c[5]) || 1) - 1 }
  }))
}

// keep a copy of an imported CSV in storage + log it
async function logImport(type, file, courseId, count, user) {
  let key = null
  try {
    key = `imports/${type}/${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`
    await storeFile(file.buffer, key, 'text/csv')
  } catch { /* storage best-effort */ }
  await q('INSERT INTO import_logs (type, filename, course_id, row_count, r2_key, uploaded_by) VALUES (?,?,?,?,?,?)',
    [type, file.originalname, courseId || null, count, key, user.id])
  return key
}

// PREVIEW a quiz CSV without saving (faculty verifies before committing)
app.post('/api/quiz/parse-csv', auth, requireRole('admin', 'faculty'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' })
  const questions = parseQuizCsv(req.file.buffer.toString('utf8'))
  if (questions.length === 0) return res.status(400).json({ error: 'No valid questions found in the CSV' })
  await logImport('quiz', req.file, null, questions.length, req.user)   // keep the CSV
  res.json({ questions, count: questions.length, max: MAX_QUIZ })
}))

// import history (admin)
app.get('/api/imports', auth, requireRole('admin'), wrap(async (_req, res) => {
  res.json(await q(`SELECT il.id, il.type, il.filename, il.row_count, il.created_at, u.name AS uploaded_by
    FROM import_logs il LEFT JOIN users u ON u.id=il.uploaded_by ORDER BY il.created_at DESC LIMIT 100`))
}))

// create a quiz content (JSON body): { title, questions:[{q,opts[],a}] }
app.post('/api/courses/:courseId/sessions/:id/quiz', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.courseId)))
    return res.status(403).json({ error: 'Forbidden' })
  const questions = sanitizeQuestions(req.body.questions)
  if (questions.length === 0) return res.status(400).json({ error: 'Add at least one valid question' })
  if ((req.body.questions || []).length > MAX_QUIZ)
    return res.status(400).json({ error: `A quiz can have at most ${MAX_QUIZ} questions` })
  const cnt = await q('SELECT COUNT(*) AS n FROM contents WHERE session_id=?', [req.params.id])
  const r = await q(
    'INSERT INTO contents (session_id, type, title, quiz_json, order_no) VALUES (?,?,?,?,?)',
    [req.params.id, 'quiz', req.body.title || 'Quiz', JSON.stringify(questions), cnt[0].n + 1])
  res.json({ id: r.insertId, questions: questions.length, max: MAX_QUIZ })
}))

// bulk quiz via CSV upload (direct save): columns = question,optionA-D,answer(1-4)
app.post('/api/courses/:courseId/sessions/:id/quiz/csv',
  auth, upload.single('file'), wrap(async (req, res) => {
    if (!(await ownsCourse(req.user, req.params.courseId)))
      return res.status(403).json({ error: 'Forbidden' })
    if (!req.file) return res.status(400).json({ error: 'CSV file required' })
    const questions = parseQuizCsv(req.file.buffer.toString('utf8'))
    if (questions.length === 0) return res.status(400).json({ error: 'No valid rows found in CSV' })
    await logImport('quiz', req.file, req.params.courseId, questions.length, req.user)
    const cnt = await q('SELECT COUNT(*) AS n FROM contents WHERE session_id=?', [req.params.id])
    const r = await q(
      'INSERT INTO contents (session_id, type, title, quiz_json, order_no) VALUES (?,?,?,?,?)',
      [req.params.id, 'quiz', req.body.title || 'Quiz (CSV)', JSON.stringify(questions), cnt[0].n + 1])
    res.json({ id: r.insertId, questions: questions.length, max: MAX_QUIZ })
  }))

// downloadable CSV quiz template
app.get('/api/quiz-template.csv', (_req, res) => {
  const csv = [
    'question,optionA,optionB,optionC,optionD,answer(1-4)',
    'What is the primary goal of management?,Maximise long-term value,Avoid all risk,Reduce staff,Ignore customers,1',
    'A good decision is based on?,Data and analysis,Luck,Mood,Colour,1',
  ].join('\n')
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="quiz-template.csv"')
  res.send(csv)
})

// ---- students (faculty manages students enrolled in their course) ----
const DEFAULT_STUDENT_PW = 'student123'

// list enrolled students, joined with their account (reg id + name + status)
app.get('/api/courses/:id/students', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  res.json(await q(`
    SELECT e.id AS enrollment_id, e.student_email,
           u.id AS user_id, u.name, u.reg_id, u.is_active
    FROM enrollments e
    LEFT JOIN users u ON LOWER(u.email) = LOWER(e.student_email)
    WHERE e.course_id = ?
    ORDER BY e.student_email`, [req.params.id]))
}))

// bulk add students: creates a student ACCOUNT (default password student123) if
// missing, and enrolls them. Body: { students: [{name, reg_id, email}] }
app.post('/api/courses/:id/students', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })

  let students = req.body.students
  if (!students && Array.isArray(req.body.emails))
    students = req.body.emails.map((email) => ({ email }))
  students = (students || [])
    .map((s) => ({
      email: String(s.email || '').trim().toLowerCase(),
      name: (s.name || '').trim(),
      reg_id: (s.reg_id || '').trim() || null,
      password: s.password || DEFAULT_STUDENT_PW,
    }))
    .filter((s) => s.email)

  let enrolled = 0, accountsCreated = 0
  for (const s of students) {
    const exists = await q('SELECT id FROM users WHERE email=? LIMIT 1', [s.email])
    if (exists.length === 0) {
      const hash = await bcrypt.hash(s.password, 10)
      await q('INSERT INTO users (name, email, reg_id, password_hash, role) VALUES (?,?,?,?,?)',
        [s.name || s.email.split('@')[0], s.email, s.reg_id, hash, 'student'])
      accountsCreated++
    } else if (s.reg_id) {
      await q('UPDATE users SET reg_id=COALESCE(reg_id,?), name=COALESCE(NULLIF(name,""),?) WHERE email=?',
        [s.reg_id, s.name, s.email])
    }
    const r = await q('INSERT IGNORE INTO enrollments (course_id, student_email) VALUES (?,?)',
      [req.params.id, s.email])
    if (r.affectedRows) enrolled++
  }
  res.json({ enrolled, accountsCreated, defaultPassword: DEFAULT_STUDENT_PW })
}))

// activate / deactivate a student account (faculty, scoped to their course)
app.patch('/api/courses/:id/students/:userId/active', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  // ensure the target user is a student enrolled in THIS course
  const rows = await q(`
    SELECT u.id FROM users u
    JOIN enrollments e ON LOWER(e.student_email) = LOWER(u.email)
    WHERE u.id=? AND e.course_id=? AND u.role='student' LIMIT 1`,
    [req.params.userId, req.params.id])
  if (rows.length === 0) return res.status(404).json({ error: 'Student not found in this course' })
  await q('UPDATE users SET is_active=? WHERE id=?', [req.body.is_active ? 1 : 0, req.params.userId])
  res.json({ ok: true })
}))

// reset a student's password (faculty, scoped to their course)
app.post('/api/courses/:id/students/:userId/password', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' })
  const { new_password } = req.body
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  const rows = await q(`
    SELECT u.id FROM users u
    JOIN enrollments e ON LOWER(e.student_email) = LOWER(u.email)
    WHERE u.id=? AND e.course_id=? AND u.role='student' LIMIT 1`,
    [req.params.userId, req.params.id])
  if (rows.length === 0) return res.status(404).json({ error: 'Student not found in this course' })
  const hash = await bcrypt.hash(new_password, 10)
  await q('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.userId])
  res.json({ ok: true })
}))

app.delete('/api/enrollments/:id', auth, wrap(async (req, res) => {
  const rows = await q('SELECT course_id FROM enrollments WHERE id=?', [req.params.id])
  if (!rows[0] || !(await ownsCourse(req.user, rows[0].course_id)))
    return res.status(403).json({ error: 'Forbidden' })
  await q('DELETE FROM enrollments WHERE id=?', [req.params.id])
  res.json({ ok: true })
}))

// ===================================================================
// STUDENT (mobile) — enrolled courses + content
// ===================================================================
app.get('/api/student/courses', auth, wrap(async (req, res) => {
  res.json(await q(`
    SELECT c.id, c.title, c.description, c.code, c.academic_year, c.year, c.sem FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    WHERE LOWER(e.student_email) = LOWER(?) ORDER BY c.year, c.sem, c.title`, [req.user.email]))
}))

app.get('/api/student/courses/:id/sessions', auth, wrap(async (req, res) => {
  if (!(await isEnrolled(req.user, req.params.id)))
    return res.status(403).json({ error: 'Not enrolled in this course' })
  const sessions = await q('SELECT id, title, order_no FROM sessions WHERE course_id=? ORDER BY order_no', [req.params.id])
  for (const s of sessions) {
    s.contents = await q(
      'SELECT id, type, title, url, storage_path, order_no, transcript, text_content, quiz_json FROM contents WHERE session_id=? ORDER BY order_no',
      [s.id])
  }
  res.json(sessions)
}))

// student: course organized MODULE → SESSION → CONTENT (for the web portal)
app.get('/api/student/courses/:id/modules', auth, wrap(async (req, res) => {
  if (!(await isEnrolled(req.user, req.params.id)))
    return res.status(403).json({ error: 'Not enrolled in this course' })
  const cid = req.params.id
  const modules = await q('SELECT id, title, order_no FROM modules WHERE course_id=? ORDER BY order_no', [cid])
  // sessions not in any module → grouped under a virtual "General" module (id 0)
  modules.push({ id: 0, title: 'General', order_no: 9999 })
  const out = []
  for (const m of modules) {
    const sessions = m.id === 0
      ? await q('SELECT id, title, order_no FROM sessions WHERE course_id=? AND module_id IS NULL ORDER BY order_no', [cid])
      : await q('SELECT id, title, order_no FROM sessions WHERE module_id=? ORDER BY order_no', [m.id])
    for (const s of sessions) {
      s.contents = await q(
        'SELECT id, type, title, url, storage_path, order_no, transcript, text_content, quiz_json FROM contents WHERE session_id=? ORDER BY order_no', [s.id])
    }
    if (sessions.length) out.push({ ...m, sessions })
  }
  res.json(out)
}))

// ---- PPT → PDF (LibreOffice) so slides render reliably in the book viewer ----
app.get('/api/contents/:id/ppt-supported', (_req, res) => res.json({ supported: pptSupported() }))

app.get('/api/contents/:id/as-pdf', auth, wrap(async (req, res) => {
  const rows = await q(`SELECT c.storage_path, c.type, s.course_id FROM contents c JOIN sessions s ON s.id=c.session_id WHERE c.id=?`, [req.params.id])
  const row = rows[0]
  if (!row || !row.storage_path) return res.status(404).json({ error: 'No file' })
  if (!((await ownsCourse(req.user, row.course_id)) || (await isEnrolled(req.user, row.course_id))))
    return res.status(403).json({ error: 'Forbidden' })
  if (row.type !== 'ppt') return res.status(400).json({ error: 'Not a PPT' })
  if (!pptSupported()) return res.status(501).json({ error: 'PPT preview needs LibreOffice on the server' })

  // cache the converted PDF on local disk keyed by source path
  const cache = path.join(UPLOAD_DIR, '_pptcache', row.storage_path.replace(/[\/\\]/g, '_') + '.pdf')
  res.setHeader('Content-Type', 'application/pdf')
  if (fs.existsSync(cache)) return res.send(fs.readFileSync(cache))
  try {
    const src = await readStored(row.storage_path)
    const pdf = await pptxToPdf(src, path.basename(row.storage_path))
    fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, pdf)
    res.send(pdf)
  } catch (e) { res.status(500).json({ error: 'Conversion failed: ' + e.message }) }
}))

// ---- protected file streaming (admin/owner faculty OR enrolled student) ----
app.get('/api/contents/:id/file', auth, wrap(async (req, res) => {
  const rows = await q(`
    SELECT c.storage_path, s.course_id FROM contents c
    JOIN sessions s ON s.id = c.session_id WHERE c.id=?`, [req.params.id])
  const row = rows[0]
  if (!row || !row.storage_path) return res.status(404).json({ error: 'No file' })
  const allowed = (await ownsCourse(req.user, row.course_id)) || (await isEnrolled(req.user, row.course_id))
  if (!allowed) return res.status(403).json({ error: 'Forbidden' })
  const local = path.join(UPLOAD_DIR, row.storage_path)
  if (r2Enabled) {
    try {
      const { stream, contentType } = await getObjectStream(row.storage_path)
      if (contentType) res.setHeader('Content-Type', contentType)
      return stream.pipe(res)
    } catch (e) {
      // file uploaded before R2 was enabled → serve from local disk
      if (fs.existsSync(local)) return res.sendFile(local)
      return res.status(404).json({ error: 'File not found' })
    }
  }
  if (fs.existsSync(local)) return res.sendFile(local)
  res.status(404).json({ error: 'File not found' })
}))

// ===================================================================
// STUDENT MANAGEMENT — admin = full CRUD, faculty = view only
// ===================================================================
// list students (admin: all; faculty: students in their courses) with stats
app.get('/api/students', auth, requireRole('admin', 'faculty'), wrap(async (req, res) => {
  const stats = `
    (SELECT COUNT(*) FROM enrollments e WHERE LOWER(e.student_email)=LOWER(u.email)) AS courses,
    (SELECT COUNT(*) FROM quiz_attempts qa WHERE LOWER(qa.student_email)=LOWER(u.email)) AS attempts,
    (SELECT COALESCE(SUM(passed),0) FROM quiz_attempts qa WHERE LOWER(qa.student_email)=LOWER(u.email)) AS passed`
  if (req.user.role === 'admin') {
    res.json(await q(`SELECT u.id, u.name, u.reg_id, u.email, u.is_active, ${stats}
      FROM users u WHERE u.role='student' ORDER BY u.name`))
  } else {
    res.json(await q(`SELECT DISTINCT u.id, u.name, u.reg_id, u.email, u.is_active, ${stats}
      FROM users u
      JOIN enrollments e ON LOWER(e.student_email)=LOWER(u.email)
      JOIN faculty_course fc ON fc.course_id=e.course_id
      WHERE u.role='student' AND fc.faculty_id=? ORDER BY u.name`, [req.user.id]))
  }
}))

// create a student (admin only)
app.post('/api/students', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, email, reg_id, password } = req.body
  if (!name || !email) return res.status(400).json({ error: 'name and email required' })
  const hash = await bcrypt.hash(password || 'student123', 10)
  try {
    const r = await q('INSERT INTO users (name, email, reg_id, password_hash, role) VALUES (?,?,?,?,?)',
      [name, email.toLowerCase(), reg_id || null, hash, 'student'])
    res.json({ id: r.insertId, defaultPassword: password || 'student123' })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' })
    throw e
  }
}))

// update a student (admin only)
app.patch('/api/students/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, email, reg_id } = req.body
  try {
    await q('UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), reg_id=? WHERE id=? AND role=\'student\'',
      [name ?? null, email ? email.toLowerCase() : null, reg_id ?? null, req.params.id])
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already in use' })
    throw e
  }
  res.json({ ok: true })
}))

// delete a student (admin only)
app.delete('/api/students/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  await q('DELETE FROM users WHERE id=? AND role=\'student\'', [req.params.id])
  res.json({ ok: true })
}))

// parse a CSV of students -> [{name, reg_id, email}] (column order-independent)
function parseStudentsCsv(raw) {
  const line = (s) => { const o = []; let c = '', q = false; for (const ch of s) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = '' } else c += ch } o.push(c); return o.map((x) => x.trim()) }
  const rows = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (rows[0] && /name/i.test(rows[0]) && /email/i.test(rows[0])) rows.shift()
  return rows.map((l) => {
    const cells = line(l).filter(Boolean)
    const email = cells.find((x) => x.includes('@'))
    if (!email) return null
    const rest = cells.filter((x) => x !== email)
    const ri = rest.findIndex((r) => !r.includes(' ') && /\d/.test(r))
    const reg_id = ri >= 0 ? rest[ri] : ''
    const name = (ri >= 0 ? rest.filter((_, i) => i !== ri) : rest).join(' ')
    return { name: name || email.split('@')[0], reg_id, email: email.toLowerCase() }
  }).filter(Boolean)
}

// student CSV template
app.get('/api/student-template.csv', (_req, res) => {
  const csv = ['name,reg_id,email',
    'Rahul Kumar,2100031001,rahul@kl.edu',
    'Priya Sharma,2100031002,priya@kl.edu'].join('\n')
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="student-template.csv"')
  res.send(csv)
})

// admin: bulk-create student accounts from CSV (no course)
app.post('/api/students/csv', auth, requireRole('admin'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' })
  const list = parseStudentsCsv(req.file.buffer.toString('utf8'))
  await logImport('student', req.file, null, list.length, req.user)
  let created = 0
  for (const s of list) {
    const exists = await q('SELECT id FROM users WHERE email=? LIMIT 1', [s.email])
    if (exists.length === 0) {
      const hash = await bcrypt.hash('student123', 10)
      await q('INSERT INTO users (name, email, reg_id, password_hash, role) VALUES (?,?,?,?,?)',
        [s.name, s.email, s.reg_id || null, hash, 'student'])
      created++
    } else if (s.reg_id) await q('UPDATE users SET reg_id=COALESCE(reg_id,?) WHERE email=?', [s.reg_id, s.email])
  }
  res.json({ parsed: list.length, created, defaultPassword: 'student123' })
}))

// faculty/admin: bulk-enroll students into a course from CSV (creates accounts too)
app.post('/api/courses/:id/students/csv', auth, upload.single('file'), wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  if (!req.file) return res.status(400).json({ error: 'CSV file required' })
  const list = parseStudentsCsv(req.file.buffer.toString('utf8'))
  await logImport('student', req.file, req.params.id, list.length, req.user)
  let enrolled = 0, created = 0
  for (const s of list) {
    const exists = await q('SELECT id FROM users WHERE email=? LIMIT 1', [s.email])
    if (exists.length === 0) {
      const hash = await bcrypt.hash('student123', 10)
      await q('INSERT INTO users (name, email, reg_id, password_hash, role) VALUES (?,?,?,?,?)',
        [s.name, s.email, s.reg_id || null, hash, 'student'])
      created++
    } else if (s.reg_id) await q('UPDATE users SET reg_id=COALESCE(reg_id,?) WHERE email=?', [s.reg_id, s.email])
    const r = await q('INSERT IGNORE INTO enrollments (course_id, student_email) VALUES (?,?)', [req.params.id, s.email])
    if (r.affectedRows) enrolled++
  }
  res.json({ parsed: list.length, enrolled, accountsCreated: created, defaultPassword: 'student123' })
}))

// course-wise per-student progress report (admin or owning faculty)
app.get('/api/courses/:id/student-report', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const cid = req.params.id
  res.json(await q(`
    SELECT e.student_email, u.name, u.reg_id, u.is_active,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.course_id=? AND LOWER(qa.student_email)=LOWER(e.student_email)) AS attempts,
      (SELECT COALESCE(SUM(qa.passed),0) FROM quiz_attempts qa WHERE qa.course_id=? AND LOWER(qa.student_email)=LOWER(e.student_email)) AS passed,
      (SELECT MAX(qa.created_at) FROM quiz_attempts qa WHERE qa.course_id=? AND LOWER(qa.student_email)=LOWER(e.student_email)) AS last_active
    FROM enrollments e LEFT JOIN users u ON LOWER(u.email)=LOWER(e.student_email)
    WHERE e.course_id=? ORDER BY u.name`, [cid, cid, cid, cid]))
}))

// ===================================================================
// COURSE PROGRESS TRACKING (module/session completion + access)
// ===================================================================
// student marks a content opened/completed (called by the app when wired)
app.post('/api/progress', auth, wrap(async (req, res) => {
  const { content_id, completed } = req.body
  const rows = await q('SELECT s.course_id FROM contents c JOIN sessions s ON s.id=c.session_id WHERE c.id=?', [content_id])
  if (!rows[0]) return res.status(404).json({ error: 'content not found' })
  await q(`INSERT INTO progress (student_email, course_id, content_id, completed) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE completed=GREATEST(completed, VALUES(completed)), updated_at=CURRENT_TIMESTAMP`,
    [req.user.email, rows[0].course_id, content_id, completed ? 1 : 0])
  res.json({ ok: true })
}))

// compute per-student module/session/content completion + access for a course
async function computeCourseProgress(courseId) {
  const rows = await q(`SELECT s.id AS session_id, s.module_id, c.id AS content_id
    FROM sessions s LEFT JOIN contents c ON c.session_id=s.id WHERE s.course_id=?`, [courseId])
  const sessionContents = new Map(), moduleSessions = new Map(), allContents = new Set()
  for (const r of rows) {
    if (!sessionContents.has(r.session_id)) sessionContents.set(r.session_id, new Set())
    if (r.content_id) { sessionContents.get(r.session_id).add(r.content_id); allContents.add(r.content_id) }
    if (r.module_id != null) {
      if (!moduleSessions.has(r.module_id)) moduleSessions.set(r.module_id, new Set())
      moduleSessions.get(r.module_id).add(r.session_id)
    }
  }
  const totalContents = allContents.size

  const enrolled = await q(`SELECT e.student_email, u.name, u.reg_id FROM enrollments e
    LEFT JOIN users u ON LOWER(u.email)=LOWER(e.student_email) WHERE e.course_id=? ORDER BY u.name`, [courseId])
  const prog = await q('SELECT student_email, content_id, updated_at FROM progress WHERE course_id=? AND completed=1', [courseId])
  const att = await q('SELECT student_email, COUNT(*) AS attempts, COALESCE(SUM(passed),0) AS passed FROM quiz_attempts WHERE course_id=? GROUP BY student_email', [courseId])
  const lastAcc = await q('SELECT student_email, MAX(updated_at) AS last FROM progress WHERE course_id=? GROUP BY student_email', [courseId])

  const doneBy = new Map()
  for (const p of prog) {
    const k = p.student_email.toLowerCase()
    if (!doneBy.has(k)) doneBy.set(k, new Set())
    doneBy.get(k).add(p.content_id)
  }
  const attMap = new Map(att.map((a) => [a.student_email.toLowerCase(), a]))
  const lastMap = new Map(lastAcc.map((a) => [a.student_email.toLowerCase(), a.last]))

  const students = enrolled.map((s) => {
    const k = s.student_email.toLowerCase()
    const done = doneBy.get(k) || new Set()
    const contents_done = [...done].filter((id) => allContents.has(id)).length
    let sessions_done = 0
    for (const set of sessionContents.values())
      if (set.size > 0 && [...set].every((id) => done.has(id))) sessions_done++
    let modules_done = 0
    for (const sids of moduleSessions.values()) {
      const withContent = [...sids].filter((sid) => (sessionContents.get(sid)?.size || 0) > 0)
      if (withContent.length > 0 && withContent.every((sid) => [...sessionContents.get(sid)].every((id) => done.has(id)))) modules_done++
    }
    const a = attMap.get(k) || { attempts: 0, passed: 0 }
    return {
      name: s.name, reg_id: s.reg_id, email: s.student_email,
      modules_done, sessions_done, contents_done,
      progress_pct: totalContents ? Math.round((contents_done / totalContents) * 100) : 0,
      attempts: Number(a.attempts), passed: Number(a.passed),
      last_access: lastMap.get(k) || null,
      accessed: done.size > 0 || Number(a.attempts) > 0,
    }
  })
  return {
    totals: {
      modules: moduleSessions.size, sessions: sessionContents.size, contents: totalContents,
      students_enrolled: enrolled.length,
      students_accessed: students.filter((s) => s.accessed).length,
      avg_progress: students.length ? Math.round(students.reduce((x, s) => x + s.progress_pct, 0) / students.length) : 0,
    },
    students,
  }
}

app.get('/api/courses/:id/progress-report', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  res.json(await computeCourseProgress(req.params.id))
}))

// CSV download of the course progress report
app.get('/api/courses/:id/progress-report.csv', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const { totals, students } = await computeCourseProgress(req.params.id)
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const lines = [['Reg ID', 'Name', 'Email', 'Modules Completed', 'Sessions Completed', 'Contents Completed', 'Progress %', 'Quiz Attempts', 'Quiz Passed', 'Accessed', 'Last Access'].join(',')]
  for (const s of students) lines.push([
    s.reg_id, s.name, s.email,
    `${s.modules_done}/${totals.modules}`, `${s.sessions_done}/${totals.sessions}`, `${s.contents_done}/${totals.contents}`,
    s.progress_pct + '%', s.attempts, s.passed, s.accessed ? 'Yes' : 'No',
    s.last_access ? new Date(s.last_access).toISOString().slice(0, 10) : '',
  ].map(esc).join(','))
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="course-${req.params.id}-progress.csv"`)
  res.send(lines.join('\n'))
}))

// ===================================================================
// CONTENT UPLOAD STATUS (faculty authoring-readiness report)
// ===================================================================
const MANDATORY = ['youtube', 'pdf', 'ppt', 'infographic']

async function computeContentStatus(courseId) {
  const rows = await q(`
    SELECT s.id AS session_id, s.title AS session_title, s.order_no AS s_order,
           m.id AS module_id, m.title AS module_title, m.order_no AS m_order, c.type
    FROM sessions s
    LEFT JOIN modules m ON m.id = s.module_id
    LEFT JOIN contents c ON c.session_id = s.id
    WHERE s.course_id=? ORDER BY m.order_no, s.order_no, s.id`, [courseId])

  const map = new Map() // session_id -> {module, session, types:{}, items}
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, {
      module: r.module_title || 'Unassigned', session: r.session_title,
      types: {}, items: 0,
    })
    if (r.type) { const s = map.get(r.session_id); s.types[r.type] = (s.types[r.type] || 0) + 1; s.items++ }
  }

  const sessions = [...map.values()].map((s) => {
    const has = (t) => !!s.types[t]
    const missing = MANDATORY.filter((t) => !has(t))
    const status = s.items === 0 ? 'Empty' : missing.length === 0 ? 'Ready' : 'Partial'
    return {
      module: s.module, session: s.session, items: s.items, status,
      video: has('youtube'), report: has('pdf'), ppt: has('ppt'),
      infographic: has('infographic'), quiz: has('quiz'),
      missing: missing.map((t) => ({ youtube: 'Video', pdf: 'Report', ppt: 'PPT', infographic: 'Infographic' }[t])),
    }
  })

  const totals = {
    sessions: sessions.length,
    ready: sessions.filter((s) => s.status === 'Ready').length,
    partial: sessions.filter((s) => s.status === 'Partial').length,
    empty: sessions.filter((s) => s.status === 'Empty').length,
    videos: sessions.filter((s) => s.video).length,
    reports: sessions.filter((s) => s.report).length,
    ppts: sessions.filter((s) => s.ppt).length,
    infographics: sessions.filter((s) => s.infographic).length,
    quizzes: sessions.filter((s) => s.quiz).length,
  }
  totals.completion = totals.sessions ? Math.round((totals.ready / totals.sessions) * 100) : 0
  return { totals, sessions }
}

app.get('/api/courses/:id/content-report', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  res.json(await computeContentStatus(req.params.id))
}))

app.get('/api/courses/:id/content-report.csv', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const { sessions } = await computeContentStatus(req.params.id)
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const yn = (b) => (b ? 'Yes' : 'No')
  const lines = [['Module', 'Session', 'Video', 'Report', 'PPT', 'Infographic', 'Quiz', 'Items', 'Status', 'Missing'].join(',')]
  for (const s of sessions) lines.push([
    s.module, s.session, yn(s.video), yn(s.report), yn(s.ppt), yn(s.infographic), yn(s.quiz),
    s.items, s.status, s.missing.join(' / '),
  ].map(esc).join(','))
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="course-${req.params.id}-content-status.csv"`)
  res.send(lines.join('\n'))
}))

// ===================================================================
// QUIZ ATTEMPTS + REPORTS (progress for faculty & admin)
// ===================================================================
// student submits a quiz result (called by the app when wired)
app.post('/api/quiz-attempts', auth, wrap(async (req, res) => {
  const { content_id, score, total } = req.body
  const rows = await q(`SELECT s.course_id FROM contents c JOIN sessions s ON s.id=c.session_id WHERE c.id=?`, [content_id])
  const course_id = rows[0]?.course_id || null
  const passed = total > 0 && score / total >= 0.5 ? 1 : 0
  await q('INSERT INTO quiz_attempts (user_id, student_email, content_id, course_id, score, total, passed) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, req.user.email, content_id, course_id, score || 0, total || 0, passed])
  res.json({ ok: true, passed: !!passed })
}))

// per-course report (faculty)
app.get('/api/courses/:id/report', auth, wrap(async (req, res) => {
  if (!(await ownsCourse(req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden' })
  const cid = req.params.id
  const one = async (sql, p = [cid]) => (await q(sql, p))[0]
  const counts = await one(`
    SELECT
      (SELECT COUNT(*) FROM modules WHERE course_id=?) AS modules,
      (SELECT COUNT(*) FROM sessions WHERE course_id=?) AS sessions,
      (SELECT COUNT(*) FROM contents c JOIN sessions s ON s.id=c.session_id WHERE s.course_id=?) AS contents,
      (SELECT COUNT(*) FROM contents c JOIN sessions s ON s.id=c.session_id WHERE s.course_id=? AND c.type='quiz') AS quizzes,
      (SELECT COUNT(*) FROM enrollments WHERE course_id=?) AS students`,
    [cid, cid, cid, cid, cid])
  const att = await one(`SELECT COUNT(*) AS attempts, COALESCE(SUM(passed),0) AS passed,
      COUNT(DISTINCT student_email) AS active_students FROM quiz_attempts WHERE course_id=?`)
  const daily = await q(`SELECT DATE(created_at) AS day, COUNT(*) AS attempts, COALESCE(SUM(passed),0) AS passed
      FROM quiz_attempts WHERE course_id=? AND created_at >= (CURRENT_DATE - INTERVAL 6 DAY)
      GROUP BY DATE(created_at) ORDER BY day`, [cid])
  const passRate = att.attempts > 0 ? Math.round((att.passed / att.attempts) * 100) : 0
  res.json({ ...counts, ...att, passRate, daily })
}))

// system overview (admin)
app.get('/api/report/overview', auth, requireRole('admin'), wrap(async (_req, res) => {
  const one = async (sql) => (await q(sql))[0]
  const c = await one(`SELECT
    (SELECT COUNT(*) FROM courses) AS courses,
    (SELECT COUNT(*) FROM users WHERE role='faculty') AS faculty,
    (SELECT COUNT(*) FROM users WHERE role='student') AS students,
    (SELECT COUNT(*) FROM contents) AS contents,
    (SELECT COUNT(*) FROM contents WHERE type='quiz') AS quizzes`)
  const a = await one(`SELECT COUNT(*) AS attempts, COALESCE(SUM(passed),0) AS passed FROM quiz_attempts`)
  const daily = await q(`SELECT DATE(created_at) AS day, COUNT(*) AS attempts, COALESCE(SUM(passed),0) AS passed
    FROM quiz_attempts WHERE created_at >= (CURRENT_DATE - INTERVAL 6 DAY) GROUP BY DATE(created_at) ORDER BY day`)
  const perCourse = await q(`SELECT co.id, co.title,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=co.id) AS students,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.course_id=co.id) AS attempts,
      (SELECT COALESCE(SUM(passed),0) FROM quiz_attempts qa WHERE qa.course_id=co.id) AS passed
      FROM courses co ORDER BY co.title`)
  res.json({ ...c, ...a, passRate: a.attempts > 0 ? Math.round((a.passed / a.attempts) * 100) : 0, daily, perCourse })
}))

// ---------- start ----------
const PORT = process.env.PORT || 4000
// Listen FIRST so the service comes online immediately (Railway routes traffic
// only once the port is bound). Then run the idempotent migration in the
// background — if it fails, log it but keep serving (the schema/data already
// exist on a deployed DB, so the API still works).
app.listen(PORT, () => console.log(`TutorIQ API running on port ${PORT}`))
migrate()
  .then(() => console.log('✓ migration complete'))
  .catch((e) => console.error('Migration failed (server still running):', e))
