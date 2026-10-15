# Vercel setup — final demo build

Use these environment variables for the deployment:

```text
DB_PATH=/tmp/rental-manager.sqlite
SEED_DEMO=true
SESSION_SECRET=choose-any-long-random-string
```

Optional custom administrator credentials:

```text
ADMIN_EMAIL=your-email@example.com
ADMIN_PASSWORD=your-password
```

The presentation recovery login is always available in this build:

```text
Email: admin@rental.local
Password: admin123
```

The visible currency is **TZ Shs (Tanzanian Shillings)**.

After changing environment variables, redeploy the project.

> `/tmp` SQLite is for a demo deployment only. Vercel may reset or isolate the data between instances. Use PostgreSQL/Supabase for permanent production data.
