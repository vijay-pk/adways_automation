# WhatsApp setup and migration

The tutor talks to WhatsApp through a replaceable **messaging adapter**. Everything else — Groq answers,
the Supabase database, the transcript knowledge base, approved-answer memory, admin accounts and the approval
workflow — is independent of the adapter. Switching adapters on **Messaging → Active adapter** keeps all of it.

| | WhatsApp Web (experimental) | WhatsApp Business Platform (Cloud API) |
|---|---|---|
| Login | QR code, linked device | Meta app + approved business number |
| Official / allowed | **No** — unofficial automation; may violate WhatsApp terms, number can be banned | Yes |
| Private messages | Yes | Yes |
| Groups + @mentions | Yes (allowlisted groups only) | **No** — students use the website chat (`/chat`) |
| Reply window | None | Free-form replies only within 24 h of the student's last message |
| Credentials | Session files in `WHATSAPP_WEB_SESSION_DIR` | `WHATSAPP_CLOUD_*` environment variables |

Both adapters use the same routing rules (allowlisted groups, genuine mentions, enrollment, rate limits),
the same AI pipeline and the same approval / automatic-reply modes.

## Phase 1 — WhatsApp Web (testing)

Use a **separate test number**, never the business number you plan to move to the Cloud API. Linking a
device by QR code does not mean WhatsApp permits automated access.

1. Log in as a super admin → **Messaging**.
2. Turn on **WhatsApp Web automation risk acknowledged**.
3. Set **Active adapter** to **WhatsApp Web (experimental, QR login)**.
4. In the **WhatsApp Web login** card, scan the QR: phone → WhatsApp → Settings → Linked devices → Link a device.
   The card shows **Linked as …** once connected.
5. Groups: the first message in a group registers it on **Students & Groups**; enable it there. The tutor
   answers in a group only when it is @mentioned (or a student replies to one of its messages).
6. Start with automatic replies off (**Reply Settings**), so every answer waits in the approval queue before it is sent.

Notes:
- The session survives restarts. **Log out device** (or unlinking from the phone) deletes it; the next connect shows a new QR.
- Session files are credentials. Locally they are in `server/.wa-session/` (git-ignored); in Docker on the
  `wa_session` volume. They are never logged or returned by the API; the QR image is shown to super admins only.
- Only messages received while connected are processed. Older chat history is not imported.
- Emergency controls (pause all / groups / private, disconnect) work the same as for every adapter.

## Phase 2 — Official Cloud API (business number)

Before enabling, confirm in Meta Business Manager that the business is verified, the number is approved
for the WhatsApp Business Platform, and that your use case fits current WhatsApp Business policies.

1. Meta developer app → add **WhatsApp**. Note the **Phone number ID** and **WhatsApp Business Account ID**.
2. Create a **System User** with a permanent access token (`whatsapp_business_messaging`,
   `whatsapp_business_management`). The temporary 24-hour token from API Setup is for quick tests only.
3. Put these in `server/.env.production` (locally `server/.env`) and restart the server:
   ```
   WHATSAPP_CLOUD_PHONE_NUMBER_ID=...
   WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID=...
   WHATSAPP_CLOUD_ACCESS_TOKEN=...
   WHATSAPP_CLOUD_APP_SECRET=...      # App → Settings → Basic → App secret
   WHATSAPP_CLOUD_VERIFY_TOKEN=...    # any long random string you choose
   ```
4. Meta app → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://automation.adwaysacademy.com/api/webhooks/whatsapp` (also shown on the Messaging page)
   - Verify token: the same `WHATSAPP_CLOUD_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
   Meta must reach this URL over HTTPS, so the webhook works on the production server, not on `localhost`.
5. Messaging page → turn on **WhatsApp Business Platform policy checklist reviewed** → set **Active adapter**
   to **WhatsApp Business Platform** → **Check connection**. The card shows the number and which settings are present.

How it behaves:
- Webhooks are accepted only with a valid `X-Hub-Signature-256` signature (app secret).
- Meta retries webhooks; repeated message ids are ignored, so a student is never answered twice.
- Delivery receipts (sent / delivered / read) are stored on the delivery. A late **failed** receipt marks the
  reply **FAILED** in the approval queue with Meta's error code.
- An answer approved more than 24 hours after the student's message fails with error 131047 (template required).
  Keep approval turnaround under 24 hours.
- Groups are not available: tell group students to use the website chat. Issue codes on **Students & Groups → Web chat code**.

## Moving from WhatsApp Web to the Cloud API

- Switching the active adapter keeps transcripts, approved answers, settings, admins and history.
- Nothing is transferred from the WhatsApp Web session. Log out the device first (**Log out device**), then
  switch. A number registered on the Cloud API can no longer be used in the WhatsApp app or as a linked device.
- Students and conversations are stored per channel. The same person messaging the Cloud API number is a new
  WhatsApp Cloud student record, so re-check enrollment (**Students & Groups**, CSV import) if
  `require_enrollment` is on.
- Group allowlists do not carry over (the Cloud API has no group support).
