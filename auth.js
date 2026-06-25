import jwt from 'jsonwebtoken'
import { q } from './db.js'
import 'dotenv/config'

const SECRET = process.env.JWT_SECRET

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    SECRET,
    { expiresIn: '30d' }
  )
}

// Verify JWT, attach req.user
export function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  try {
    req.user = jwt.verify(token, SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' })
  }
}

// Restrict to one or more roles
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Forbidden' })
    next()
  }
}

// Does the current faculty own this course? (admin always passes)
export async function ownsCourse(user, courseId) {
  if (user.role === 'admin') return true
  const rows = await q(
    'SELECT 1 FROM faculty_course WHERE faculty_id=? AND course_id=? LIMIT 1',
    [user.id, courseId]
  )
  return rows.length > 0
}

// Does the current faculty own the course this module belongs to?
export async function ownsModule(user, moduleId) {
  if (user.role === 'admin') return true
  const rows = await q(
    `SELECT 1 FROM modules m JOIN faculty_course fc ON fc.course_id = m.course_id
     WHERE m.id=? AND fc.faculty_id=? LIMIT 1`, [moduleId, user.id])
  return rows.length > 0
}

// Is this student enrolled in the course? (by email)
export async function isEnrolled(user, courseId) {
  const rows = await q(
    'SELECT 1 FROM enrollments WHERE course_id=? AND LOWER(student_email)=LOWER(?) LIMIT 1',
    [courseId, user.email]
  )
  return rows.length > 0
}
