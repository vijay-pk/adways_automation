-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WHATSAPP_WEB', 'WHATSAPP_CLOUD', 'MOCK', 'WEB');

-- CreateEnum
CREATE TYPE "ChatType" AS ENUM ('GROUP', 'PRIVATE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('RECEIVED', 'CONTEXT_ONLY', 'QUEUED', 'CONSUMED', 'IGNORED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('GENERATING', 'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'SENT', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "administrators" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'VIEWER',
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "administrators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "totp_pending" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "normalized_phone_number" TEXT,
    "display_name" TEXT,
    "enrollment_status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "web_access_code_hash" TEXT,
    "daily_limit_override" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "module_name" TEXT,
    "lesson_title" TEXT,
    "file_hash" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "processing_status" "TranscriptStatus" NOT NULL DEFAULT 'PENDING',
    "processing_error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_chunks" (
    "id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp_start" TEXT,
    "timestamp_end" TEXT,
    "token_estimate" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "chat_type" "ChatType" NOT NULL,
    "student_id" TEXT,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incoming_messages" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_external_id" TEXT NOT NULL,
    "sender_id" TEXT,
    "content" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "mention_metadata" JSONB,
    "is_mention" BOOLEAN NOT NULL DEFAULT false,
    "quoted_message_id" TEXT,
    "processing_status" "ProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "consumed_by_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incoming_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "response_jobs" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_external_id" TEXT NOT NULL,
    "triggering_message_id" TEXT,
    "normalized_question" TEXT,
    "intent" TEXT,
    "context_message_ids" TEXT[],
    "previous_job_id" TEXT,
    "retrieved_chunk_ids" TEXT[],
    "example_ids_used" TEXT[],
    "draft_answer" TEXT,
    "approved_answer" TEXT,
    "source_refs" JSONB,
    "evidence_sufficient" BOOLEAN,
    "confidence" DOUBLE PRECISION,
    "status" "ResponseStatus" NOT NULL DEFAULT 'GENERATING',
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "reviewer_notes" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "response_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "response_drafts" (
    "id" TEXT NOT NULL,
    "response_job_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'initial',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "response_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approved_answer_examples" (
    "id" TEXT NOT NULL,
    "response_job_id" TEXT,
    "original_question" TEXT NOT NULL,
    "context_snapshot" JSONB,
    "normalized_question" TEXT NOT NULL,
    "approved_answer" TEXT NOT NULL,
    "original_draft" TEXT,
    "was_edited" BOOLEAN NOT NULL DEFAULT false,
    "edit_summary" JSONB,
    "reviewer_notes" TEXT,
    "transcript_sources" JSONB,
    "module_name" TEXT,
    "topic_tags" TEXT[],
    "language" TEXT,
    "channel" "Channel",
    "reusable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quality_status" TEXT NOT NULL DEFAULT 'approved',
    "usefulness_score" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approved_answer_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" TEXT NOT NULL,
    "response_job_id" TEXT NOT NULL,
    "external_message_id" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "administrator_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "response_job_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'answer',
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "estimated_cost" DECIMAL(12,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "administrators_email_key" ON "administrators"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "students_normalized_phone_number_idx" ON "students"("normalized_phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "students_channel_platform_user_id_key" ON "students"("channel", "platform_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_channel_external_chat_id_key" ON "groups"("channel", "external_chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_file_hash_key" ON "transcripts"("file_hash");

-- CreateIndex
CREATE INDEX "transcripts_module_name_lesson_title_idx" ON "transcripts"("module_name", "lesson_title");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_chunks_transcript_id_chunk_index_key" ON "transcript_chunks"("transcript_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_channel_external_chat_id_key" ON "conversations"("channel", "external_chat_id");

-- CreateIndex
CREATE INDEX "incoming_messages_conversation_id_sender_external_id_timest_idx" ON "incoming_messages"("conversation_id", "sender_external_id", "timestamp");

-- CreateIndex
CREATE INDEX "incoming_messages_consumed_by_job_id_idx" ON "incoming_messages"("consumed_by_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_messages_channel_external_message_id_key" ON "incoming_messages"("channel", "external_message_id");

-- CreateIndex
CREATE INDEX "response_jobs_status_created_at_idx" ON "response_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "response_jobs_conversation_id_sender_external_id_created_at_idx" ON "response_jobs"("conversation_id", "sender_external_id", "created_at");

-- CreateIndex
CREATE INDEX "response_drafts_response_job_id_idx" ON "response_drafts"("response_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "approved_answer_examples_response_job_id_key" ON "approved_answer_examples"("response_job_id");

-- CreateIndex
CREATE INDEX "approved_answer_examples_reusable_enabled_idx" ON "approved_answer_examples"("reusable", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_response_job_id_key" ON "message_deliveries"("response_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_settings_key_key" ON "application_settings"("key");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage"("created_at");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "jobs_type_dedupe_key_status_idx" ON "jobs"("type", "dedupe_key", "status");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "administrators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "administrators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_messages" ADD CONSTRAINT "incoming_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_messages" ADD CONSTRAINT "incoming_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_jobs" ADD CONSTRAINT "response_jobs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_jobs" ADD CONSTRAINT "response_jobs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "administrators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_drafts" ADD CONSTRAINT "response_drafts_response_job_id_fkey" FOREIGN KEY ("response_job_id") REFERENCES "response_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approved_answer_examples" ADD CONSTRAINT "approved_answer_examples_response_job_id_fkey" FOREIGN KEY ("response_job_id") REFERENCES "response_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_response_job_id_fkey" FOREIGN KEY ("response_job_id") REFERENCES "response_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_settings" ADD CONSTRAINT "application_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "administrators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_administrator_id_fkey" FOREIGN KEY ("administrator_id") REFERENCES "administrators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_response_job_id_fkey" FOREIGN KEY ("response_job_id") REFERENCES "response_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
