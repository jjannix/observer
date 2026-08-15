import { AppState } from "../state.js";
import { APP_VERSION } from "@shared/contracts";
import { defaultSourceRoots } from "../config/paths.js";
import { cursorDoctor, defaultCursorHookPaths, installStopHook, uninstallStopHook } from "../collectors/cursor/hooks.js";
import { defaultBackfillArgs, runLegacyBackfill } from "../collectors/cursor/backfill.js";

/** `npm run observer -- <command>` entry point. */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const cursorCmd = process.argv[3];
  const state = new AppState();

  try {
    switch (cmd) {
      case "doctor":
        await doctor(state);
        break;
      case "sync":
        await sync(state);
        break;
      case "rebuild":
        await rebuild(state);
        break;
      case "config":
        console.log(JSON.stringify(state.getConfig(), null, 2));
        break;
      case "cursor":
        await cursorCommand(state, cursorCmd);
        break;
      default:
        console.log(`Observer v${APP_VERSION} CLI`);
        console.log(`Usage: npm run observer -- <command>`);
        console.log(`Commands:`);
        console.log(`  doctor   Check sources, schema, health, and print a summary.`);
        console.log(`  sync     Run one synchronization pass and exit.`);
        console.log(`  rebuild  Clear Observer's index and rescan sources.`);
        console.log(`  config   Print the active configuration as JSON.`);
        console.log(`  cursor <install-hook|uninstall-hook|doctor|backfill>`);
        console.log(`           Manage the Cursor stop hook and legacy SQLite backfill.`);
    }
  } finally {
    state.close();
  }
}

async function cursorCommand(state: AppState, sub: string | undefined): Promise<void> {
  const spoolRoot = defaultSourceRoots().cursorSpool;
  switch (sub) {
    case "install-hook": {
      const result = installStopHook({ spoolRoot });
      console.log(`install-hook: ${result.status}`);
      console.log(`  hooks.json : ${result.hooksJsonPath}`);
      console.log(`  script     : ${result.scriptPath}`);
      console.log(`  command    : ${result.command}`);
      if (result.backupPath) console.log(`  backup     : ${result.backupPath}`);
      console.log(`  spool      : ${spoolRoot}`);
      if (result.status === "already-installed") {
        console.log("  (idempotent: entry already present, nothing changed)");
      }
      break;
    }
    case "uninstall-hook": {
      const result = uninstallStopHook({});
      console.log(`uninstall-hook: ${result.status}`);
      if (result.removedCommand) console.log(`  removed command: ${result.removedCommand}`);
      if (result.removedScript) console.log(`  removed script  : ${defaultCursorHookPaths().scriptPath}`);
      if (result.status === "aborted-malformed-hooks-json") {
        console.log("  hooks.json is malformed — nothing was modified.");
      }
      break;
    }
    case "doctor": {
      const report = cursorDoctor({ spoolRoot });
      console.log("Cursor integration doctor");
      console.log(`  cursor version : ${report.cursorVersion ?? "not detected"}`);
      console.log(`  hooks.json     : ${report.hooksJson.path} (${report.hooksJson.exists ? "exists" : "absent"}, ${report.hooksJson.parses ? "parses" : "MALFORMED"})`);
      console.log(`  observer entry : ${report.observerEntry.count} (expected exactly 1)`);
      console.log(`  stop script    : ${report.script.path} (${report.script.exists ? (report.script.checksumMatches ? "checksum ok" : "CHECKSUM MISMATCH") : "missing"})`);
      console.log(`  spool          : ${report.spool.path} (${report.spool.writable ? "writable" : "NOT WRITABLE"})`);
      if (report.lastEvent) {
        console.log(`  last event     : ${report.lastEvent.file}`);
        console.log(`  received at    : ${report.lastEvent.receivedAt ?? "unknown"}`);
        console.log(`  token fields   : ${report.lastEvent.tokenFields.join(", ") || "NONE"}`);
      } else {
        console.log("  last event     : (none spooled yet)");
      }
      if (report.warnings.length > 0) {
        console.log("  warnings:");
        for (const w of report.warnings) console.log(`    - ${w}`);
      } else {
        console.log("  warnings       : none");
      }
      break;
    }
    case "backfill": {
      const args = defaultBackfillArgs(spoolRoot);
      const summary = runLegacyBackfill(args);
      console.log(`backfill: ${summary.status}`);
      console.log(`  bubbles scanned          : ${summary.bubblesScanned}`);
      console.log(`  positive accounting      : ${summary.positiveBubbles}`);
      console.log(`  unique usage identities  : ${summary.uniqueIdentities}`);
      console.log(`  imported events          : ${summary.imported}`);
      console.log(`  quarantined identities   : ${summary.quarantinedIdentities}`);
      console.log(`  exact timestamps         : ${summary.eventsWithExactTimestamp}`);
      console.log(`  with model attribution   : ${summary.eventsWithModel}`);
      console.log(`  output                   : ${summary.outputFile ?? "-"}`);
      if (summary.imported > 0) {
        console.log("  Run `npm run observer -- sync` to import the events.");
      }
      break;
    }
    default:
      console.log(`Usage: npm run observer -- cursor <install-hook|uninstall-hook|doctor|backfill>`);
      break;
  }
}

async function doctor(state: AppState): Promise<void> {
  console.log(`Observer v${APP_VERSION}`);
  console.log(`Database : ${state.paths.dbPath}`);
  console.log(`Config   : ${state.paths.configPath}`);
  console.log("");
  const sources = state.repo.listSources();
  if (sources.length === 0) {
    console.log("No sources configured.");
    return;
  }
  for (const s of sources as any[]) {
    const present = s.present ? "present" : "MISSING";
    console.log(`[${s.harness}] ${s.label} (${present})`);
    console.log(`  root          : ${s.root}`);
    console.log(`  adapter       : ${s.adapter_version}`);
    console.log(`  files         : ${s.files_present}/${s.files_discovered}`);
    console.log(`  raw records   : ${s.raw_records}`);
    console.log(`  events        : ${s.normalized_events}`);
    console.log(`  quarantined   : ${s.quarantined}`);
    console.log(`  duplicates    : ${s.duplicates}`);
    if (s.last_error) console.log(`  last error    : ${s.last_error}`);
  }
  console.log("");
  console.log(`Warnings : ${state.repo.countWarnings()}`);
}

async function sync(state: AppState): Promise<void> {
  const result = state.engine.trigger("manual");
  console.log(`Sync ${result.status} (run ${result.runId})`);
  await state.engine.join();
  const run = state.repo.getSyncRun(result.runId);
  if (run) {
    console.log(`phase     : ${run.phase}`);
    console.log(`imported  : ${run.imported}`);
    console.log(`duplicates: ${run.duplicates}`);
    console.log(`quarantine: ${run.quarantined}`);
    const errs = JSON.parse(run.errors_json || "[]") as string[];
    if (errs.length > 0) for (const e of errs) console.log(`error     : ${e}`);
  }
}

async function rebuild(state: AppState): Promise<void> {
  console.log("Rebuilding index (Observer storage only; sources untouched)...");
  const result = state.engine.rebuild();
  console.log(`Rebuild ${result.status} (run ${result.runId})`);
  await state.engine.join();
  console.log("Done.");
}

process.env.OBSERVER_CLI = "1";
main().catch((err) => {
  console.error("observer:", (err as Error).message);
  process.exit(1);
});
