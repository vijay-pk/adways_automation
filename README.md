# Course Tutor — WhatsApp Performance-Marketing AI Tutor

AI tutor that answers students from your class transcripts (RAG), understands questions spread over several
messages, and learns from administrator-approved answers through retrieval (no model fine-tuning).
Messaging goes through replaceable adapters; all state lives in PostgreSQL.

## What this build includes (Milestones 1–7)

| Area | Status |
|---|---|
| Admin auth: Argon2id, sessions (HttpOnly cookie), CSRF, lockout, rate limit, forced first-login password change, reset tokens, optional TOTP, roles (Super Admin / Reviewer / Viewer), audit log | Done |
| Knowledge Base: upload (TXT, PDF, DOCX, SRT, VTT, Markdown) or paste transcripts; title/module/topic/description; private original storage (local or Supabase bucket); background processing with retries; ~800-token overlapping chunks; embeddings (configurable provider, pgvector on Supabase); hybrid full-text + semantic search; search/filter/sort, preview, edit, replace, reprocess, delete | Done |
| AI: Groq (OpenAI-compatible) + deterministic mock; grounded prompt; JSON output; citation validation against DB records; evidence fallback; usage and cost tracking; daily budget | Done |
| Routing: groups only on a genuine native mention (or opt-in text command / quoted reply to the tutor), allowlisted groups, enrollment checks, rate limits, dedup, no self-replies; private messages always eligible | Done |
| Context engine: same sender + same chat + time window, debounced bursts, LLM correlation into one question, follow-up detection, consumed-message tracking | Done |
| AI Reply Mode (automatic / approval), approval state machine, idempotent approve, edit/reject/regenerate/request evidence/mark reviewed, safe delivery retry, emergency stops | Done |
| Approved Answer Memory: draft vs final, reusable/private, tags, enable/disable/delete, newest-correction-wins retrieval, influence tracking, correction patterns | Done |
| Mock adapter, website chat fallback, student CSV import/export, data deletion, retention job, Docker | Done |
| WhatsApp Web adapter (experimental, QR login, groups + mentions) and official Cloud API adapter (signed webhook, delivery receipts) — see [docs/WHATSAPP.md](docs/WHATSAPP.md) | Done |
| Production hardening + backup automation (M9) | **Not built** |

## Quick start (local development)

Requirements: Node 22+ (tested on Node 24), npm 10+.

```bash
npm install
cp server/.env.example server/.env      # then edit it
```

Database — either:
- **Hosted Postgres**: put your Neon/Supabase URL in `DATABASE_URL` / `DIRECT_URL`, and a different schema in `TEST_DATABASE_URL` (e.g. `?schema=tutor_test`).
- **Local, no install**: `npm run db:local --workspace server` (embedded PostgreSQL on port 5433, data in `server/.localdb`), then use
  `postgresql://tutor:tutor_local@localhost:5433/tutor?schema=public`.

```bash
npm run db:migrate                      # apply migrations
npm run admin:create                    # first super admin from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD
npm run dev:server                      # API + worker on :3000
npm run dev:web                         # dashboard on http://localhost:5173 (proxies /api)
npm test                                # 96 automated tests (mock AI + mock messaging only)
```

Set `ENABLE_DEV_ROUTES=true` to get the **Mock adapter simulator** on the Messaging page, which lets you send
group/private messages (with or without a native mention) and watch the whole pipeline.

Student website chat: `http://localhost:5173/chat`. Issue a code on **Students & Groups → Web chat code**.

## Important notes

- `AI_PROVIDER=mock` answers deterministically from the top transcript passage — use it for development/testing.
  Set `AI_PROVIDER=groq` and `GROQ_API_KEY` for real answers.
- Do not run `prisma migrate dev` against an existing database without care: Prisma cannot model the generated
  `tsvector` columns, so it proposes dropping them. Add new migrations by hand or review the generated SQL.
- Approved Answer Memory is retrieval only. Nothing is ever sent to a provider for training; the
  `platform_data_ai_training_allowed` setting is locked to `false`.
- Unofficial WhatsApp Web automation can break WhatsApp's Terms of Service and get the number banned.
  The adapter only activates after a super admin acknowledges that risk; use a separate test number.

## Production

Production runs on its own VPS at https://automation.adwaysacademy.com (WordPress stays untouched), with
Supabase for the database and transcript files and Groq for answers.

- Database: paste [`supabase/install.sql`](supabase/install.sql) into the Supabase SQL Editor once.
- Environment: [`server/.env.production.example`](server/.env.production.example).
- Server, DNS, HTTPS, deploy/rollback, backups: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [`deploy/`](deploy/).

After changing migrations, regenerate the install script with `npm run supabase:sql --workspace server`
(a test fails if it is out of date).

## Layout

```
server/  Express + Prisma API, job worker, adapters, AI, tests (Vitest)
web/     React + Vite + Tailwind admin dashboard and student chat
docs/    deployment & migration guide
```
