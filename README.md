# Recipe Planner

A barebones app for keeping a list of favorite recipes and picking one for each day of the week.

## Stack
- **web**: Node.js + Express, server-rendered HTML (EJS templates), no build step, no frontend framework.
- **db**: PostgreSQL, schema and starter data loaded automatically from `db/init.sql` the first time the container starts.

Two containers, wired together with Docker Compose.

## Running it

You need Docker Desktop installed and running. From this folder:

```
docker compose up --build
```

Then open http://localhost:3000 in your browser.

- **Weekly Plan** (`/`) — pick a recipe from the dropdown for each day of the week. Saves immediately.
- **Recipes** (`/recipes`) — view, add, and delete recipes.

To stop it: `Ctrl+C`, then `docker compose down` (add `-v` if you also want to wipe the database).

## Notes
- Recipe data lives in a Docker volume (`db_data`), so it survives container restarts. `docker compose down -v` deletes it.
- `db/init.sql` only runs the *first* time the Postgres container starts with an empty data volume — editing it later won't affect an existing database.
- All config (db user/password/name) is in `docker-compose.yml` for simplicity. Fine for local/personal use; if you ever expose this beyond your own machine, move secrets to an `.env` file instead.
