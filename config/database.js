// Neon (PostgreSQL) database configuration using `pg`
const { Pool, types } = require('pg');
require('dotenv').config();

// Parse TIMESTAMP WITHOUT TIME ZONE (OID 1114) as UTC.
// pg's default treats the raw string as local time, which breaks on non-UTC machines.
types.setTypeParser(1114, str => (str ? new Date(str + 'Z') : null));

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
