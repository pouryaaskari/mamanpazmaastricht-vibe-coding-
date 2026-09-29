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

The existing menu is seeded into SQLite automatically on first server start. Admin edits are available through the dashboard and are returned by the public menu API. Orders and reservations submitted while running through the server are stored in SQLite and appear in the dashboard.

## Production checklist

- Put the source in a private GitHub repository. Commit `.env.example`, never `.env` or `mamanpaz.sqlite`.
- Deploy the Node process to a host with persistent disk. Set `DB_PATH` to that persistent volume and configure `NODE_ENV=production`, `ADMIN_USERNAME`, and a unique long `ADMIN_PASSWORD` as host secrets.
- Put Nginx, Caddy, or a managed HTTPS proxy in front of Node for the custom domain and TLS. Set `TRUST_PROXY=1` only when exactly one trusted proxy sits in front of the app, so production admin cookies are marked secure.
- Back up the SQLite database regularly and test a restore. If the site later needs multiple Node instances, move sessions from memory to a shared store and migrate SQLite to a managed database.
