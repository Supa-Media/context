/**
 * One command on Tex's computer: `bash -lc` in the work folder, as the unprivileged user the image runs as, with a
 * time limit and its output capped. The tail of a long output is kept (the end is where errors are), with how much
 * was dropped. Never throws: a command that cannot start is an answer with `started: false`.
 */
import { spawn } from "node:child_process";

export const MAX_COMMAND_CHARS = 8_000;
export const MAX_OUTPUT_CHARS = 64_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 110_000;
/** How long output may still arrive after the shell itself exits. */
export const AFTER_EXIT_MS = 300;

/** A capped buffer that keeps the last `max` characters. */
function tail(max) {
  let text = "";
  let dropped = 0;
  return {
    add(chunk) {
      text += chunk;
      if (text.length > max) {
        dropped += text.length - max;
        text = text.slice(-max);
      }
    },
    get value() {
      return dropped > 0 ? `[${dropped} earlier characters dropped]\n${text}` : text;
    },
  };
}

export function clampTimeout(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

/** `{ exitCode, stdout, stderr, timedOut, ms, started }`. */
export function runCommand(command, { cwd, timeoutMs, env } = {}) {
  const started = Date.now();
  const out = tail(MAX_OUTPUT_CHARS);
  const err = tail(MAX_OUTPUT_CHARS);
  return new Promise((done) => {
    let child;
    try {
      child = spawn("bash", ["-lc", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      done({ started: false, exitCode: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false, ms: Date.now() - started });
      return;
    }
    let timedOut = false;
    const limit = clampTimeout(timeoutMs);
    // The whole process group goes, so a background job the command left running cannot hold the answer open.
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limit);
    child.stdout.setEncoding("utf8").on("data", (chunk) => out.add(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => err.add(chunk));
    child.on("error", (error) => err.add(String(error?.message ?? error)));
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      kill();
      done({ started: true, exitCode: timedOut ? null : code, stdout: out.value, stderr: err.value, timedOut, ms: Date.now() - started });
    };
    child.on("close", (code) => finish(code));
    // The shell ended but something it started still holds its output open: drain briefly, then end it all.
    child.on("exit", (code) => setTimeout(() => finish(code), AFTER_EXIT_MS));
  });
}
