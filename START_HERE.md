# Start Here

This project is ready to run locally with Node.js 22+ and does not require `npm install` because it uses no external packages.

```bash
npm start
```

Then open **http://localhost:3000**.

Default first-run login:

- Email: `admin@rental.local`
- Password: `admin123`

Change the password under **Settings** before real use.

For a blank installation (no sample rooms/tenants), delete the database if one exists and start with:

```bash
SEED_DEMO=false npm start
```

See `README.md` for deployment, database, backup, payment, and receipt details.
