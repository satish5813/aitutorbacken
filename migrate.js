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

  // ensure the database exists, then run the schema (FK checks off so table
  // order doesn't matter), all on a one-off multi-statement connection.
  const conn = await mysql.createConnection({ ...dbConfig, database: undefined, multipleStatements: true })
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)
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
