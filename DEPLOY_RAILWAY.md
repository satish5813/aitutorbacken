# Deploy the backend to Railway

The backend **auto-creates all tables and a default admin on first boot** — you do NOT
need to create the database tables manually. Just provide the DB + R2 env vars.

## Steps

### 1. Push this `backend-mysql` folder to GitHub
(Make sure `.env` is NOT committed — it's already in `.gitignore`.)

### 2. Create the project on Railway
- railway.app → **New Project** → **Deploy from GitHub repo** → pick your repo
- If the backend is in a sub-folder, set **Root Directory** = `backend-mysql`

### 3. Add a MySQL database
- In the project → **New** → **Database** → **MySQL**
- Railway auto-creates `MYSQL*` env vars. The app reads them automatically
  (it understands `MYSQL_URL` / `DATABASE_URL` or the individual `MYSQLHOST` etc.).

### 4. Set the remaining environment variables (Service → Variables)
```
JWT_SECRET=<a long random string>
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your key>
R2_SECRET_ACCESS_KEY=<your secret>
R2_BUCKET=toutorai
# optional — override the default admin:
ADMIN_EMAIL=admin@tutoriq.local
ADMIN_PASSWORD=Admin@123
```
(Do NOT set DB_HOST/DB_NAME etc. — Railway's MySQL plugin provides them.)

### 5. Deploy
Railway runs `npm install` then `npm start`. On boot you'll see in the logs:
```
✓ schema ready (9 tables)
✓ default admin created: admin@tutoriq.local / Admin@123
TutorIQ API running on port ...
```
Your API is live at the Railway-provided URL (e.g. `https://xxx.up.railway.app`).

### 6. Point the web portal & app at it
- Web portal: set `VITE_API_URL=https://<railway-url>/api`
- Flutter student app: set the API base URL to the same.

## Notes
- **Files** (PDF/PPT/images) → stored in **Cloudflare R2** (already wired), so they
  survive every redeploy. No Railway volume needed.
- **Re-deploys are safe** — schema creation is idempotent (`CREATE TABLE IF NOT EXISTS`)
  and the admin is only created if none exists.
- To reset the schema file after local DB changes, re-dump it:
  `mysqldump -u root -p --no-data --skip-add-drop-table --compact tutoriq > schema.sql`
  (then prefix each `CREATE TABLE` with `IF NOT EXISTS`).
