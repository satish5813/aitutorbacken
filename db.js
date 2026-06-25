import mysql from 'mysql2/promise'
import 'dotenv/config'

// Build a connection config from either a URL (Railway: MYSQL_URL / DATABASE_URL)
// or individual env vars (local DB_*, or Railway MYSQL*).
function fromUrl(u) {
  const x = new URL(u)
  return {
    host: x.hostname,
    port: Number(x.port) || 3306,
    user: decodeURIComponent(x.username),
    password: decodeURIComponent(x.password),
    database: x.pathname.replace(/^\//, ''),
  }
}

const url = process.env.DATABASE_URL || process.env.MYSQL_URL
export const dbConfig = url ? fromUrl(url) : {
  host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'tutoriq',
}

export const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
})

export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params)
  return rows
}
