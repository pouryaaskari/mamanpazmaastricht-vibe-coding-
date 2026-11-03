# MamanPaz Maastricht

## Run the website and staff dashboard

This project now uses a small Express + SQLite backend for staff authentication, menu management, delivery availability, orders, and reservations.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file beside `server.js` by copying `.env.example`, then replace the placeholder values. Do not commit the real password:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env`:

   ```env
   ADMIN_USERNAME=your-staff-email@example.com
   ADMIN_PASSWORD=use-a-long-random-password
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open the public site at `http://localhost:3000/`.
5. Open the staff login at `http://localhost:3000/admin/login`.

The first server start creates the staff account with a salted `scrypt` password hash in `mamanpaz.sqlite`. Sessions are held server-side and represented by an HTTP-only cookie. The SQLite database and real credentials should never be committed. The server exposes only public pages and assets, not `mamanpaz.sqlite`, `.env`, or server source files.

The menu and checkout share a validated browser cart model. Normal collection uses `ORDER_COLLECTION_PREP_MINUTES` (default 30); delivery slots are at least 30 minutes ahead. Both use the restaurant's `Europe/Amsterdam` timezone and configured opening hours. Menu items with selected available weekdays appear on the public menu only on those weekdays; changing a dish's weekdays in Menu Management updates its public schedule, and leaving all weekdays unchecked makes an item available daily. The staff dashboard shows whether each item's schedule matches today. The weekly dishes are Khoresh Fesenjoon on Wednesday, Adas Polo on Thursday, Baghali Polo ba Gosht on Friday, Loobia Polo on Saturday, and Zereshk Polo ba Morgh on Sunday. Checkout provides a calendar and available time slots for the next 21 days; only days when ordering is open are offered, and selecting a closed day displays a notice. Scheduled dishes are checked against the selected order date by both checkout and the server. The server rechecks the selected date and time when an order is submitted. Changes to opening hours in the staff dashboard immediately change the available dates and times on the next availability check. Customers can schedule pickup or delivery while the restaurant is currently closed; ASAP ordering is available only while ordering is open. Reservations can also be requested for upcoming days when reservations are open.

The existing menu is seeded into SQLite automatically on first server start. Admin edits are available through the dashboard and are returned by the public menu API. Orders and reservations submitted while running through the server are stored in SQLite and appear in the dashboard. The staff dashboard opens on Orders, offers one Notification Settings panel for sound and browser alerts, and highlights unresolved email-delivery issues. First-time/returning customer labels use normalized phone numbers and names; an address alone never identifies two people as the same customer.

## Safely test ordering while the restaurant is closed

Test mode is disabled by default. The server ignores `ORDER_TEST_MODE=true` whenever `NODE_ENV=production`. To keep test orders out of your normal local database, start a separate development server with a separate SQLite file:

```bash
ORDER_TEST_MODE=true ORDER_TEST_DB_PATH=./mamanpaz-test.sqlite npm start
```

On Windows PowerShell, use:

```powershell
$env:ORDER_TEST_MODE="true"; $env:ORDER_TEST_DB_PATH="./mamanpaz-test.sqlite"; npm start
```

Restart the Node server after changing environment variables. In test mode, the server listens only on your computer at `http://127.0.0.1:3000/checkout.html`; the amber **TEST MODE** notice confirms the backend enabled it. The time list offers future 15-minute slots while ignoring restaurant opening hours and closed weekdays. Delivery retains its 30-minute lead time and €20 food minimum. Collection defaults to a 15-minute test preparation lead; set `ORDER_TEST_COLLECTION_LEAD_MINUTES` to a value from 0 to 180 to adjust that local test lead time. Test mode writes only to `ORDER_TEST_DB_PATH`, which defaults to a separate `*-test.sqlite` file beside `DB_PATH`; the server refuses to start test mode if both paths are the same. Production ignores both test-mode settings.

Always open the site through the Node server, not VS Code Live Server. If startup reports that port 3000 is already in use, return to the terminal running the older server and press Ctrl+C once, then run the command again. Only one server can listen on a port, and the browser will keep receiving pages from the old process until it is stopped.

Add a delivery item total of at least €20, choose Delivery, complete the street, house number, postal code, city and country, and submit. For collection, choose Takeaway; an address is not required and the delivery minimum does not apply. Test mode saves test-marked orders in the test database and records the order email notifications that would have been sent in its `test_notification_log`; it does not queue test order emails, pauses SMTP delivery while enabled, and skips the external delivery-distance lookup. Sign in at `/admin.html` using the staff account in your environment to review the clearly marked **TEST ORDER** records and change their status. Test status updates are recorded in the test notification log instead of sending email.

To restore normal behavior, stop the server with Ctrl+C and start it normally (`npm start`) without `ORDER_TEST_MODE=true`. Do not set the flag in production. The test database can be removed after you finish, once you are sure you do not need its test records.

## Production deployment

This app needs a long-running Node.js service and persistent writable storage. Use Node.js 22 LTS (the SQLite dependency includes a native component), install with `npm ci`, and start with `npm start`. The hosting platform must supply its assigned `PORT`, route HTTPS requests to the Node service, and provide one persistent volume mounted at a stable path. Keep the database and uploaded menu images on that volume, outside the public repository directory.

For a Render Web Service, attach a persistent disk mounted at `/var/data` and set these values in the service's **Environment** settings:

```text
NODE_ENV=production
DB_PATH=/var/data/mamanpaz.sqlite
UPLOAD_DIR=/var/data/uploads
ORDER_TEST_MODE=false
```

Keep the service to one instance: SQLite and staff sessions are local to that instance, and Render disks are not shared across instances. The app creates the database parent and upload directories if needed, checks that they are readable and writable, and stops startup with the affected path in the error if it cannot access them. On the first start with an empty disk, it initializes the schema and menu and creates the initial staff account. It opens an existing database without replacing it; changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` will not reset an existing staff account. The deployment does not copy the development database or its customer/order records to Render. Transfer records only as a separately planned, backed-up operation.

Set these environment variable names in the hosting provider (values belong in its secret/configuration UI, never in source control):

- Required: `NODE_ENV=production`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `RESTAURANT_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `MAIL_FROM`, `DB_PATH`, and `UPLOAD_DIR`.
- Set `TRUST_PROXY=1` only when the app can be reached exclusively through exactly one trusted reverse proxy. Otherwise omit it or set `0`. The proxy must terminate HTTPS and set forwarded headers.
- Set `ORDER_TEST_MODE=false` or omit it. Production forcibly ignores test mode even if it is accidentally set to `true`. Do not set `ORDER_TEST_DB_PATH` in production.
- Optional: `ORDER_COLLECTION_PREP_MINUTES` (default 30; accepted range 0–180). The test-only `ORDER_TEST_COLLECTION_LEAD_MINUTES` is not needed in production.
- `PORT` is normally provided by the host. Do not hardcode it if the platform assigns one.

Use `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=465` for the implemented implicit-TLS Gmail transport. Set `SMTP_USER` and `MAIL_FROM` to the authenticated Gmail account (or a Gmail-approved sender alias), and set `RESTAURANT_EMAIL` to the staff inbox. Order submission sends a staff notification and, when the customer provided an email, a receipt/request update. Reservation submission sends staff and customer request messages; staff confirmation sends the customer a confirmation with a calendar invite. Event inquiries send staff and customer acknowledgments. The durable SQLite outbox retries failed deliveries. A “configured” status only means the SMTP username and app password are present; it does not prove Gmail accepts them or the host permits outbound port 465.

Delivery eligibility is based on an approved postcode list stored in the `restaurant_settings` table in SQLite. On first startup, including an upgrade with an absent or empty list, the app initializes default Netherlands four-digit postcode prefixes and Belgian postcodes whose GeoNames representative locations are within 10 km of Clavecymbelstraat 8, Maastricht (6217 CT). The list is based on GeoNames' public Netherlands and Belgium postcode files (`https://download.geonames.org/export/zip/NL.zip` and `https://download.geonames.org/export/zip/BE.zip`). This is an approximate service area, not an exact 10 km boundary: every address in an approved Dutch four-digit area is eligible, even if an individual address is farther away. Manage the list in the staff dashboard under **Delivery Availability**; remove areas you do not serve or add more as needed. A four-digit Netherlands entry approves all postcodes beginning with those digits; a full postcode such as `6217 AB` approves only that postcode. Belgium postcodes use four digits. Existing non-empty saved lists are preserved. The server checks the country and postcode for every delivery order, including direct API requests. Checkout checks postcode eligibility through this application, and no customer address or postcode is sent to an external service. Takeaway ordering does not use or depend on the approved list. Delivery remains subject to the existing €20 food minimum, €3 fee, and delivery open/closed setting.

On first startup with an empty production database, the app creates its schema, runs built-in schema upgrades, seeds the menu from the project files, and creates the initial admin account from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Existing staff accounts are not reset when those variables change. To rotate an existing password, back up the database, run `npm run staff:password` in an interactive terminal with the production `DB_PATH` configured, enter the account name and new password at the hidden prompt, then restart the app to invalidate existing sessions. The password must have at least 16 characters.

### Preparing a clean production database

The current local `mamanpaz.sqlite` can contain useful restaurant configuration mixed with local history. To prepare a separate clean database, run:

```sh
npm run db:prepare-production
```

The command reads `mamanpaz.sqlite` in read-only mode and refuses to replace an existing output. It initializes a staging database by starting the application in isolated local test mode so its normal schema and migration code run, then copies only the menu configuration and opening-hours setting. It sets Baghali Polo ba Gosht to Friday and enables delivery. The generated `mamanpaz-production.sqlite` is separate from the local database and is ignored by Git. It contains no staff account, orders, reservations, event inquiries, email history, test history, or approved delivery postcodes. Add the postcodes served through the staff dashboard after deployment; until then delivery stays unavailable. The `€20` food minimum and `€3` fee remain server rules. Menu image references are retained; this source menu uses project image paths, not uploaded-image paths.

Place the generated file on the Render persistent disk as `/var/data/mamanpaz.sqlite` before the first production start. Set `ADMIN_USERNAME` and a new `ADMIN_PASSWORD` of at least 16 characters in Render's environment settings. The production server creates that new staff account on startup; if the credentials are missing or the password is too short, startup fails. Do not set local `DB_PATH` to the Render path: normal local startup continues to use the local database, and the preparation command does not change environment files or `DB_PATH`.

Deployment sequence:

1. Create a private source repository and deploy the project files; do not commit `.env`, either SQLite database, backups, logs, or `node_modules`. Transfer the prepared production database to the persistent disk separately.
2. Create and mount persistent storage. For Render, use the `/var/data` mount and exact settings above. The app creates its database and upload directories on first startup. Do not point production at this development workspace's `mamanpaz.sqlite`; the local database is not uploaded or copied automatically. Prepare and transfer a clean configuration database as described above, or plan any transfer of records separately after a backup. Never migrate test orders into the live database.
3. Set the required host environment variables above, including a newly rotated staff password and a newly rotated Gmail app password if either was previously shared. Keep test mode off.
4. Deploy with `npm ci` and start with `npm start`. The app initializes or upgrades the schema at startup; there is no separate migration command. Keep a pre-deploy database backup because schema upgrades run automatically.
5. Add the custom domain at the hosting provider, point its DNS records to the provider, enable managed TLS/HTTPS, and verify HTTP redirects to HTTPS. Configure the proxy setting as described above.
6. On the live domain, verify the public pages, staff login, one controlled test email to an address you own, dashboard email status, booking availability, and menu image upload. Do not use a real customer address for this check.

For rollback, stop or maintenance-mode the service, take a copy of the current database and uploads, redeploy the previous application version, and restart. If the previous version cannot read the upgraded database, restore the pre-deploy database backup while the service is stopped; database restore can lose orders created after that backup, so reconcile those records before reopening. Keep periodic encrypted backups and test restore procedures. This app uses in-memory staff sessions and a local SQLite database, so run a single app instance; horizontal scaling needs a shared session store and a database migration.

To rotate a staff password manually, use the command above. To rotate Gmail credentials, create a new Google App Password in the mailbox account, update the hosting secret `SMTP_APP_PASSWORD`, restart, and revoke the old app password in Google Account settings. Never send the credential to the site frontend or include it in support logs.

## Email notifications

Order, reservation, and event emails are written to a durable SQLite outbox after the related record is saved. Configure `SMTP_USER`, `SMTP_APP_PASSWORD`, `SMTP_HOST=smtp.gmail.com`, and `SMTP_PORT=465` in the server's environment. Use a Google App Password for the mailbox (Google Account → Security → turn on 2-Step Verification → App passwords, if the account is eligible). Do not use the mailbox's normal password. Set `MAIL_FROM` to the authenticated Gmail address and `RESTAURANT_EMAIL` to `mamanpazmaastricht@gmail.com`. Restart the server after setting the variables. Unresolved failures appear as dashboard alerts; staff can review the email queue from an alert and retry a message. Email delivery itself requires valid Gmail SMTP credentials and outbound SMTP access from the host.

## Staff tablet installation

Open the deployed HTTPS site at `/admin.html`, sign in, then use the browser's install option when offered. On iPad Safari, use Share → Add to Home Screen. On Android Chrome, use the browser menu → Install app or Add to Home screen. The app-shell service worker caches only the dashboard shell; APIs, customer data, and uploaded photos are never cached. Live orders and requests require an active internet connection. Configure `DB_PATH` and `UPLOAD_DIR` on persistent storage when deploying.
