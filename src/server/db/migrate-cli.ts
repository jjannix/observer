import { openDatabase } from "./index.js";
import { runMigrations } from "./migrate.js";
import { resolvePaths } from "../config/paths.js";

const paths = resolvePaths();
const { raw } = openDatabase({ dbPath: paths.dbPath, migrate: false });
const result = runMigrations(raw);
console.log(`Database : ${paths.dbPath}`);
console.log(`Schema   : version ${result.schemaVersion}`);
if (result.applied.length === 0) {
  console.log("No new migrations.");
} else {
  for (const name of result.applied) console.log(`Applied  : ${name}`);
}
raw.close();
