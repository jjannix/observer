import type { ObserverConfig } from "./config/schema.js";
import { loadConfig, saveConfig } from "./config/loader.js";
import { resolvePaths, ensureDirs, type ResolvedPaths } from "./config/paths.js";
import { openDatabase, type Db, type RawDatabase } from "./db/index.js";
import { Repository } from "./sync/repository.js";
import { SyncEngine } from "./sync/engine.js";

/**
 * Application-wide state container. Holds the database, config (mutable,
 * atomically persisted), repository, and the sync engine.
 */
export class AppState {
  readonly paths: ResolvedPaths;
  readonly db: Db;
  readonly raw: RawDatabase;
  readonly repo: Repository;
  readonly engine: SyncEngine;
  private config: ObserverConfig;
  private readonly configPath: string;
  private readonly onConfigChanged?: () => void;

  constructor(opts?: { onConfigChanged?: () => void }) {
    this.paths = resolvePaths();
    ensureDirs(this.paths);
    this.onConfigChanged = opts?.onConfigChanged;

    const { db, raw } = openDatabase({ dbPath: this.paths.dbPath });
    this.db = db;
    this.raw = raw;
    this.repo = new Repository(raw);

    const loaded = loadConfig(this.paths.configPath);
    this.config = loaded.config;
    this.configPath = this.paths.configPath;

    this.engine = new SyncEngine(this.repo, () => this.config);
  }

  getConfig(): ObserverConfig {
    return this.config;
  }

  updateConfig(next: ObserverConfig): void {
    saveConfig(this.configPath, next);
    this.config = next;
    // Re-apply sync interval if changed.
    this.engine.startInterval(next.syncIntervalSeconds);
    this.onConfigChanged?.();
  }

  close(): void {
    this.engine.stopInterval();
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
  }
}
