import type { RawDatabase } from "./index.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION_TABLE = "schema_migrations";

/**
 * Minimal, deterministic migration runner.
 *
 * Migrations live as `NNNN_name.sql` files in the `drizzle/` directory next to
 * the project root. Each migration runs in its own transaction. Idempotent:
 * applied migrations are recorded in `schema_migrations`.
 */
export function runMigrations(raw: RawDatabase, migrationsDir?: string): { applied: string[]; schemaVersion: number } {
  const dir = migrationsDir ?? resolveMigrationsDir();
  const files = listMigrations(dir);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = raw.prepare(`SELECT version FROM ${SCHEMA_VERSION_TABLE}`).all() as Array<{ version: number }>;
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const insertStmt = raw.prepare(
    `INSERT INTO ${SCHEMA_VERSION_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  const applied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file.version)) continue;
    const sql = readFileSync(join(dir, file.name), "utf8");
    const tx = raw.transaction(() => {
      raw.exec(sql);
      insertStmt.run(file.version, file.name, new Date().toISOString());
    });
    tx();
    applied.push(file.name);
  }

  const versionRow = raw
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM ${SCHEMA_VERSION_TABLE}`)
    .get() as { v: number };
  return { applied, schemaVersion: versionRow.v };
}

export interface MigrationFile {
  version: number;
  name: string;
}

function resolveMigrationsDir(): string {
  // Works both under tsx (src/server/db) and compiled (dist/server/db).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "drizzle"),
    join(here, "..", "..", "drizzle"),
    join(process.cwd(), "drizzle"),
  ];
  for (const c of candidates) {
    try {
      if (readdirSync(c).some((f) => f.endsWith(".sql"))) return c;
    } catch {
      // try next
    }
  }
  return join(process.cwd(), "drizzle");
}

function listMigrations(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  } catch {
    entries = [];
  }
  return entries
    .map((name) => ({ version: Number(name.slice(0, 4)), name }))
    .sort((a, b) => a.version - b.version);
}
