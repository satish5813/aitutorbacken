# Deploy TutorIQ Backend + MySQL on a Hostinger VPS

Self-host the API and database on your own Ubuntu VPS, behind nginx with free HTTPS.
You run these over SSH. Replace every **`<PLACEHOLDER>`** with your real value.

| Placeholder | Meaning | Example |
|---|---|---|
| `<VPS_IP>` | Your VPS public IP | `145.79.12.34` |
| `<API_DOMAIN>` | Domain/subdomain for the API | `api.tutoriq.in` |
| `<DB_PASSWORD>` | A new password you choose for the DB user | `Str0ng#Db#Pass` |
| `<JWT_SECRET>` | Long random string for auth tokens | (generate, see step 6) |

---

## 0. Point your domain at the VPS (do this first — DNS takes time to propagate)
In your domain's DNS settings (Hostinger → Domains → DNS), add an **A record**:

```
Type: A    Name: api    Value: <VPS_IP>    TTL: 3600
```

That makes `api.<yourdomain>` → your VPS. (If you use a bare domain instead, use `Name: @`.)

---

## 1. Connect to the VPS
```bash
ssh root@<VPS_IP>
```

## 2. Install Node.js 20, MySQL, nginx, git, PM2
```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs mysql-server nginx git
npm install -g pm2
node -v   # should print v20.x
```

## 3. Create the database + a dedicated user
```bash
mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS tutoriq CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'tutoriq'@'localhost' IDENTIFIED BY '<DB_PASSWORD>';
GRANT ALL PRIVILEGES ON tutoriq.* TO 'tutoriq'@'localhost';
FLUSH PRIVILEGES;
SQL
```
> Edit `<DB_PASSWORD>` in the block above before running it.

## 4. Upload + import the data dump
From **your PC** (new terminal, not SSH), upload the dump file:
```bash
scp "D:\AITUTOR\tutoriq_dump.sql" root@<VPS_IP>:/root/tutoriq_dump.sql
```
Back on the **VPS**, import it:
```bash
mysql -u tutoriq -p tutoriq < /root/tutoriq_dump.sql
# enter <DB_PASSWORD> when asked
mysql -u tutoriq -p tutoriq -e "SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS courses FROM courses;"
# expect users=15, courses=9
```

## 5. Get the backend code
```bash
mkdir -p /var/www && cd /var/www
git clone https://github.com/satish5813/aitutorbacken.git tutoriq-api
cd tutoriq-api
npm install --omit=dev
```

## 6. Create the `.env` file
Generate a JWT secret first:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Then create the file:
```bash
nano /var/www/tutoriq-api/.env
```
Paste this (fill in the 3 secret values):
```ini
PORT=4000
DATABASE_URL=mysql://tutoriq:<DB_PASSWORD>@localhost:3306/tutoriq
JWT_SECRET=<JWT_SECRET>

# Cloudflare R2 (copy these from your local backend-mysql/.env)
R2_ENDPOINT=https://836c046dcf5fea0582c3a235ed1ed1e3.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your R2 access key id>
R2_SECRET_ACCESS_KEY=<your R2 secret access key>
R2_BUCKET=toutorai
```
Save: `Ctrl+O`, `Enter`, `Ctrl+X`.

## 7. Start the API with PM2 (auto-restart + boot on reboot)
```bash
cd /var/www/tutoriq-api
pm2 start server.js --name tutoriq-api
pm2 logs tutoriq-api --lines 20     # should show: TutorIQ API running on port 4000
pm2 save
pm2 startup systemd -u root --hp /root   # run the command it prints back
```
Quick local test:
```bash
curl -s http://localhost:4000/api/languages | head -c 100   # JSON = working
```

## 8. nginx reverse proxy (domain → the API)
```bash
nano /etc/nginx/sites-available/tutoriq
```
Paste (replace `<API_DOMAIN>`):
```nginx
server {
    listen 80;
    server_name <API_DOMAIN>;

    client_max_body_size 200M;   # allow large PDF/PPT uploads

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```
Enable it:
```bash
ln -s /etc/nginx/sites-available/tutoriq /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 9. Open the firewall (if ufw is active)
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 10. Free HTTPS with Let's Encrypt
> DNS from step 0 must be pointing at the VPS first (check: `ping <API_DOMAIN>`).
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d <API_DOMAIN> --redirect -m you@email.com --agree-tos --no-eff-email
```
Now test from anywhere:
```
https://<API_DOMAIN>/api/languages
```

## 11. Point the frontends at the new backend
- **Admin portal** (`web/.env`): `VITE_API_URL=https://<API_DOMAIN>/api` → rebuild (`npm run build`)
- **Student portal** (`student-app/index.html`) and **mobile asset** (`kl_student/assets/www/index.html`):
  `const DEFAULT_SERVER = 'https://<API_DOMAIN>';`
- CORS is already open in the backend, so no backend change needed.

---

## Updating later (after you push new code)
```bash
cd /var/www/tutoriq-api
git pull
npm install --omit=dev
pm2 restart tutoriq-api
```

## Handy PM2 / log commands
```bash
pm2 status               # is it running?
pm2 logs tutoriq-api     # live logs
pm2 restart tutoriq-api  # restart after .env change
systemctl status mysql   # database health
```

## Notes
- The API listens only on `127.0.0.1:4000`; the public entry is nginx (80/443). Port 4000 is never exposed.
- MySQL listens on localhost only — not reachable from the internet (good).
- Uploaded files still go to Cloudflare R2 (same as before), so they survive restarts/redeploys.
- Default logins after import: admin `admin@tutoriq.local / Admin@123`, students `…@kl.edu / Student@123`, faculty `…/Faculty@123`. Change them in the app.
