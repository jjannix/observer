import { AppState } from "../state.js";
import { APP_VERSION } from "@shared/contracts";

/** `npm run observer -- <command>` entry point. */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
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
      default:
        console.log(`Observer v${APP_VERSION} CLI`);
        console.log(`Usage: npm run observer -- <command>`);
        console.log(`Commands:`);
        console.log(`  doctor   Check sources, schema, health, and print a summary.`);
        console.log(`  sync     Run one synchronization pass and exit.`);
        console.log(`  rebuild  Clear Observer's index and rescan sources.`);
        console.log(`  config   Print the active configuration as JSON.`);
    }
  } finally {
    state.close();
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
