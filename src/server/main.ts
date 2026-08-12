import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppState } from "./state.js";
import { registerApi } from "./api/routes.js";
import { APP_VERSION, DEFAULT_PORT } from "@shared/contracts";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.OBSERVER_PORT ?? DEFAULT_PORT);

export async function createServer(): Promise<{ app: ReturnType<typeof Fastify>; state: AppState }> {
  const state = new AppState();
  const app = Fastify({ logger: { level: process.env.OBSERVER_LOG_LEVEL ?? "info" } });

  registerApi(app, state);

  if (isProd) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "client"), // dist/server/main.js -> dist/client
      join(process.cwd(), "dist", "client"),
      join(process.cwd(), "client"),
    ];
    const root = candidates.find((c) => existsSync(join(c, "index.html")));
    if (root) {
      await app.register(fastifyStatic, { root, prefix: "/" });
      // SPA fallback: non-/api routes serve index.html.
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not-found" });
        return reply.sendFile("index.html");
      });
    }
  }

  return { app, state };
}

async function main(): Promise<void> {
  const { app, state } = await createServer();

  const cfg = state.getConfig();
  // Kick off an initial backfill asynchronously.
  state.engine.trigger("startup");
  state.engine.startInterval(cfg.syncIntervalSeconds);

  process.on("SIGINT", () => {
    void app.close().then(() => {
      state.close();
      process.exit(0);
    });
  });
  process.on("SIGTERM", () => {
    void app.close().then(() => {
      state.close();
      process.exit(0);
    });
  });

  try {
    await app.listen({ host: "127.0.0.1", port });
    app.log.info(`Observer v${APP_VERSION} listening on http://127.0.0.1:${port}`);
  } catch (err) {
    app.log.error((err as Error).message);
    process.exit(1);
  }
}

const invokedDirectly = process.env.OBSERVER_CLI !== "1" && !process.env.VITEST;
if (invokedDirectly && isMainModule()) {
  void main();
}

function isMainModule(): boolean {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

export { main };
