# AgriKSense API: implementation notes

Base path `/api/v1`. The machine-readable route list is served at `GET /api/v1/openapi.json`.

## Conventions (spec §2)

- **Envelopes.** Successful responses use `{ "data": …, "meta"?: …, "request_id": "…" }`. Errors use `{ "error": { "code", "message", "details"? }, "request_id" }`. Validation errors are `422 VALIDATION_ERROR` with `details: [{ field, reason }]`.
- **Request IDs.** Every response carries the `X-Request-Id` header. If the client sends a well-formed `X-Request-Id`, the server reuses it.
- **Authentication.**
  - Access tokens are JWTs that expire after 15 minutes.
  - Refresh tokens are opaque, stored hashed, and rotated on every use. Reusing an already-rotated refresh token revokes that whole token family.
  - Disabling a user revokes all of their sessions, and disabled users are blocked on every request.
- **Roles and permissions.** The base roles are `farmer`, `dco`, `organization_admin` and `platform_admin`. Admin endpoints check granular permissions (`GET /admin/permissions`). A user's effective permissions are their base role's defaults plus every custom role assigned to them.
- **Pagination.** List endpoints accept `page`, `page_size` (max 100), `sort` (`field` or `-field`) and `search`, and return `meta: { page, page_size, total, total_pages }`.
- **Money.** Rates are shown as decimal naira strings (`"250.00"` per mile); computed amounts are integer kobo. Distances carry an explicit unit (`mile`).
- **Sensitive data.**
  - NIN, CAC and bank account numbers are encrypted with AES-256-GCM and are never returned unmasked. The one exception is `GET /admin/verifications/{id}`, which shows the full number to a reviewer and is audited.
  - Documents are stored privately and served only through signed links that expire after 5 minutes (`GET /documents/{id}/access`).
  - Uploads are type-checked from the file's content (magic bytes), not the declared MIME type.
- **Audit log.** Sensitive reads and all mutations are recorded and can be queried at `GET /admin/audit-logs`.

## Additions beyond the 125 specified endpoints

| Endpoint | Why |
| --- | --- |
| `GET /admin/verifications`, `GET /admin/verifications/{id}`, `POST /admin/verifications/{id}/review` | The spec says verification can't claim success until "a trusted provider or authorized reviewer confirms it". These endpoints give reviewers a queue and a decision action. |
| `GET /files/{token}` | Serves the short-lived signed URLs issued by `GET /documents/{id}/access`. |
| `GET /openapi.json` | The OpenAPI baseline from the implementation roadmap. |

## Decisions taken on open PRD questions (spec §8): please confirm

1. **AgriKSense IDs.**
   - IDs are random, zero-padded 10-digit strings, not sequential, so they can't be enumerated.
   - They are immutable.
   - Every issued ID is kept in `IssuedAgriksenseId`, so an ID is never reused.
2. **Imported users and NIN.**
   - NIN is optional in CSV imports.
   - An imported NIN creates a verification in `manual_review`; it is never auto-verified.
   - Imported users have no password and activate their account through a password reset.
   - Imported users stay in onboarding `draft` or `pending_verification` until their NIN is verified.
3. **Onboarding status.**
   - `complete` requires a verified NIN (farmers and DCOs) or verified CAC (registered organizations), plus the profile, passport photo and a bank account.
   - Unregistered organizations need no CAC.
   - Submitting a NIN or CAC alone never marks onboarding complete.
4. **Consent.**
   - Registering records two decisions: `account_creation` (always accepted) and `farm_data_collection` (the farmer's choice).
   - Withdrawing `farm_data_collection` consent blocks new crop, farmland, observation and visit records on that farmer's farms (`403 CONSENT_REQUIRED`). Data already collected is kept and stays readable.
   - A visit can end early (`status: ended_early` with an `end_reason`), and any partial data from it is kept.
5. **Fares.**
   - There is no routing provider. Distance is the haversine distance multiplied by `FARE_ROAD_FACTOR` (default 1.3), in miles.
   - Each fare estimate returns both the individual round-trip fare per farm and a grouped nearest-neighbour route, along with the assumptions used.
   - Rates are set per state with an effective date.
   - There is no maximum fare and no approval step yet.
6. **Groups.** Admin groups (`/admin/groups`) are typed (`farmer`, `dco` or `organization`). The farmer profile's free-text `farming_group` field is a separate thing.
7. **Role assignment.** Custom roles can be assigned only to DCO users, as the PRD states. System roles can't be assigned; they are the base-role defaults.
8. **Data access.**
   - Farmers own their farms.
   - A DCO can read a farm and collect data on it only while they hold an active assignment for it.
   - An organization admin can read farms belonging to its *verified* members.
   - Everyone else needs admin permissions.
9. **Membership verification.** The organization attests a membership by calling `POST /organizations/me/members/{id}/verify`. Changing a membership ID resets its status to `not_verified`.
10. **AI.**
    - Every authenticated user can run inference.
    - Predictions and their images are kept.
    - Feedback from users who hold `ai.models.manage` is marked as a verified label.
    - A model version must be approved (with QA metrics and an ordered class list) before it can be activated. Rollback restores the most recently active approved version.
    - Class names always come from the approved class map, never from the model service's response.
11. **Google OAuth.** The ID token is verified against `GOOGLE_CLIENT_ID`. New accounts must state a role, and farmers must also send their consent decision. Google accounts always have an email address; a phone number is optional, except for DCOs, who must provide one.
