# Rental Manager — Final Rebuild

A complete single-business rental management system built for room/property operations. It is deliberately **not SaaS**: there are no organizations, subscriptions, tenant plans, or public sign-up flows.

## What is included

- Administrator login and password change
- Dashboard with rooms, occupancy, monthly collections, outstanding and overdue rent
- Rooms: add/edit, type, floor, monthly rate, availability, maintenance
- Tenants: full contact details, current room, balance, detailed rent ledger and payment history
- Rentals: move-in, monthly rent, due day, deposit, move-out/end rental
- Automatic monthly rent charges for every active rental
- Payments with partial-payment support
- Advance payments automatically allocated into future rental months
- Printable rent receipts (browser Print → Save as PDF)
- Payment reversals with audit history instead of destructive deletion
- Outstanding rent reporting
- Occupancy reporting
- Expense tracking and net cash summary
- Business/currency/settings management
- Activity log
- Responsive desktop/mobile UI
- Persistent SQLite database
- Zero third-party npm dependencies

## Requirements

- Node.js 22.5+ (tested with Node 22.16)

## Start

```bash
cd rental-manager-final
npm start
```

Open:

```text
http://localhost:3000
```

### Default first-run login

```text
Email: admin@rental.local
Password: admin123
```

Change the password immediately under **Settings**.

You can override the first-run admin credentials:

```bash
ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='a-strong-password' npm start
```

## Demo data

The first run seeds six rooms and three tenants/rentals so the dashboard is not empty. Set this before the first run to start with no demo property records:

```bash
SEED_DEMO=false npm start
```

To delete the SQLite database and recreate it from scratch:

```bash
npm run reset-demo
npm start
```

## Database

The database is stored at:

```text
data/rental-manager.sqlite
```

To use another location:

```bash
DB_PATH=/absolute/path/rental.sqlite npm start
```

Back up that SQLite file regularly in production.

## Production deployment

Run behind HTTPS using Nginx/Caddy or a hosting platform that supports persistent disk storage. Example systemd/PM2 environments should set:

```text
PORT=3000
SEED_DEMO=false
DB_PATH=/var/lib/rental-manager/rental.sqlite
```

Because sessions are stored in server memory, restarting the server logs users out but does not affect data.

## Important financial behavior

The system creates a rent charge for each month of an active rental. Payments are allocated against unpaid charges. If a payment is larger than the current outstanding amount, future monthly charges are created and the extra amount is allocated forward. Reversing a payment recalculates affected rent-charge balances while preserving the payment record for audit history.

## PDF receipts/reports

Open a receipt or report and choose **Print / Save PDF** in the browser. This keeps the project dependency-free while still producing clean PDFs on Chrome/Edge/Firefox.

## UI reference

The interface follows the locked design direction from planning: DoorLoop-style application structure, RentRedi-inspired payment clarity, and TenantCloud-inspired room cards, while retaining the compact navy/blue visual language from the original uploaded rental template.
