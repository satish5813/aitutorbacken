// Auto-create the database schema + a default admin on startup.
// Idempotent (CREATE TABLE IF NOT EXISTS) so it's safe on every deploy.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'
import { dbConfig, q } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

  // Connect with a few retries — on a fresh deploy the database can take a
  // moment to accept connections (avoids a crash-on-cold-start race).
  let conn
  for (let attempt = 1; ; attempt++) {
    try {
      conn = await mysql.createConnection({ ...dbConfig, database: undefined, multipleStatements: true })
      break
    } catch (e) {
      if (attempt >= 8) throw e
      console.log(`DB not ready (attempt ${attempt}/8: ${e.code || e.message}) — retrying in 3s…`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  // Managed hosts (Railway) pre-create the database and the user often can't run
  // CREATE DATABASE — treat that as non-fatal and just use the existing one.
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)
  } catch (e) {
    console.warn(`CREATE DATABASE skipped (${e.code || e.message}) — using existing database`)
  }
  await conn.query(`USE \`${dbConfig.database}\`;`)
  await conn.query('SET FOREIGN_KEY_CHECKS=0;\n' + schema + '\nSET FOREIGN_KEY_CHECKS=1;')
  await conn.end()
  console.log('✓ schema ready (' + (schema.match(/CREATE TABLE/g) || []).length + ' tables)')

  // seed a default super admin if none exists
  const admins = await q("SELECT id FROM users WHERE role='admin' LIMIT 1")
  if (admins.length === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@tutoriq.local').toLowerCase()
    const pw = process.env.ADMIN_PASSWORD || 'Admin@123'
    const hash = await bcrypt.hash(pw, 10)
    await q("INSERT INTO users (name, email, password_hash, role) VALUES ('Super Admin', ?, ?, 'admin')", [email, hash])
    console.log(`✓ default admin created: ${email} / ${pw}`)
  }
}
