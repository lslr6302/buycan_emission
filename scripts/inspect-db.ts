/**
 * Prints the real TigerData schema so COLUMNS in tiger-repository.ts can be
 * mapped to it instead of guessed at.
 *
 *   npx tsx scripts/inspect-db.ts
 */
import { Pool } from 'pg';

try {
  process.loadEnvFile();
} catch {
  /* rely on the real environment */
}

const url = process.env.TIGER_URL ?? process.env.TIMESCALE_SERVICE_URL;
if (!url) {
  console.error('No TIGER_URL / TIMESCALE_SERVICE_URL found. Is .env present?');
  process.exit(1);
}

const parsed = new URL(url);
const sslmode = parsed.searchParams.get('sslmode');
parsed.searchParams.delete('sslmode');

const pool = new Pool({
  connectionString: parsed.toString(),
  ssl: sslmode && sslmode !== 'disable' ? { rejectUnauthorized: true } : undefined,
});

async function main(): Promise<void> {
  const version = await pool.query('select version()');
  console.log(String(version.rows[0].version).split(',')[0]);

  const extensions = await pool.query(
    `select extname from pg_extension where extname in ('vector','vectorscale','pg_trgm','timescaledb') order by extname`,
  );
  console.log('extensions:', extensions.rows.map((r) => r.extname).join(', ') || '(none relevant)');

  const tables = await pool.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog','information_schema','_timescaledb_internal',
                                 '_timescaledb_catalog','_timescaledb_config','_timescaledb_cache')
      order by table_schema, table_name`,
  );

  if (tables.rows.length === 0) {
    console.log('\nNo user tables. The database is empty.');
    return;
  }

  console.log(`\n${tables.rows.length} table(s):\n`);

  for (const { table_schema, table_name } of tables.rows) {
    const cols = await pool.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = $1 and table_name = $2
        order by ordinal_position`,
      [table_schema, table_name],
    );
    let count = '?';
    try {
      const c = await pool.query(`select count(*)::int as n from "${table_schema}"."${table_name}"`);
      count = String(c.rows[0].n);
    } catch {
      /* permissions */
    }

    console.log(`── ${table_schema}.${table_name}  (${count} rows)`);
    for (const c of cols.rows) {
      console.log(
        `     ${String(c.column_name).padEnd(28)} ${String(c.data_type).padEnd(28)}${
          c.is_nullable === 'NO' ? 'NOT NULL' : ''
        }`,
      );
    }

    if (count !== '0' && count !== '?') {
      const sample = await pool.query(
        `select * from "${table_schema}"."${table_name}" limit 2`,
      );
      for (const row of sample.rows) {
        const preview = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}…` : v,
          ]),
        );
        console.log('     sample:', JSON.stringify(preview).slice(0, 400));
      }
    }
    console.log();
  }
}

main()
  .catch((error) => {
    console.error('\nConnection or query failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
