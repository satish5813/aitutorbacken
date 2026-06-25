// Creates (or resets) the super-admin account.
// Run: npm run seed
import bcrypt from 'bcryptjs'
import { pool, q } from './db.js'

const ADMIN = {
  name: 'Super Admin',
  email: 'admin@tutoriq.local',
  password: 'Admin@123',
}

const hash = await bcrypt.hash(ADMIN.password, 10)
await q(
  `INSERT INTO users (name, email, password_hash, role)
   VALUES (?,?,?,'admin')
   ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role='admin', name=VALUES(name)`,
  [ADMIN.name, ADMIN.email, hash]
)

console.log('✅ Super admin ready:')
console.log('   Email:    ' + ADMIN.email)
console.log('   Password: ' + ADMIN.password)
await pool.end()
