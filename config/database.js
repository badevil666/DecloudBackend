// Neon (PostgreSQL) database configuration using `pg`
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.warn(
    '[database] DATABASE_URL is not set. Neon connection will fail until this is configured.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Neon uses SSL, connection string usually has sslmode=require
  },
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Helper to run queries easily:
 *   const { rows } = await query('SELECT now()');
 */
const query = (text, params) => pool.query(text, params);

module.exports = {
  pool,
  query,
};
