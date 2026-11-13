# Campus Events

Campus Events is a role-based campus event operations app. Students discover and register for events; faculty and organizers submit and manage events; administrators manage users and venues and review submissions. The app also supports capacity-aware registration, venue/organizer schedule-conflict prevention, QR attendance check-in, feedback, notifications, and organizer analytics.

## Stack

- React 19, TypeScript, Vite, and Motion
- Node.js, Express 5, and PostgreSQL
- JWT authentication and bcrypt password hashing
- PostgreSQL constraints for event scheduling and data integrity

## Requirements

- Node.js 20.19+ or 22.12+
- PostgreSQL with the `btree_gist` extension available
- npm

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a PostgreSQL database (for example, `campus_events`) and apply the schema:

   ```sh
   psql -d campus_events -f database/schema.sql
   ```

3. Copy `.env.example` to `.env`. Set `DATABASE_URL` to your PostgreSQL connection string and set `JWT_SECRET` to a random value of at least 32 bytes. Keep `.env` private; it is ignored by Git.

   PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   Generate a suitable JWT secret locally:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

4. Start the API and frontend in separate terminals:

   ```sh
   npm run api:dev
   npm run dev
   ```

5. Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The API defaults to `http://127.0.0.1:3001`; check `GET /api/health` to confirm API/database connectivity.

Password reset email is optional and requires SMTP settings. See `.env.example`. Without SMTP configured, do not rely on email delivery.

### First administrator

Registration creates student accounts. For a local development database, register your own account, then promote that account using its exact email:

```sql
UPDATE users SET role = 'admin' WHERE email = 'your-email@example.com';
```

Run this only against your own development database. Never expose the database or use this shortcut as a public account-provisioning process.

## Roles and main workflows

| Role | Main capabilities |
| --- | --- |
| Student | Browse and save approved events, register, view attendance passes, and submit feedback after events |
| Faculty | Student event participation plus event creation and management |
| Organizer | Submit events, manage their own events, check in attendees, and view analytics |
| Admin | Manage users and venues and approve/reject submitted events |

New events submitted through the application begin in **pending** status and require administrator approval before appearing in the public event listing. Event creation also requires an available venue and an organizer-capable account. PostgreSQL prevents overlapping events for the same venue or organizer.

## Development checks

```sh
npm test
npm run lint
npm run build
```

The automated tests cover event validation and PostgreSQL event constraints. The integration test applies the schema and fixtures inside a transaction, then rolls everything back. It requires a **blank, disposable** database; never point `TEST_DATABASE_URL` at your app or production database.

PowerShell example:

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres:your-local-password@localhost:5432/campus_events_test"
npm test
```

GitHub Actions runs the same tests against a temporary PostgreSQL service. The project does not yet include browser end-to-end tests; verify role-based UI flows manually before a release.

Recommended manual smoke test with separate student, organizer, and administrator accounts:

1. As an administrator, create an available venue.
2. As an organizer, submit an event and confirm it is pending and not yet listed for students.
3. As an administrator, approve it and confirm it appears in Discover.
4. Submit overlapping events for the same venue and organizer; confirm the API rejects the conflict.
5. As a student, register and confirm capacity/waitlist behavior, then test check-in and post-event feedback with a completed test event.

## Demo and deployment notes

The 15 sample events and venues used in the current local demo are stored in that machine's database; they are not shipped as a seed script and are not part of a fresh database setup. Do not treat demo content as production data.

This repository currently provides local development and production build commands, but no deployment configuration. Before deploying, configure HTTPS, strong per-environment secrets, restricted database access, SMTP if needed, production client origins, backups, and monitoring. Do not use the local demo accounts or sample data in a public deployment.

## Resume summary

> Built a role-based campus event operations app using React, TypeScript, Express, and PostgreSQL, with event approval, scheduling conflict constraints, capacity-aware registration, QR attendance, and analytics. Added automated unit coverage for event validation and documented local setup.
