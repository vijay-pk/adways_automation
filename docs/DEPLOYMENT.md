# Production deployment — https://automation.adwaysacademy.com

The tutor runs on its **own VPS**, separate from WordPress. Its database and transcript files live in
**Supabase**; answers come from **Groq**. Nothing on the WordPress site changes except, optionally,
one menu link.

```
students / admins ──HTTPS──> automation.adwaysacademy.com (VPS: Caddy → app container)
                                   │                     │
                                   ▼                     ▼
                       Supabase (Postgres "tutor"     Groq API, embedding API
                       schema + private Storage)
adwaysacademy.com ──> existing Hostinger WordPress (46.28.44.220) — untouched
```

## 0. What exists today (checked 2026-10-13, read-only)

| Item | Value |
|---|---|
| Main site | `adwaysacademy.com` → A `46.28.44.220`, LiteSpeed, WordPress, title "Adways Academy" |
| `www` | CNAME → `adwaysacademy.com` |
| DNS provider | Hostinger (nameservers `apollo.dns-parking.com`, `athena.dns-parking.com`) |
| MX / email records | none found on the apex |
| `automation.adwaysacademy.com` | does not exist yet (safe to add) |

## 1. VPS requirements

| | Minimum | Recommended (~500 students, 50 transcripts) |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 2 GB (+2 GB swap, added by setup script) | 4 GB |
| Disk | 25 GB SSD | 40 GB SSD (Docker images, logs, local backups) |
| OS | Ubuntu 22.04 / 24.04 LTS, 64-bit | same |
| Network | public IPv4, ports 22/80/443 open | same |

Typical cost: USD 5–12/month (e.g. Hostinger KVM 1/KVM 2, Hetzner CX22, DigitalOcean 2–4 GB).
The app uses ~150–250 MB RAM at runtime; building the image needs ~1.5 GB, which is why swap is added.
Supabase free tier covers the database (≈ a few hundred MB) and transcript files (≪ 1 GB) for this scale.

## 2. DNS record to add (Hostinger hPanel → Domains → adwaysacademy.com → DNS / Nameservers)

Add **only** this record after the VPS exists and you know its IPv4 address:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `automation` | `<VPS public IPv4>` | 300 (or 3600) |

Optional, only if the VPS also has IPv6 **and** port 80/443 are open on it: `AAAA automation <VPS IPv6>`.
Do not edit or delete the existing `@`, `www`, or any other records.
Check propagation: `nslookup automation.adwaysacademy.com` must return the VPS IP before deploying
(Caddy needs it to obtain the HTTPS certificate).

## 3. Supabase setup

1. **Create the schema** — Supabase → SQL Editor → New query → paste the entire
   [`supabase/install.sql`](../supabase/install.sql) → **Run**. It:
   - creates everything in a separate schema `tutor` (no clash with anything in `public`, and not exposed via
     Supabase's REST API);
   - enables `pgvector` (in `extensions`) for transcript embeddings;
   - enables Row Level Security on every table and revokes access from the `anon`/`authenticated` API roles;
   - records the migrations so future upgrades run automatically on deploy;
   - creates no users or passwords. Re-running it stops with "already installed".
   The last two result panes list 3 migrations and `extensions.vector`.
2. **Connection strings** — Project Settings → Database → **Connect**:
   - `DATABASE_URL` = *Transaction pooler* (port 6543) + `?schema=tutor&pgbouncer=true&sslmode=require&connection_limit=5`
   - `DIRECT_URL` = *Session pooler* (port 5432) + `?schema=tutor&sslmode=require` (IPv4-compatible; the direct
     `db.<ref>.supabase.co` host is IPv6-only on many plans)
   - `BACKUP_DATABASE_URL` = *Session pooler* + `?sslmode=require`
3. **Storage** — Project Settings → API: copy the project URL and the `service_role` key into
   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. The server creates the private bucket `transcripts` on first
   start and refuses to run if a bucket with that name is public. The key never reaches the browser.

## 4. First deployment

```bash
# On the new VPS, as root:
curl -fsSL https://raw.githubusercontent.com/vijay-pk/adways_automation/main/deploy/setup-vps.sh -o setup-vps.sh
less setup-vps.sh            # review it
bash setup-vps.sh            # Docker, firewall (22/80/443), auto security updates, swap, clones to /opt/course-tutor

cd /opt/course-tutor
cp server/.env.production.example server/.env.production
chmod 600 server/.env.production
nano server/.env.production  # Supabase, Groq, embeddings, SESSION_SECRET (openssl rand -base64 36), first-admin email/password

# After the DNS A record resolves to this server:
./deploy/deploy.sh           # backup → build → migrate → start → health check → verify

# Create the first super admin (one time), then delete INITIAL_ADMIN_PASSWORD from .env.production:
docker compose exec app node dist/cli/createAdmin.js
docker compose up -d app     # reload env without the bootstrap password
```

Sign in at https://automation.adwaysacademy.com — a password change is forced at first login. Enable
two-factor under your account, then add reviewers in **Administration**.

## 5. Verification (run after every deploy)

`./deploy/verify.sh` checks: valid HTTPS certificate, HTTP→HTTPS redirect, `/api/health` (app + database),
dashboard and deep links, student chat route, admin API requires login, no public registration, HSTS — and that
`https://adwaysacademy.com` still returns 200, is still WordPress and still has the title "Adways Academy".

Then manually: sign in, open **Administration → Integration health** (all six checks should be green: database,
Groq, embeddings, transcript storage, messaging, background jobs), upload one transcript in **Knowledge Base** and
watch it reach *Completed*, and use **Test retrieval**.

## 6. Updates and rollback

```bash
cd /opt/course-tutor
./deploy/deploy.sh                 # deploy latest main (or: ./deploy/deploy.sh v1.2.0 / <commit>)
./deploy/rollback.sh               # list releases and images
./deploy/rollback.sh <short-sha>   # switch back to a previous image
```

Each deploy takes a database backup labelled `pre-deploy-<sha>` before migrating. If the new version fails its
health check, the script switches back to the previous image automatically. Migrations are forward-only and
additive; if a release ever needs its schema undone, restore its pre-deploy backup (section 7).
WordPress updates and this application are completely independent.

## 7. Backups and restore

Nightly cron on the VPS (`crontab -e`):
```
30 2 * * * cd /opt/course-tutor && ./deploy/backup.sh nightly >> backups/backup.log 2>&1
```
Each backup is `backups/<timestamp>.tar.gz` containing `database.dump` (schema `tutor`, pg_dump custom format) and
`transcripts/` (original files + `manifest.json`). 14 days are kept on the server; copy them off-site
(e.g. `rclone` to Google Drive/S3) — a server-only backup does not survive losing the server.
Supabase's own daily backups / point-in-time recovery are an additional layer.

Restore test (monthly) into a scratch Supabase project or any Postgres:
```bash
tar -xzf backups/<stamp>.tar.gz -C /tmp
# The scratch database needs pgvector first (Supabase: create extension if not exists vector with schema extensions;)
docker run --rm -v /tmp/<stamp>:/in postgres:17 pg_restore --no-owner -d "<scratch-db-url>" /in/database.dump
docker run --rm postgres:17 psql "<scratch-db-url>" -c "select count(*) from tutor.transcripts; select count(*) from tutor.approved_answer_examples;"
```
Full production restore (after an incident):
```bash
docker compose stop app
docker run --rm -v /tmp/<stamp>:/in postgres:17 pg_restore --clean --if-exists --no-owner -d "$BACKUP_DATABASE_URL" /in/database.dump
docker compose start app
docker compose cp /tmp/<stamp>/transcripts app:/tmp/restore && docker compose exec app node dist/cli/restoreTranscripts.js /tmp/restore
```

## 8. Logs, health and monitoring

- `docker compose ps` — container status and health; `docker compose logs -f app` — structured JSON logs
  (cookies, CSRF tokens and API keys are redacted; message bodies are not logged).
- Logs rotate automatically (10 MB × 5 files per container).
- Point an uptime monitor (UptimeRobot, Better Stack — free tiers) at `https://automation.adwaysacademy.com/api/health`.
- Containers restart automatically (`restart: unless-stopped`) and after a reboot (Docker is enabled at boot).

## 9. Security notes

- Secrets exist only in `server/.env.production` on the VPS (mode 600). Development uses `server/.env`; the two
  never share credentials.
- Firewall allows only SSH, HTTP and HTTPS. Use SSH keys and disable password SSH login
  (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- The database role used by the app owns the `tutor` schema; Supabase API roles have no access to it.
- No WordPress credentials or database access are shared with the tutor.

## 10. Linking from WordPress (optional)

Add a normal link only — WordPress admin → Appearance → Menus (or the page editor) → Custom Link:
URL `https://automation.adwaysacademy.com/chat`, label e.g. "AI Tutor". No plugin, theme or routing change.
Single sign-on with WordPress, if wanted later, should be a separate reviewed integration.

## 11. Data retention and privacy

- Raw message content is purged after `message_retention_days` (default 30) by a daily job; rows older than twice
  that are deleted. Approved Answer Memory, transcripts and audit logs are kept separately.
- **Students & Groups → Delete data** removes a student's messages, responses and private examples, and strips
  original wording from reusable examples.
- Publish a privacy notice to students explaining that questions are processed by an AI provider, may be reviewed
  by staff, and are deleted after the retention period. The website chat shows a short notice at sign-in.

## 12. Switching messaging adapters

Adapters hold only a live connection; transcripts, Approved Answer Memory, settings, admins, students and history
are in Postgres and survive a switch (covered by an automated test).

1. Review the current WhatsApp Business Platform policies for your country, account and use case, including the
   rules on AI services and use of message data. This build assumes **no** group messaging and **no** native group
   mentions on the official API.
2. Implement `WhatsAppCloudApiAdapter` against `server/src/messaging/types.ts`.
3. In **Messaging**, tick the policy checklist, then select the adapter. The capability panel shows what is
   unavailable; students in groups should be pointed to the website chat (`/chat`).
4. Platform user IDs differ between adapters; re-import enrollment records via **Students & Groups → Import**.
