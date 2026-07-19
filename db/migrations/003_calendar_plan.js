// One-off migration for existing central deployments: meal_plan and shopping_checked
// move from a single evergreen day-of-week template to actual calendar-dated rows (see
// server.js's week-planning routes). Needs JS (not plain SQL) since it has to compute
// "this week's actual dates" at the moment it runs. Fresh installs don't need this --
// they get the new schema directly from db/init.sql.
//
// Run once, from the host machine (against the docker-compose-mapped port):
//   DB_HOST=localhost node db/migrations/003_calendar_plan.js
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'recipes',
  password: process.env.DB_PASSWORD || 'recipes',
  database: process.env.DB_NAME || 'recipes',
});

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function getMondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - getDayIndex(date));
  return d;
}

async function main() {
  const existing = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'meal_plan'
  `);
  const hasOldSchema = existing.rows.some((r) => r.column_name === 'day_of_week');
  if (!hasOldSchema) {
    console.log('meal_plan already uses the new schema -- nothing to migrate.');
    await pool.end();
    return;
  }

  const monday = getMondayOf(new Date());
  const dateForDay = {};
  DAYS.forEach((day, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dateForDay[day] = toDateKey(d);
  });
  console.log('Mapping existing day-of-week plan onto the week of', dateForDay.Monday);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meal_plan_new (
      plan_date TEXT PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_checked_new (
      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      plan_date TEXT NOT NULL,
      PRIMARY KEY (ingredient_id, recipe_id, plan_date)
    );
  `);

  const oldPlan = await pool.query('SELECT day_of_week, recipe_id FROM meal_plan WHERE recipe_id IS NOT NULL');
  for (const row of oldPlan.rows) {
    const date = dateForDay[row.day_of_week];
    if (!date) continue;
    await pool.query(
      `INSERT INTO meal_plan_new (plan_date, recipe_id) VALUES ($1, $2)
       ON CONFLICT (plan_date) DO UPDATE SET recipe_id = excluded.recipe_id`,
      [date, row.recipe_id]
    );
    console.log(`  ${row.day_of_week} -> ${date}: recipe ${row.recipe_id}`);
  }

  const oldChecked = await pool.query('SELECT ingredient_id, recipe_id, day_of_week FROM shopping_checked');
  for (const row of oldChecked.rows) {
    const date = dateForDay[row.day_of_week];
    if (!date) continue;
    await pool.query(
      'INSERT INTO shopping_checked_new (ingredient_id, recipe_id, plan_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [row.ingredient_id, row.recipe_id, date]
    );
  }

  await pool.query('DROP TABLE meal_plan');
  await pool.query('ALTER TABLE meal_plan_new RENAME TO meal_plan');
  await pool.query('DROP TABLE shopping_checked');
  await pool.query('ALTER TABLE shopping_checked_new RENAME TO shopping_checked');

  console.log('Migration complete.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
