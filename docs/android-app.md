# Android app

A native Android build of the recipe planner (`android/`, package `com.recepti.app`), built with
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile): the phone runs the same
Express server as the docker-compose deployment, embedded in the app process, serving a
full-screen WebView over `127.0.0.1` only. It works fully offline against its own local
SQLite database, and periodically syncs with a central docker-compose server over home WiFi.

See [docs/android-db-spike.md](android-db-spike.md) for the Phase 0 feasibility spike
(why `node-sqlite3-wasm` was chosen) and its environment/toolchain notes (Android SDK
location, JDK pinning, etc.), still current.

## How it's put together

- **`app/`** is the shared server core: `server.js`, `views/`, `public/`, `db/`. Used
  as-is by both deployments.
- **`app/db/`** is the storage adapter (`pg-adapter.js` for the docker-compose deployment,
  `sqlite-adapter.js` for Android), selected via `DB_DRIVER`. Both expose the same
  `{ query, transaction, ping }` shape so `server.js`'s route logic never needs to know
  which backend it's talking to.
- **`app/sync/centralSync.js`** is Android-only (only `require`d by `server.js` when
  `DB_DRIVER=sqlite`): syncs recipes/ingredients/plan/shopping-checked with the central
  server's `/api/*` JSON endpoints, linking rows via a `central_id` column that only
  exists in the SQLite schema. Recipes and ingredients support full bidirectional
  edit and delete (see "Conflict resolution" below); the weekly plan and
  shopping-checked state keep the simpler v1 models (full overwrite, additive-only).
- **`android/nodejs-project-template/`** is Android-only glue that gets merged on top of
  a copy of `app/` at build time (see `android/app/build.gradle`'s `bundleNodeProject`
  task): `entry-android.js` (sets `DB_DRIVER=sqlite`, `DB_PATH`, `HOST=127.0.0.1` before
  requiring the real `server.js`), an Android-flavored `package.json` (no `pg`), and a
  no-op `public/sync.js` replacing the browser's offline-sync engine (unnecessary here
  since the embedded server never actually goes down while the app is foregrounded).
- **`MainActivity.java`** starts the embedded Node process on a background thread, polls
  `/api/ping` until it responds, then loads the WebView.

## Conflict resolution (recipes/ingredients)

Editing and deleting recipes/ingredients works the same on the phone as in the browser
app; a sync cycle now has to reconcile edits/deletes made independently on both sides
while offline from each other:

- **Edits: last-write-wins.** Every insert/update to `recipes`/`ingredients` sets
  `updated_at` explicitly (`new Date().toISOString()` in `server.js`, never a SQL
  default), so it's a plain ISO 8601 UTC string on both the pg and sqlite adapters and
  directly string-comparable. Each sync cycle fetches a fresh snapshot from central and
  compares timestamps per row: whichever side's `updated_at` is newer wins and
  overwrites the other. `PUT /api/recipes/:id` and `PUT /api/ingredients/:id` are the
  JSON endpoints the phone's push step calls; they exist alongside the pre-existing
  `POST` (create) endpoints.
- **Deletes are terminal**, not subject to the timestamp comparison above -- whichever
  side deleted a row wins outright, even over a newer concurrent edit. `DELETE
  /api/recipes/:id` and `DELETE /api/ingredients/:id` on the central server both delete
  the row and record a tombstone (`deleted_recipes`/`deleted_ingredients` tables in
  `db/init.sql`), which `GET /api/recipes|ingredients/deletions` exposes so the phone
  can tell "deleted centrally" apart from "haven't pulled this one yet". A local delete
  of an already-linked row can't push immediately (the local row is already gone by the
  time sync runs), so it's queued in `pending_recipe_deletes`/`pending_ingredient_deletes`
  (SQLite-only tables) and retried each cycle until the central `DELETE` succeeds.
- Existing central deployments need the migration in
  `db/migrations/001_edit_delete_sync.sql` applied once (adds `updated_at` and the two
  tombstone tables); fresh installs get it for free from `db/init.sql`.

## Known limitations (accepted for v1)

- **Cleartext HTTP is allowed broadly** (`network_security_config.xml`), not scoped to
  specific hosts, since the central server's home-LAN IP is user-configured and can't be
  known ahead of time. Acceptable since this is a personal, sideloaded app, never
  distributed via Play Store, and the docker-compose deployment has no TLS setup anyway.
- **Home WiFi only.** The central server is only reachable while the phone is on the
  same LAN. Syncing from outside the house would need a VPN (e.g. Tailscale) in front of
  the central server, not set up, out of scope for now.
- **Foreground-only.** The embedded server stops when the app isn't open; no Android
  foreground service. Fine for a personal app used interactively.
