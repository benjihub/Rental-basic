# Vercel demo deployment

Use these Environment Variables in Vercel:

- `DB_PATH=/tmp/rental-manager.sqlite`
- `SEED_DEMO=true`
- `ADMIN_EMAIL=admin@rental.local`
- `ADMIN_PASSWORD=admin123` (change for your deployment)
- `SESSION_SECRET=<a-long-random-secret>`

Then redeploy the project.

## Why SESSION_SECRET matters
The application now uses a signed stateless login cookie instead of an in-memory session. This prevents `Unauthorized` errors when Vercel routes Rentals, Payments, or other API requests to a different serverless function instance.

## Demo-storage limitation
`/tmp` SQLite is temporary storage on Vercel. It is fine for a presentation/demo, but data is not guaranteed to persist across serverless instances or restarts. For permanent production data, move the database to PostgreSQL (for example Supabase/Neon).


## Important: Vercel login behavior
When both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, they are the canonical login credentials for every serverless instance. Do **not** change the password from inside the app on Vercel; update `ADMIN_PASSWORD` in Vercel Environment Variables and redeploy instead.

If you see `Invalid email or password`, verify the values in **Project → Settings → Environment Variables** are set for the **Production** environment and redeploy after any change.
