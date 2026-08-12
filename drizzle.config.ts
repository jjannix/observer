import { defineConfig } from "drizzle-kit";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  schema: fileURLToPath(new URL("./src/server/db/schema.ts", import.meta.url)),
  out: fileURLToPath(new URL("./drizzle", import.meta.url)),
  dialect: "sqlite",
  driver: "better-sqlite3",
  dbCredentials: {
    url: process.env.OBSERVER_DATA_DIR
      ? `${process.env.OBSERVER_DATA_DIR}/observer.sqlite3`
      : ":memory:",
  },
  strict: true,
  verbose: true,
});
