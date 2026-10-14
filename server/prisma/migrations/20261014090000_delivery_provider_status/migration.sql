-- Provider delivery receipts (WhatsApp Cloud API webhook: sent / delivered / read / failed).

ALTER TABLE "message_deliveries"
  ADD COLUMN "provider_status" TEXT,
  ADD COLUMN "provider_status_at" TIMESTAMP(3);

-- Receipts and quoted replies look deliveries up by the platform message id.
CREATE INDEX "message_deliveries_external_message_id_idx" ON "message_deliveries" ("external_message_id");
