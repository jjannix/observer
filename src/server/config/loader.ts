import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { observerConfigSchema, type ObserverConfig, defaultConfig } from "./schema.js";

/**
 * Atomic, validated config persistence.
 *
 * - On load: missing file -> default config (which is then persisted).
 * - On load: corrupt/invalid file -> backup it, fall back to default, surface error.
 * - On save: validate, write to temp, rename atomically; never write a partial file.
 */
export interface LoadResult {
  config: ObserverConfig;
  created: boolean;
  recoveredFrom?: string;
}

export function loadConfig(configPath: string): LoadResult {
  if (!existsSync(configPath)) {
    const cfg = defaultConfig();
    saveConfig(configPath, cfg);
    return { config: cfg, created: true };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const cfg = defaultConfig();
    saveConfig(configPath, cfg);
    return { config: cfg, created: false, recoveredFrom: `read-error: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = backupFile(configPath);
    const cfg = defaultConfig();
    saveConfig(configPath, cfg);
    return { config: cfg, created: false, recoveredFrom: `invalid-json@${backup}` };
  }

  const result = observerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const backup = backupFile(configPath);
    const cfg = defaultConfig();
    saveConfig(configPath, cfg);
    return {
      config: cfg,
      created: false,
      recoveredFrom: `schema-validation-failed@${backup}`,
    };
  }

  return { config: result.data, created: false };
}

export function saveConfig(configPath: string, config: ObserverConfig): void {
  // Validate before touching disk.
  const validated = observerConfigSchema.parse(config);
  const dir = dirname(configPath);
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(validated, null, 2) + "\n";
  writeFileSync(tmp, data, "utf8");
  // Atomic rename on same volume.
  renameSync(tmp, configPath);
}

function backupFile(configPath: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${configPath}.${ts}.bak`;
  try {
    copyFileSync(configPath, backup);
  } catch {
    // best-effort
  }
  return backup;
}

export function configMtime(configPath: string): number {
  try {
    return statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

export { join };
