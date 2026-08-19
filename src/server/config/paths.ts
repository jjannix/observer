import { homedir, platform } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const isWindows = platform() === "win32";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** %LOCALAPPDATA% equivalent across platforms. */
function localAppData(): string {
  const e = env("LOCALAPPDATA");
  if (e) return e;
  if (isWindows) return join(homedir(), "AppData", "Local");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".local", "share");
}

/** %APPDATA% equivalent across platforms. */
function roamingAppData(): string {
  const e = env("APPDATA");
  if (e) return e;
  if (isWindows) return join(homedir(), "AppData", "Roaming");
  if (platform() === "darwin") return join(homedir(), "Library", "Preferences");
  return join(homedir(), ".config");
}

export interface ResolvedPaths {
  dataDir: string;
  dbPath: string;
  configDir: string;
  configPath: string;
}

export function resolvePaths(): ResolvedPaths {
  const dataDir = env("OBSERVER_DATA_DIR") ?? join(localAppData(), "Observer");
  const configPath = env("OBSERVER_CONFIG_PATH") ?? join(roamingAppData(), "Observer", "config.json");
  const configDir = dirname(configPath);
  const dbPath = join(dataDir, "observer.sqlite3");
  return { dataDir, dbPath, configDir, configPath };
}

export function ensureDirs(paths: ResolvedPaths): void {
  for (const dir of [paths.dataDir, paths.configDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Known default harness source roots. */
export function defaultSourceRoots(): {
  pi: string;
  codexSessions: string;
  codexArchived: string;
  claudeCodeProjects: string;
  opencodeData: string;
  cursorSpool: string;
} {
  const home = homedir();
  const claudeConfigDir = env("CLAUDE_CONFIG_DIR") ?? join(home, ".claude");
  // OpenCode uses XDG-style paths on every platform (verified on Windows).
  const xdgData = env("XDG_DATA_HOME");
  // The Cursor source root is Observer's own sanitized spool — never Cursor's
  // private databases. The stop hook writes sanitized events here; the legacy
  // backfill materializes the same records under backfill/.
  const dataDir = env("OBSERVER_DATA_DIR") ?? join(localAppData(), "Observer");
  return {
    pi: process.env.PI_SESSIONS_ROOT ?? join(home, ".pi", "agent", "sessions"),
    codexSessions: process.env.CODEX_SESSIONS_ROOT ?? join(home, ".codex", "sessions"),
    codexArchived: process.env.CODEX_ARCHIVED_ROOT ?? join(home, ".codex", "archived_sessions"),
    claudeCodeProjects: process.env.CLAUDE_CODE_PROJECTS_ROOT ?? join(claudeConfigDir, "projects"),
    opencodeData: env("OPENCODE_DATA_DIR") ?? (xdgData ? join(xdgData, "opencode") : join(home, ".local", "share", "opencode")),
    cursorSpool: env("CURSOR_OBSERVER_ROOT") ?? join(dataDir, "cursor", "spool"),
  };
}

/**
 * Cursor's per-user directory (VSCode-style layout: globalStorage and
 * workspaceStorage live inside it). %APPDATA% on Windows, Application
 * Support on macOS, XDG config on Linux.
 */
export function cursorUserDir(): string {
  if (isWindows) return join(env("APPDATA") ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Cursor", "User");
  return join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "Cursor", "User");
}

/**
 * Normalize a filesystem path case-insensitively on Windows/macOS and resolve
 * it to an absolute form. Trailing separators are stripped.
 */
export function normalizePath(p: string): string {
  let n = normalize(resolve(p));
  // Strip trailing separators (keep root).
  while (n.length > 3 && (n.endsWith("/") || n.endsWith("\\"))) {
    n = n.slice(0, -1);
  }
  if ((isWindows || platform() === "darwin") && n.length >= 2) {
    // Lowercase drive letter + whole path for case-insensitive identity.
    n = n.toLowerCase();
  }
  return n;
}

export { existsSync, dirname };
