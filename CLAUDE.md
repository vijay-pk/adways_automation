# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Course Tutor: a WhatsApp AI tutor that answers students from class transcripts (RAG) and learns from
admin-approved answers through retrieval only (no fine-tuning). npm workspaces: `server/` (Express 5 + Prisma 6 +
Postgres, job worker, Vitest) and `web/` (React + Vite + Tailwind admin dashboard and student chat at `/chat`).

## Commands

Run from the repo root unless noted.

```bash
npm run dev:server                       # API + in-process worker on :3000 (tsx watch)
npm run dev:web                          # dashboard on :5173, proxies /api to :3000
npm run build                            # server tsc + web build
npm run typecheck                        # both workspaces
npm test                                 # server Vitest suite
npm run db:migrate                       # prisma migrate deploy
npm run admin:create                     # first super admin from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (only if none exist)
npm run db:local --workspace server      # embedded Postgres on :5433, data in server/.localdb
npm run supabase:sql --workspace server  # regenerate supabase/install.sql after any migration change
npm run admin:reset-password --workspace server
```

Single test (from `server/`): `npx vitest run tests/auth.test.ts` or `npx vitest run -t "test name"`.

Tests:
- They need `TEST_DATABASE_URL` in `server/.env`, and it must differ from `DATABASE_URL` (`vitest.config.ts` enforces this). Usually it is the local embedded DB (`localhost:5433`, `?schema=tutor_test`), so start `db:local` first.
- `tests/globalSetup.ts` runs `prisma migrate deploy` on that schema. `resetDb()` in `tests/helpers.ts` TRUNCATEs every table, so never point `TEST_DATABASE_URL` at a real database.
- Tests run serially with forced `AI_PROVIDER=mock` and `WORKER_ENABLED=false`. Jobs are driven explicitly with `runDueJobs()`.
- `tests/supabaseInstall.test.ts` fails if `supabase/install.sql` is stale.

## Architecture

**Everything is state in Postgres.** No Redis or in-memory queue. The only in-memory state is the active messaging adapter connection (`messaging/registry.ts`), so restarts and adapter switches lose nothing.

**Job queue** (`jobs/queue.ts`, `jobs/worker.ts`):
- A `jobs` table, claimed with `FOR UPDATE SKIP LOCKED`. Job types: `processQuestion`, `deliverMessage`, `retention`, `processTranscript`.
- Handlers are wired in `bootstrap.ts`, which is shared by `index.ts` and the tests.
- `enqueueDebounced` upserts on `(type, dedupe_key)` while PENDING, so a burst of messages becomes one job.
- Throw `DeferError` to reschedule without counting a failure.
- Raw SQL timestamps are UTC `timestamp without time zone`. Use `(${date} AT TIME ZONE 'UTC')`, never `now()`.

**Inbound message pipeline:**
1. An adapter (`messaging/*Adapter.ts`) produces a `NormalizedMessage`.
2. `messaging/ingest.ts` applies routing:
   - groups must be allowlisted and need a native mention, opt-in text command, or quoted reply to the tutor;
   - private messages are always eligible;
   - then enrollment, rate-limit and dedup checks.
3. It calls `enqueueDebounced('processQuestion')`.
4. `jobs/handlers/processQuestion.ts`:
   - `context/correlator.ts` merges the sender's recent messages into one question;
   - messages are claimed via `consumedByJobId` in the same transaction that creates the `ResponseJob`.
5. `responses/draftService.ts` runs retrieval + AI, then `responses/approvalService.ts` routes the result: auto-send or the approval queue.
6. `responses/deliveryService.ts` (`deliverMessage` job) re-checks emergency pause settings at send time and claims APPROVED→SENDING atomically.

**Retrieval:**
- `retrieval/transcriptSearch.ts` does hybrid search: full-text on generated `tsvector` columns plus optional vector similarity.
- `retrieval/exampleSearch.ts` searches Approved Answer Memory (`memory/`).
- The embedding column is pgvector on Supabase and `real[]` + `kb_cosine()` elsewhere. `embeddings/vectorStore.ts` detects which one at runtime and builds SQL for it.
- Embeddings are independent of Groq: `EMBEDDING_PROVIDER` is `none` (keyword only), `openai_compatible` or `mock`.

**Transcripts** (`transcripts/`):
- Upload or paste. Text is extracted (`extract/`: PDF via unpdf, DOCX via mammoth, SRT/VTT, plain).
- The original goes to `storage/` (local disk, or a private Supabase bucket the server auto-creates). It is then chunked (~800 tokens, overlapping) and embedded in a `processTranscript` job.

**AI** (`ai/`):
- `getAI()` returns Groq (OpenAI-compatible) or a deterministic mock.
- Output is JSON. `validateAnswer.ts` checks citations against DB records.
- Usage and cost go to `aiUsage` and feed the daily budget.
- `setAI` / `setEmbedder` / `setMockAdapter` are test hooks.

**Config:** `config/env.ts` is a zod schema loaded via `dotenv/config` from `server/.env`. Blank vars count as unset. Runtime-editable settings live in the DB (`settings/settingsService.ts`), not in env.

## Gotchas

- Do not run `prisma migrate dev` against an existing DB without reviewing the generated SQL. Prisma cannot model the generated `tsvector` columns and proposes dropping them. Write migrations by hand, then run `supabase:sql`.
- In Supabase, everything lives in schema `tutor` (not `public`). `DATABASE_URL` and `DIRECT_URL` need `?schema=tutor`. Runtime uses the transaction pooler (6543, `pgbouncer=true`), migrations use the session pooler (5432). URL-encode special characters in the password.
- `supabase/install.sql` is generated and only for a fresh install. It refuses to run if `tutor._prisma_migrations` exists; upgrades use `db:migrate`.
- Compliance guards are intentional:
  - `platform_data_ai_training_allowed` is locked to `false`;
  - the experimental WhatsApp Web adapter (`messaging/whatsappWebAdapter.ts`, Baileys, loaded lazily) activates only after `whatsapp_web_risk_acknowledged`; the Cloud API adapter only after `cloud_api_policy_acknowledged`.
- WhatsApp adapters (see `docs/WHATSAPP.md`):
  - WhatsApp Web session files in `WHATSAPP_WEB_SESSION_DIR` are credentials. Baileys' logger stays silent, and the login QR is served only by the super-admin `/api/settings/messaging/qr`. Tests inject a fake socket via `setWhatsAppWebOptions`.
  - The Cloud API webhook (`messaging/cloudWebhook.ts`, `/api/webhooks/whatsapp`) is mounted before the JSON parser because it verifies `X-Hub-Signature-256` against the raw body. Tests use `setCloudConfig` and stub `fetch`. `vitest.config.ts` blanks the real `WHATSAPP_CLOUD_*` values.
  - The Cloud API declares no group support; groups fall back to the website chat.
- `ENABLE_DEV_ROUTES=true` enables the mock-adapter simulator on the Messaging page. The server refuses to start with it in production.

Production (VPS + Caddy + Docker, Supabase DB/storage, Groq): see `docs/DEPLOYMENT.md`, `deploy/`, `server/.env.production.example`.
