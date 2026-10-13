# Deployment, backups and adapter migration

## 1. Production on a small Linux VPS (1–2 vCPU, 2 GB RAM is enough for ~500 students)

1. Install Docker Engine + the compose plugin, and point a domain at the VPS.
2. Clone the repo, create `server/.env` from `server/.env.example`:
   - `NODE_ENV=production`, a fresh random `SESSION_SECRET` (32+ chars), `APP_ORIGIN=https://your-domain`
   - `DATABASE_URL` / `DIRECT_URL` (hosted Postgres, `sslmode=require`)
   - `AI_PROVIDER=groq`, `GROQ_API_KEY`
   - `ENABLE_DEV_ROUTES=false` (the server refuses to start otherwise)
3. `docker compose up -d --build` — the container runs `prisma migrate deploy` and starts the API, worker and
   the built dashboard on `127.0.0.1:3000`.
4. Put a TLS reverse proxy in front, e.g. Caddy:
   ```
   your-domain {
     reverse_proxy 127.0.0.1:3000
   }
   ```
   HTTPS is required: session cookies are `Secure` in production.
5. Create the first admin once, then remove the password from `.env`:
   ```bash
   docker compose run --rm -e INITIAL_ADMIN_EMAIL=you@x.com -e INITIAL_ADMIN_PASSWORD='Temp-Pass-123456' app node dist/cli/createAdmin.js
   ```
   Sign in; a password change is forced at first login. Enable TOTP under your account.

Break-glass reset: `docker compose run --rm app node dist/cli/resetPassword.js you@x.com` prints a one-time
token; use it at `/reset-password`.

## 1b. Supabase setup (database, private file storage, pgvector)

1. **Database**: Supabase → Project Settings → Database → connection strings.
   - `DATABASE_URL` = the pooled (port 6543) URI with `?pgbouncer=true&sslmode=require`
   - `DIRECT_URL` = the direct/session (port 5432) URI with `?sslmode=require` (used by migrations)
   - `TEST_DATABASE_URL` = the direct URI with `?schema=tutor_test` (the test suite wipes this schema only)
2. **pgvector**: nothing to do. The `knowledge_base` migration enables the `vector` extension (in the
   `extensions` schema) and creates a pgvector embedding column. On databases without pgvector it falls back
   to a `real[]` column automatically. The Knowledge Base page header shows which backend is active.
3. **Storage**: set `STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (Project Settings → API). On startup the server creates the `transcripts` bucket as **private**, and refuses
   to start if an existing bucket with that name is public. Files are only read through the authenticated
   `/api/transcripts/:id/original` endpoint (reviewers and super admins).
4. **Row Level Security**: the migration enables RLS on every application table with no policies, so
   Supabase's public `anon`/`authenticated` API keys cannot read anything. The server connects as the table
   owner and is unaffected. Never put the service-role key in the frontend or in `VITE_*` variables.
5. **Embeddings** (semantic search): set `EMBEDDING_PROVIDER=openai_compatible`, `EMBEDDING_API_KEY`, and
   optionally `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` (default OpenAI `text-embedding-3-small`; any
   OpenAI-style `/embeddings` endpoint works). Groq is not used for embeddings. If you change the model later,
   click **Re-embed all** in the Knowledge Base. Without a provider, retrieval uses full-text search only.
6. Run `npm run db:migrate` (or let the Docker container do it), then add transcripts from **Knowledge Base**.
   Uploads and pasted text are processed in the background; no code change or redeploy is needed per class.

## 2. Backups and restore testing

The database is the only stateful component besides uploaded transcript files (`uploads` volume).

Nightly backup (cron on the VPS):
```bash
pg_dump --format=custom --no-owner "$DIRECT_URL_WITHOUT_SCHEMA_PARAM" > /backups/tutor-$(date +%F).dump
tar czf /backups/uploads-$(date +%F).tgz -C /var/lib/docker/volumes/<project>_uploads/_data .
find /backups -mtime +14 -delete
```
Hosted providers (Neon, Supabase) also offer point-in-time restore — enable it.
Set `LAST_BACKUP_AT` (ISO timestamp) from your backup script if you want it shown on the Administration page.

Restore test (do this monthly into a scratch database):
```bash
createdb tutor_restore_test
pg_restore --no-owner -d tutor_restore_test /backups/tutor-YYYY-MM-DD.dump
psql tutor_restore_test -c "select count(*) from approved_answer_examples; select count(*) from transcript_chunks;"
```

## 3. Data retention and privacy

- Raw message content is purged after `message_retention_days` (default 30) by a daily job; rows older than twice
  that are deleted. Approved Answer Memory, transcripts and audit logs are kept separately.
- **Students & Groups → Delete data** removes a student's messages, responses and private examples, and strips
  original wording from reusable examples.
- Publish a privacy notice to students explaining that questions are processed by an AI provider, may be reviewed
  by staff, and are deleted after the retention period. The website chat shows a short notice at sign-in.

## 4. Switching messaging adapters (Stage 1 → Stage 2)

Adapters hold only a live connection; transcripts, Approved Answer Memory, settings, admins, students and history
are in Postgres and survive a switch (covered by an automated test).

1. Review the current WhatsApp Business Platform policies for your country, account and use case, including the
   rules on AI services and use of message data. Confirm group support for your use case — this build assumes
   **no** group messaging and **no** native group mentions on the official API.
2. Implement `WhatsAppCloudApiAdapter` (Milestone 10) against `server/src/messaging/types.ts`.
3. In **Messaging**, tick the policy checklist, then select the official adapter. The capability panel shows what is
   unavailable; students in groups should be pointed to the website chat (`/chat`).
4. Platform user IDs differ between adapters. Re-import enrollment records for the new channel via
   **Students & Groups → Import** (CSV `channel,platform_user_id,phone,display_name,enrollment_status`).

## 5. Operations checklist

- Dashboard: pending approvals, failed responses, failed queue jobs, AI spend vs daily budget.
- Emergency controls (Dashboard/Messaging/Administration) act immediately on the backend; reviewers can stop,
  only super admins can resume.
- Logs are structured JSON on stdout (`docker compose logs -f app`); secrets and cookies are redacted.
