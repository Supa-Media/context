/**
 * Container entrypoint. The Durable Object passes PHOTON_PROJECT_ID and
 * PHOTON_PROJECT_SECRET as the container's environment at start; nothing here
 * is read from a file or written to disk.
 */
import { createApp } from "./app.mjs";
import { errorClass } from "./errors.mjs";
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

function shutdown(signal) {
  log({ event: "container.stopping", signal });
  runtime.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Only the class name is logged: a message can quote a number or a body.
process.on("uncaughtException", (error) => {
  log({ event: "container.crashed", error: errorClass(error) });
  // Give the log line a moment to flush, then exit as Node would have.
  setTimeout(() => process.exit(1), 200);
});
process.on("unhandledRejection", (reason) => {
  log({ event: "container.crashed", error: errorClass(reason) });
});
