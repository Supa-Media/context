/**
 * Container entrypoint. The Durable Object passes PHOTON_PROJECT_ID and
 * PHOTON_PROJECT_SECRET as the container's environment at start; nothing here
 * is read from a file or written to disk.
 */
import { createApp } from "./app.mjs";
import { createLogger, createLogRing } from "./log.mjs";
import { createRuntime } from "./runtime.mjs";

const ring = createLogRing();
const log = createLogger(process.stdout, ring);
const runtime = createRuntime({
  projectId: process.env.PHOTON_PROJECT_ID,
  projectSecret: process.env.PHOTON_PROJECT_SECRET,
  log,
});

const server = createApp({ runtime, log, ring }).listen(8080, "0.0.0.0", () => {
  log({ event: "container.listening", ok: true, status: 8080 });
});

function shutdown() {
  runtime.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
