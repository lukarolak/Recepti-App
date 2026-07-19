# Recipe Planner

A barebones app for keeping a list of favorite recipes and picking one for each day of the week. The actual UI is the [Android app](docs/android-app.md) (`android/`) — this repo's `docker-compose` deployment is a headless JSON sync backend for it, not something you browse to directly.

## Stack
- **web**: Node.js + Express, a pure `/api/*` JSON backend, no server-rendered pages, no frontend framework. The Android app's `centralSync.js` syncs recipes/ingredients/plan/shopping state against it.
- **db**: PostgreSQL, schema and starter data loaded automatically from `db/init.sql` the first time the container starts.

Two containers, wired together with Docker Compose.

## Running it

You need Docker Desktop installed and running. From this folder:

```
docker compose up --build
```

This starts the sync backend at `http://localhost:3000` (or whatever host/port you point the Android app's collaboration address at — see [docs/android-app.md](docs/android-app.md)). `GET /api/ping` is a quick way to confirm it's up; there's no browsable UI.

To stop it: `Ctrl+C`, then `docker compose down` (add `-v` if you also want to wipe the database).

## Notes
- Recipe data lives in a Docker volume (`db_data`), so it survives container restarts. `docker compose down -v` deletes it.
- `db/init.sql` only runs the *first* time the Postgres container starts with an empty data volume — editing it later won't affect an existing database.
- All config (db user/password/name) is in `docker-compose.yml` for simplicity. Fine for local/personal use; if you ever expose this beyond your own machine, move secrets to an `.env` file instead.
