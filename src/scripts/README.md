# Database scripts

Scripts for bootstrapping a fresh database, running one-off migrations, and operational maintenance.

Scripts are grouped by intent:

| Folder | Purpose |
|--------|---------|
| `seed/` | Safe bootstrap for a **new** production database |
| `dev/` | Local/staging demo data — **do not run on production** |
| `migrate/` | Historical schema/data migrations for **existing** databases |
| `fix/` | One-off repairs for known data/index issues |
| `maintenance/` | Ongoing ops tools (backfills, cleanup, user deletion) |

## Fresh production bootstrap

Point `MONGODB_URI` (or `MONGO_URI`) at the new database, then:

```bash
npm run seed:prod
```

This runs, in order:

1. `seed:csv` — imports the service catalog from CSV (**wipes** existing `ServiceConfiguration` rows)
2. `seed:admin` — creates the first admin user and loyalty defaults (skips if admin exists)
3. `seed:cms` — seeds published policy pages (requires an admin user)

Change the default admin password after first login.

### Optional index fixes

Only needed if you see `E11000` duplicate-key errors on support chats or invoice sequences on a database that predates current Mongoose indexes:

```bash
npm run fix:conversation-indexes
npm run fix:invoice-sequence-indexes
```

## Development / staging only

```bash
npm run seed:admin-staff   # RBAC test staff (@fixtract.test, known password)
npm run seed:professionals # Demo professional accounts (deletes existing pros)
npm run seed:rfq-flow      # Hardcoded RFQ E2E project fixture
```

## Historical migrations

For databases upgraded from older schema versions. **Not needed** on a database created with current models + `seed:prod`.

```bash
npm run migrate:service-config-countries
npm run migrate:service-config-active-countries
npm run migrate:project-statuses
npm run migrate:preparation-duration
npm run migrate:professional-id-objectids
npm run migrate:professional-usernames    # supports --dry-run
npm run migrate:team-member-to-employee
npm run migrate:employee-fields-cleanup   # supports --dry-run
```

## One-off fixes

```bash
npm run fix:merge-solar
npm run fix:solar-service-names
npm run fix:stuck-milestone-quotes        # supports --dry-run
```

## Maintenance

```bash
npm run maintenance:backfill-project-geo    # DRY_RUN=1, GOOGLE_MAPS_API_KEY
npm run maintenance:remove-pro-availability
npm run delete:user -- user@example.com
```

## Environment variables

Most scripts accept `MONGODB_URI` or `MONGO_URI`. A few scripts connect via `connectDB()` from `src/config/db.ts`, which reads the same env vars.

| Variable | Used by |
|----------|---------|
| `MONGODB_URI` / `MONGO_URI` | All scripts |
| `GOOGLE_MAPS_API_KEY` | `maintenance:backfill-project-geo` |
| `DRY_RUN` | `maintenance:backfill-project-geo` |
| `GEOCODE_DELAY_MS` | `maintenance:backfill-project-geo` |
