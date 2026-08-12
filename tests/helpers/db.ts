import { openDatabase, type RawDatabase } from "../../src/server/db/index.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import type { RawDatabase as Raw } from "../../src/server/db/index.js";

export function makeDb(): { raw: Raw; close: () => void } {
  const { raw } = openDatabase({ dbPath: ":memory:", migrate: false });
  runMigrations(raw);
  return { raw, close: () => raw.close() };
}

export type { RawDatabase };
