import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./config.mjs";

const migrationsRoot = join(root, "migrations");
const migrationLockKey = 7_214_609_157;

export const runMigrations = async (pool) => {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsRoot))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name))
      .sort((left, right) => Number(left.slice(0, 3)) - Number(right.slice(0, 3)));
    const versions = files.map((name) => name.slice(0, 3));
    if (new Set(versions).size !== versions.length) {
      throw new Error("MIGRATION_VERSION_DUPLICATED");
    }

    for (const name of files) {
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rows[0]) continue;

      const sql = await readFile(join(migrationsRoot, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [name],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]).catch(() => {});
    client.release();
  }
};
