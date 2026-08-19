import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { CURSOR_EVENT_SCHEMA, validateCursorEventRecord } from "./event.js";
import { buildStopHookScript } from "./hook-script.js";

// Safe installer/uninstaller/diagnostics for the Cursor stop hook.
// Aborts without modification on malformed hooks.json, preserves every
// existing hook group and unknown field, is idempotent, replaces hooks.json
// atomically after writing a backup, and keeps the hook fail-open.

export const OBSERVER_STOP_SCRIPT_NAME = "observer-stop.cjs";
export const OBSERVER_STOP_TIMEOUT_SECONDS = 5;

/** Marker included in the installed command so the entry is identifiable. */
const COMMAND_MARKER = OBSERVER_STOP_SCRIPT_NAME;

export interface CursorHookPaths {
  /** ~/.cursor/hooks.json (or a test-provided path). */
  hooksJsonPath: string;
  /** ~/.cursor/hooks/observer-stop.cjs (or a test-provided path). */
  scriptPath: string;
}

export function defaultCursorHookPaths(): CursorHookPaths {
  const cursorDir = process.env.CURSOR_DIR ?? join(homedir(), ".cursor");
  return {
    hooksJsonPath: join(cursorDir, "hooks.json"),
    scriptPath: join(cursorDir, "hooks", OBSERVER_STOP_SCRIPT_NAME),
  };
}

function parseHooksJson(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isObserverEntry(entry: unknown, scriptPath: string): boolean {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const command = (entry as Record<string, unknown>).command;
  if (typeof command !== "string") return false;
  return command.includes(scriptPath) || command.includes(COMMAND_MARKER);
}

function quotePath(p: string): string {
  return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/**
 * Stable absolute Node executable. `process.execPath` can point at an
 * ephemeral version-manager shim (fnm multishell, nvm symlink); resolve
 * through symlinks so the hook keeps working after that shell is gone.
 */
function stableNodePath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export interface InstallResult {
  status: "installed" | "already-installed" | "aborted-malformed-hooks-json";
  hooksJsonPath: string;
  scriptPath: string;
  backupPath: string | null;
  command: string;
}

export function installStopHook(args: {
  paths?: CursorHookPaths;
  spoolRoot: string;
  nodePath?: string;
}): InstallResult {
  const paths = args.paths ?? defaultCursorHookPaths();
  const nodePath = args.nodePath ?? stableNodePath();
  const command = `${quotePath(nodePath)} ${quotePath(paths.scriptPath)}`;

  const existed = existsSync(paths.hooksJsonPath);
  const config: Record<string, unknown> = existed ? parseHooksJson(paths.hooksJsonPath) ?? ((): never => {
    throw new Error(
      `refusing to install: ${paths.hooksJsonPath} exists but is not a valid JSON object`,
    );
  })() : { version: 1 };

  const hooks = ((): Record<string, unknown> => {
    const existing = config.hooks;
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      config.hooks = created;
      return created;
    }
    if (existing == null || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("refusing to install: hooks.json \"hooks\" field is not an object");
    }
    return existing as Record<string, unknown>;
  })();

  const stop = ((): unknown[] => {
    const existing = hooks.stop;
    if (existing === undefined) {
      const created: unknown[] = [];
      hooks.stop = created;
      return created;
    }
    if (!Array.isArray(existing)) {
      throw new Error("refusing to install: hooks.json \"hooks.stop\" field is not an array");
    }
    return existing;
  })();

  const observerEntries = stop.filter((entry) => isObserverEntry(entry, paths.scriptPath));
  if (observerEntries.length === 1) {
    return {
      status: "already-installed",
      hooksJsonPath: paths.hooksJsonPath,
      scriptPath: paths.scriptPath,
      backupPath: null,
      command: (observerEntries[0] as { command: string }).command,
    };
  }
  // Zero entries, or duplicates from a previous partial state: normalize to
  // exactly one by removing all matching entries first.
  const remaining = stop.filter((entry) => !isObserverEntry(entry, paths.scriptPath));
  remaining.push({ command, timeout: OBSERVER_STOP_TIMEOUT_SECONDS });
  hooks.stop = remaining;

  // Deploy the script (stable path, deterministic content for checksums).
  mkdirSync(dirname(paths.scriptPath), { recursive: true });
  const script = buildStopHookScript(args.spoolRoot);
  const tmpScript = `${paths.scriptPath}.tmp-${process.pid}`;
  writeFileSync(tmpScript, script, "utf8");
  renameSync(tmpScript, paths.scriptPath);

  // Backup + atomic replace of hooks.json.
  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${paths.hooksJsonPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      copyFileSync(paths.hooksJsonPath, backupPath);
    } catch {
      backupPath = null;
    }
  }
  const tmpConfig = `${paths.hooksJsonPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpConfig, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmpConfig, paths.hooksJsonPath);

  return { status: "installed", hooksJsonPath: paths.hooksJsonPath, scriptPath: paths.scriptPath, backupPath, command };
}

export interface UninstallResult {
  status: "uninstalled" | "not-installed" | "aborted-malformed-hooks-json";
  removedCommand: string | null;
  removedScript: boolean;
}

export function uninstallStopHook(args: { paths?: CursorHookPaths }): UninstallResult {
  const paths = args.paths ?? defaultCursorHookPaths();

  let removedCommand: string | null = null;
  let removedScript = false;

  if (existsSync(paths.hooksJsonPath)) {
    const config = parseHooksJson(paths.hooksJsonPath);
    if (!config) {
      return { status: "aborted-malformed-hooks-json", removedCommand: null, removedScript: false };
    }
    const hooks = config.hooks;
    if (hooks != null && typeof hooks === "object" && !Array.isArray(hooks)) {
      const stop = (hooks as Record<string, unknown>).stop;
      if (Array.isArray(stop)) {
        const kept = stop.filter((entry) => {
          if (!isObserverEntry(entry, paths.scriptPath)) return true;
          if (removedCommand === null) {
            removedCommand = (entry as { command?: unknown }).command as string ?? null;
          }
          return false;
        });
        if (kept.length === 0) delete (hooks as Record<string, unknown>).stop;
        else (hooks as Record<string, unknown>).stop = kept;
        if (Object.keys(hooks as Record<string, unknown>).length === 0) delete config.hooks;
        const tmp = `${paths.hooksJsonPath}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
        renameSync(tmp, paths.hooksJsonPath);
      }
    }
  }

  if (existsSync(paths.scriptPath)) {
    try {
      rmSync(paths.scriptPath);
      removedScript = true;
    } catch {
      /* leave the config consistent even if the script file resists */
    }
  }

  if (!removedCommand && !removedScript) return { status: "not-installed", removedCommand: null, removedScript: false };
  return { status: "uninstalled", removedCommand, removedScript };
}

/* --------------------------------- doctor --------------------------------- */

export interface DoctorReport {
  cursorVersion: string | null;
  hooksJson: { exists: boolean; parses: boolean; path: string };
  observerEntry: { count: number; expected: boolean };
  script: { exists: boolean; checksumMatches: boolean; path: string };
  spool: { path: string; writable: boolean };
  lastEvent: {
    file: string | null;
    receivedAt: string | null;
    tokenFields: string[];
    warnings: string[];
  } | null;
  warnings: string[];
}

/** Best-effort detection of the installed Cursor version. */
function detectCursorVersion(): string | null {
  const localApp = process.env.LOCALAPPDATA;
  const candidates: string[] = [];
  if (localApp) candidates.push(join(localApp, "Programs", "cursor", "resources", "app", "package.json"));
  candidates.push("/Applications/Cursor.app/Contents/Resources/app/package.json");
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try next */
    }
  }
  return null;
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Find the newest spooled live event file (lexicographic date/name order). */
function newestSpoolEvent(spoolRoot: string): string | null {
  const liveDir = join(spoolRoot, "live");
  if (!existsSync(liveDir)) return null;
  let newest: string | null = null;
  const days = readdirSync(liveDir).sort();
  for (const day of days.slice(-2)) {
    const dir = join(liveDir, day);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
      for (const f of files.slice(-1)) newest = join(dir, f);
    } catch {
      /* skip unreadable day */
    }
  }
  return newest;
}

function analyzeLastEvent(path: string | null): DoctorReport["lastEvent"] {
  if (!path) return null;
  let line: string;
  try {
    line = readFileSync(path, "utf8").trim();
  } catch {
    return { file: path, receivedAt: null, tokenFields: [], warnings: ["spool-event-unreadable"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { file: path, receivedAt: null, tokenFields: [], warnings: ["spool-event-malformed-json"] };
  }
  const validation = validateCursorEventRecord(parsed);
  if (!validation.ok) {
    return { file: path, receivedAt: null, tokenFields: [], warnings: [`spool-event-${validation.reason}`] };
  }
  const event = validation.event;
  const tokenFields = (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const)
    .filter((f) => event[f] != null);
  const warnings: string[] = [];
  if (tokenFields.length === 0) {
    warnings.push("cursor-token-fields-missing (Cmd+K-style event carries no accounting)");
  }
  if (event.schema !== CURSOR_EVENT_SCHEMA) warnings.push("schema-drift");
  return { file: path, receivedAt: event.receivedAt, tokenFields, warnings };
}

export function cursorDoctor(args: { paths?: CursorHookPaths; spoolRoot: string }): DoctorReport {
  const paths = args.paths ?? defaultCursorHookPaths();
  const warnings: string[] = [];

  const hooksJsonExists = existsSync(paths.hooksJsonPath);
  const parsed = hooksJsonExists ? parseHooksJson(paths.hooksJsonPath) : null;
  if (hooksJsonExists && !parsed) warnings.push("hooks.json does not parse as a JSON object");

  let observerCount = 0;
  if (parsed) {
    const hooks = parsed.hooks;
    if (hooks != null && typeof hooks === "object" && !Array.isArray(hooks)) {
      const stop = (hooks as Record<string, unknown>).stop;
      if (Array.isArray(stop)) {
        observerCount = stop.filter((entry) => isObserverEntry(entry, paths.scriptPath)).length;
      }
    }
  }
  if (observerCount === 0) warnings.push("Observer stop hook is not installed");
  if (observerCount > 1) warnings.push("Observer stop hook is installed more than once");

  const scriptExists = existsSync(paths.scriptPath);
  const checksumMatches = scriptExists
    ? sha256File(paths.scriptPath) === createHash("sha256").update(buildStopHookScript(args.spoolRoot)).digest("hex")
    : false;
  if (!scriptExists) warnings.push("stop-hook script is missing");
  else if (!checksumMatches) warnings.push("stop-hook script checksum differs from the current adapter (re-run install-hook)");

  let writable = false;
  try {
    mkdirSync(join(args.spoolRoot, "live"), { recursive: true });
    const probe = join(args.spoolRoot, ".doctor-probe");
    writeFileSync(probe, "", "utf8");
    rmSync(probe);
    writable = true;
  } catch {
    warnings.push("spool directory is not writable");
  }

  const lastEvent = analyzeLastEvent(writable ? newestSpoolEvent(args.spoolRoot) : null);
  if (lastEvent) warnings.push(...lastEvent.warnings);

  return {
    cursorVersion: detectCursorVersion(),
    hooksJson: { exists: hooksJsonExists, parses: parsed != null || !hooksJsonExists, path: paths.hooksJsonPath },
    observerEntry: { count: observerCount, expected: observerCount === 1 },
    script: { exists: scriptExists, checksumMatches, path: paths.scriptPath },
    spool: { path: args.spoolRoot, writable },
    lastEvent,
    warnings,
  };
}
