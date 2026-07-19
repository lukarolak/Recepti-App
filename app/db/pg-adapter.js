const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'recipes',
  password: process.env.DB_PASSWORD || 'recipes',
  database: process.env.DB_NAME || 'recipes',
});

// Shared SQL is written with SQLite-style `?` placeholders; translate to pg's $1, $2, ...
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const result = await pool.query(toPgSql(sql), params);
  return { rows: result.rows };
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: async (sql, params = []) => {
        const result = await client.query(toPgSql(sql), params);
        return { rows: result.rows };
      },
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = { query, transaction, ping };
