# AgriKSense Backend

REST API for the AgriKSense platform, built against the **AgriKSense Backend API Endpoint Specification v1**: all 125 specified endpoints across the 9 modules are implemented under `/api/v1`, with a few necessary additions listed in [`docs/API.md`](docs/API.md).

**Stack:** Node.js 20+, TypeScript, Express 4, Prisma 6 with PostgreSQL, Zod validation, Vitest and Supertest.

## Quick start

```bash
# 1. Database (or use an existing PostgreSQL 14+)
docker compose up -d                      # creates "agriksense" and "agriksense_test"

# 2. Configure
cp .env.example .env                      # set DATABASE_URL, secrets, SEED_ADMIN_* …
#    For local testing without the real AI services / NIN provider, also set:
#    VERIFICATION_PROVIDER=mock  AI_INFERENCE_MODE=mock

# 3. Install, migrate, seed
npm install
npx prisma migrate deploy
npm run db:seed                           # states/LGAs, banks, consent text, roles, AI registry, first admin

# 4. Run
npm run dev                               # http://localhost:4000/api/v1
```

Production: `npm run build && npx prisma migrate deploy && npm start`.

Useful URLs:

| URL | Purpose |
| --- | --- |
| `GET /api/v1/openapi.json` | OpenAPI 3 document generated from the live routes (import into Postman or Insomnia) |
| `GET /api/v1/health/live`, `/health/ready` | Liveness probe, and readiness (checks the database and storage) |

## Deploying to Render

The repo includes a Render Blueprint (`render.yaml`). It creates a PostgreSQL database and the API web service in Frankfurt on the free plan, and generates every secret.

1. In the Render dashboard, choose **New → Blueprint** and select this repository. The Blueprint deploys the `claude/funny-curie-p1cz1v` branch; change `branch:` in `render.yaml` after merging to `main`.
2. Click **Apply**. The first build takes a few minutes. Every start runs the migrations and the idempotent seed.
3. Find the admin login under **agriksense-api → Environment**: the email is `SEED_ADMIN_EMAIL` and the password is the generated `SEED_ADMIN_PASSWORD`.
4. Give testers the base URL `https://<service>.onrender.com/api/v1`. They can import `https://<service>.onrender.com/api/v1/openapi.json` into Postman.

The deployment runs with `NODE_ENV=staging`, which has these effects:
- NIN/CAC checks use the mock provider.
- AI predictions use mock inference.
- Messages, including password-reset codes, appear under **agriksense-api → Logs**.

**Free-plan limits:**
- The service sleeps after 15 minutes idle, so the first request after that takes about a minute.
- Uploaded files are stored on the instance and are lost on each redeploy. Add a Render Disk (paid) mounted at `STORAGE_DIR`, or object storage, for persistence.
- The free database expires after 30 days. Upgrade it to keep the data.

## Tests

```bash
npm test          # 66 integration tests against the agriksense_test database
npm run typecheck
```

The test setup migrates the `agriksense_test` database, truncates it and re-seeds it. It refuses to run against any database whose name doesn't contain `test`. Override the database with `TEST_DATABASE_URL`. Tests use the mock verification and inference modes, so they need no network access.

## QA / manual testing guide

1. **Sign in as the seeded admin.** Use `POST /auth/login` with `{"identifier": SEED_ADMIN_EMAIL, "password": SEED_ADMIN_PASSWORD}`, then send `Authorization: Bearer <access_token>` on every request.
2. **Register users** through `/auth/register/{farmers|dcos|organizations}`. Each one gets a 10-digit `agriksense_id`. You can log in with the email, the phone number or the AgriKSense ID.
3. **NIN/CAC verification with `VERIFICATION_PROVIDER=mock`.** The outcome depends on the last 4 digits of the number:

   | Last 4 digits | Result |
   | --- | --- |
   | `0000` | verified |
   | `1111` | name mismatch, goes to manual review |
   | `9999` | rejected |
   | `5555` | provider timeout, goes to manual review |
   | anything else | manual review |

   With the default `manual` provider, every submission waits for a reviewer: `GET /admin/verifications`, then `POST /admin/verifications/{id}/review`.
4. **AI predictions.** Models are seeded as `registered`, not approved. To enable predictions:
   1. Approve a version with its ordered class list: `POST /admin/ai/models/{crop}/approve` with `{"version":"qa-1","classes":[…],"metrics":{…}}`.
   2. Activate it: `POST /admin/ai/models/{crop}/activate`.

   With `AI_INFERENCE_MODE=mock`, predictions return deterministic detections and no model service is needed.
5. **Endpoints that need an `Idempotency-Key` header:** `POST /imports`, `POST /imports/{id}/commit` and `POST /admin/farm-assignments`. Sending the same key again replays the original response.
6. **Messages in development.** SMS, WhatsApp and email (welcome messages, password-reset codes) are written to the server log by the `log` notification provider.

## Project layout

```
prisma/schema.prisma        data model (single init migration in prisma/migrations)
prisma/seed.ts, data/       idempotent reference data
src/app.ts                  express app + router mounts
src/modules/*.routes.ts     endpoint handlers, one file per spec module
src/services/               access control, onboarding, verification, inference, fares, notifications
src/lib/                    errors/envelopes, validation, pagination, crypto, files, tokens, audit
tests/                      integration tests (one file per area)
docs/API.md                 conventions, decisions on open PRD questions, additions
```

## Before go-live

These steps are needed before production; the spec's §8 decisions are also tracked in `docs/API.md`:

- **AI services.** Confirm each service's real `/openapi.json`. Set `AI_PREDICT_PATH`, `AI_UPLOAD_FIELD`, `AI_HEALTH_PATH` and `AI_CONFIDENCE_SCALE` to match it, then approve each model with its verified class list. The QA hosts couldn't be reached from the build environment.
- **Identity verification.** Choose an NIN/CAC verification vendor and implement `VerificationProvider` in `src/services/verification.provider.ts`.
- **Messaging.** Choose SMS, WhatsApp and email vendors and plug them into `src/services/notification.service.ts`.
- **LGA data.** Complete LGAs are seeded for FCT, Lagos, Kaduna, Kano, Kebbi, Benue, Niger, Plateau and Ogun only. Add the remaining states to `prisma/data/nigeria.ts` and re-run the seed.
- **Consent wording.** Replace the DRAFT consent text with the legally approved wording by publishing a new version.
- **Infrastructure.**
  - Replace local disk storage (`src/lib/files.ts`) with object storage.
  - Move the in-memory rate limiter to Redis when running more than one instance.
  - Set strong `JWT_*`, `DATA_ENCRYPTION_KEY` and `HASH_KEY` values. The app refuses to start in production without them.
