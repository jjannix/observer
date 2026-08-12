import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";
import { runMigrations } from "./migrate.js";

export type Db = BetterSQLite3Database<typeof schema>;
export type RawDatabase = Database.Database;

export interface OpenOptions {
  dbPath: string;
  /** Run migrations on open. Default true. */
  migrate?: boolean;
  /** Read-only mode (does not migrate). */
  readonly?: boolean;
}

export function openDatabase(opts: OpenOptions): { db: Db; raw: RawDatabase } {
  if (!opts.readonly) {
    const dir = dirname(opts.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const raw = new Database(opts.dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.readonly ?? false,
  });
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("temp_store = MEMORY");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });

  if ((opts.migrate ?? true) && !opts.readonly) {
    runMigrations(raw);
  }

  return { db, raw };
}
