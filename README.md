# ProperlyPR Nonprofit CRM

A small-team nonprofit outreach CRM built from [hunzaarshadkhan/properlypr-nonprofit-crm](https://github.com/hunzaarshadkhan/properlypr-nonprofit-crm), revision `52b19d7f4b804c34ac1ee99d9392b93c2ee9d676`. Organizations keep their identity as outcomes move them between first calls, cold calls, email follow-ups, callbacks, meetings, review, and nurture.

This release adds the meeting's immediate requirements: CSV downloads, CSV uploads with automatic/editable field mapping, and direct **Update status** actions. It also adds a Railway production server with authentication and a persistent SQLite database. Email and SMS sending are not included; reps send externally and record the actual outcome.

Live instance: **https://crm-production-2467.up.railway.app**. The CRM uses **Continue with Google**, restricted to verified **@properlypr.com Google Workspace** accounts. Shared admin/password login is removed in this release. Production starts empty pending the actual workbook.

## Run locally

Use Node.js 24 or newer and install pinned dependencies with `pnpm install --frozen-lockfile`. Production Google login uses the official `google-auth-library`; the loopback demo still uses a local developer identity.

```sh
node build.mjs
node dev/server.mjs
```

Open **http://127.0.0.1:8787**. Development binds to loopback, supplies a demo identity, and loads three fictional organizations into `.local/crm.sqlite`. It must never be exposed as the production server. The production server starts empty and never loads examples.

```sh
npm test
```

Tests cover workflow timing, notes, revisions and retries, CSV parsing/mapping/validation, duplicate handling, imports, formula-safe exports, HTTP authentication, identity spoofing, CSRF, login throttling, Google token signatures/audience/issuer/expiry, state/nonce/PKCE, callback replay, approved emails, logout revocation, and persisted sessions, organizations and notes across server restart. Google tests use locally signed tokens and a local token/certificate server; they do not require real Google credentials.

For browser acceptance checks, install Chromium with `pnpm exec playwright install chromium` and run `pnpm run test:ui`. This exercises rich record creation, initial notes, profile edits, email search, directory contact details, mobile creation, invalid input, and unsaved-form protection through the actual UI. CI runs it with a signed local Google fixture.

## Adding organizations

**Organizations → Add organization** captures the primary contact and organization together. Name and EIN are required. Optional fields include contact name/role, working email, phone, email permission and evidence, website, mailing address, focus area, assigned rep, and an initial team note. Expand **More organization details & research** for mission, reported revenue/tax period, an unverified email candidate, and research notes/source. These fields remain editable in the profile.

Choose Available or the first-call queue when creating the record. The organization and initial note save together in one transaction; retries do not duplicate either. Invalid fields leave the form intact for correction. The directory shows working email, contact/phone, assigned rep, and workflow state; search includes contact details and owner. Email and phone links are available from the directory and profile. Candidate emails remain separate, and zero reported revenue is displayed as zero.

## Daily work and status updates

Open a queue or search Organizations, then choose **Update status**. The form offers outcomes valid for the current stage, including Not connected, email requested, callback requested, meeting booked, not interested, wrong number, dial failed, and do not contact. Saving records an attributed activity and changes the next action together. Stale concurrent changes are rejected. Stopped records have no outreach actions.

Email completion advances the seven-touch sequence using business-day offsets **0, 2, 4, 7, 10, 14, 21**, anchored to the first recorded send. Existing terminal-sequence review rules are retained. The application does not send an email or text when an outcome is saved. Times and scheduling use America/New_York and skip weekends; no holiday calendar is configured.

Profile editing includes assigned rep, contact details, email permission (Yes / No / Unknown), and permission evidence. Published email candidates remain separate from working addresses. People remains a minimal filing-based board/officer list; this release retains one primary outreach contact and one active workflow per organization.

## CSV upload and download

**Organizations → Upload CSV**:

1. Download the column template if needed. Upload a UTF-8, comma-separated CSV with one header row, at most 1,000 records, 60 columns, and 1.5 MB. Quoted commas, embedded newlines, escaped quotes, CRLF, and a UTF-8 BOM are supported.
2. Review automatic column matches and edit them. Organization name and nine-digit EIN are required. Ambiguous column matches are left for review. Preserve leading-zero EINs as text when exporting from Excel.
3. Choose Available, First call, Contact review, Review, Nurture, or Do not contact as the new records' destination. Nurture imports are due for review today; no historical pause date is invented.
4. Choose **Validate & preview**. Correct invalid rows in the source file, or adjust mappings. Validation does not write data. Every invalid row must be fixed before the file can be imported.
5. Choose **Import new records**. Existing EINs and repeated EINs in the upload are skipped. No existing profiles, outcomes, notes, or suppression states are overwritten. Repeated submissions do not create duplicate organizations. Valid inserts are committed in one transaction.

Each record retains its filename, source row, original cell values, import batch, and import timestamp. An import entry is marked `csv-import` and has no outreach occurrence date. Unmapped historical status/date columns remain evidence; they do not silently create meetings, callback appointments, past outreach, or sequence enrollments. Use Record outcome for new work. A complete workbook migration, including related people and historical date precision, requires a separate reconciliation once the actual file is supplied.

**Download CSV** is available in Organizations, Calls due, Emails due, First calls, Cold calls, Callbacks, Meetings, Nurture, Review, and Review and nurture. It exports the current search/work-tab/exception filters, including person name, domain, phone, working email, permission, owner, and workflow fields. Formula-like text is prefixed with an apostrophe for spreadsheet safety; some downstream tools may display this prefix. CSV exports are operational lists, not full database backups.

## Railway deployment

Railway builds the included `Dockerfile` using Node 24, listens on `0.0.0.0:$PORT`, and checks `/healthz`. The container installs the pinned production Google authentication library using the lockfile. SQL migrations run transactionally at startup, after the volume is mounted. The existing SQLite schema is retained, with foreign keys, WAL, full synchronous writes, and a busy timeout.

1. Create a Railway project and empty `crm` service. Attach a persistent **volume at `/data`**. Use one replica. Database storage must not live in the container's ephemeral filesystem.
2. In Google Cloud → Google Auth Platform, configure the consent screen and create an OAuth client with type **Web application**. Register the exact callback `<APP_ORIGIN>/auth/google/callback`. For the current instance:

   ```text
   https://crm-production-2467.up.railway.app/auth/google/callback
   ```

   Keep the downloaded OAuth JSON private. Configure External audience if approved users include personal Gmail accounts; Internal is suitable only for users within the owning Google Workspace organization. CRM access is checked by the server against its configured Workspace domain. The Google `hd` parameter only guides account selection; the signed token is checked after login.

3. Generate a Railway public domain targeting port 8080. Configure these private service variables:

   | Variable | Value |
   | --- | --- |
   | `APP_ORIGIN` | Exact public HTTPS origin, without a trailing slash |
   | `CRM_DATABASE_PATH` | `/data/crm.sqlite` |
   | `GOOGLE_CLIENT_ID` | Web application OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | OAuth client secret, configured privately |
   | `CRM_ALLOWED_DOMAIN` | `properlypr.com` — exact email domain and verified Google Workspace `hd` must both match |
   | `NODE_ENV` | `production` |
   | `PORT` | `8080` |

4. Deploy this checkout with `railway up` or connect the service to the branch containing these changes. `railway.json` configures the Dockerfile, healthcheck, and restart behavior. A missing volume, invalid login configuration, or missing HTTPS origin fails startup rather than exposing an unsecured or nonpersistent workspace.
5. Visit the HTTPS origin, sign in, and check `/healthz`. A production database starts empty. Import real records only after their mapping and provenance have been reviewed.

The Railway server discards caller-supplied identity and privileged-import headers. Google login uses an authorization code with PKCE, a browser-bound random state, and a nonce. The Google library verifies the ID token signature, issuer, audience and expiry; the CRM also checks nonce, verified email, Gmail/Workspace ownership and the configured access policy. Domain mode requires both the email suffix and signed Workspace domain to match exactly; Gmail accounts, lookalike domains and subdomains cannot bypass this. The callback is single-use and expires after ten minutes. Google access and refresh tokens are not retained. Only `openid email profile` scopes are requested.

The database stores the stable Google `sub`, verified email and display name in `crm_users`. Notes and activities are attributed to the verified email. Session cookies contain opaque random tokens; only their hashes are stored in `auth_sessions`. Cookies are Secure on HTTPS, HttpOnly, SameSite=Lax (needed for Google's top-level callback), and expire after eight hours. All application writes require `APP_ORIGIN`. Logout deletes the server session. Pending sign-ins and sessions survive restarts. Login starts are rate-limited in memory. Secrets, authorization codes and token responses are never logged.

The live policy admits all verified users whose email and Google Workspace domain are exactly `properlypr.com`. Manage team membership in Google Workspace. CRM sessions last up to eight hours; suspending an account in Google does not itself revoke an already-issued CRM session. All admitted users currently share editing privileges; role administration is future work. An email already bound to one Google `sub` cannot silently be taken over by another Google account. Other deployments can instead configure `CRM_ALLOWED_EMAILS` as a comma-separated list of approved Gmail/Workspace accounts. Configure exactly one access mode; setting both email and domain policies fails startup. Existing sessions are rechecked against the configured policy.

`CRM_USERS_JSON`, `SESSION_SECRET`, and old `.local/admin-credentials.json` values are no longer used. Old password sessions are rejected. Delete obsolete Railway password variables after the successful Google deployment. Test actual account selection/consent with an approved user before calling the full production sign-in accepted; automated fixtures cover protocol verification but do not impersonate a real Google user.

A volume-backed service has brief downtime on redeployment and cannot scale horizontally. See [Railway volumes](https://docs.railway.com/volumes) and [healthchecks](https://docs.railway.com/deployments/healthchecks). Move to a server database such as PostgreSQL if multiple application replicas become necessary.

### Backups and recovery

The current Hobby workspace rejected Railway backup schedules because the API requires a Pro workspace. **Automatic backups are not configured.** Arrange external backups or enable Railway backups on a supported plan. The included command creates a consistent SQLite backup using SQLite's online backup API:

```sh
CRM_DATABASE_PATH=/data/crm.sqlite node scripts/backup.mjs /data/crm-backup.sqlite
```

Copy backups to separate storage. A backup stored only on the source volume is not protection against losing that volume. To restore a manual SQLite backup, stop the application, replace the database with the backup, remove obsolete `-wal`/`-shm` files, and restart. Restore to a separate test database first and verify organization and note counts. Production restore has not been exercised by the automated tests. Never copy only a live SQLite main file while ignoring its WAL.

### Current deployment and updates

The live release was uploaded directly. The source branch is `railway-csv-crm` in the public development fork. The original repository was read-only to the implementation account. Railway rejected connecting the fork with “User does not have access to the repo”; GitHub automatic deployment is not configured. After review/merge, the repository owner can connect the original repository in Railway. Do not point Railway at the old upstream main branch before these changes are merged.

For direct updates, run tests, commit the release, and use either `railway up` or the included source uploader:

```sh
npm test
RAILWAY_API_TOKEN_FILE=/path/to/private/token node scripts/deploy-railway.mjs
```

The uploader reads saved IDs from `.local/railway-deployment.json` on this workstation. On another workstation set `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and `RAILWAY_SERVICE_ID`. It deploys only a clean, committed HEAD using `git archive`, keeping local credentials and database files out of the uploaded release. The account token belongs on the deployment workstation, never in the CRM service's environment.

## Data handoff and recommended next features

The actual Excel workbook is not included in this checkout. The supplied analysis and meeting notes informed the requirements; the reported 502 organizations, 2,974 board entries, 885 activities, and queue counts have not been independently verified here. No real prospects or synthetic examples are seeded in production.

Recommended order after the first import:

1. **Import reconciliation:** migrate all workbook sheets with stable relationships, unknown historical dates, import batches, and a review report. Preserve suppression. Distinguish imports from rep activity before adding productivity reports.
2. **Rep ownership and readiness filters:** owner/unassigned views, missing working emails, unverified candidates, missing meeting/callback times, and correction work. Owner editing and the original basic blocker views are already available.
3. **Shared mailbox integration:** manual compose/send and response capture with recipient, sender, permission evidence, delivery state, retries, and idempotency. Only advance a sequence after a confirmed send, not merely after pressing Send.
4. **Meeting/calendar integration:** attendees, meeting link, duration, rescheduling, and cancellation of obsolete reminders.
5. **Twilio SMS:** manual messaging first, then automation after account access, sender configuration, consent, opt-outs, and delivery handling are defined.
6. **Multiple contacts, opportunities, and roles:** separate contacts and tasks as needed; proposal value and decision date; manager/reviewer roles. Nonprofit reported revenue must stay separate from opportunity value.

## Source layout

| File | Purpose |
| --- | --- |
| `index.html` | Dashboard, queues, directory, organization forms, CSV mapping/preview |
| `worker.js` | API validation, revisions, notes, outcomes, privileged legacy import |
| `csv.js`, `csv-api.js` | Shared CSV codec/mapping and transactional API import/export |
| `workflow.js`, `cadence.js` | State transitions and Eastern business-day scheduling |
| `server/` | Railway HTTP server, Google OAuth verification, approved accounts and revocable sessions |
| `schema.ts`, `drizzle/` | SQLite schema and versioned migrations |
| `dev/` | Loopback demo server, SQLite adapter and fictional data |
| `scripts/` | Consistent SQLite backup and Railway source deployment |
| `Dockerfile`, `railway.json` | Production container and Railway deployment configuration |

For schema changes, install development dependencies using `pnpm install --frozen-lockfile`, edit `schema.ts`, run `pnpm run db:generate`, and commit migrations and metadata. The original Cloudflare Worker build remains supported; a host using it directly must provide its own trusted identity gateway. Railway uses `server/server.mjs` instead. Original privileged JSON import remains inaccessible through the Railway gateway; team users use the validated CSV flow.
