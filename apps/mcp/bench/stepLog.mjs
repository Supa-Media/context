/**
 * THE STEP LOG: one JSON line per model call the bench makes through the socket, when `BENCH_STEP_LOG=<file>` is set
 * (the Tex Architecture Lab, Dev2, 2026-11-13: "log every step").
 *
 * The Lab reads these lines to see what each Lab step cost: how long it took, how much went in and came out, and what
 * it said. The sizes are estimates (about four characters to a token, `est: true` on every line), because the socket
 * sees the request and the answer, never the provider's own count. The Lab turns a subscription call's time into
 * production time from `out`, so `out` is the number that matters most.
 *
 * Two rules keep this from ever changing a run. A log line that cannot be written is dropped silently: the call
 * already has its answer and the answer is what the run scores. And the answer is handed back as it came, so a
 * logged run and an unlogged one score the same.
 *
 * `side` says whether the call came from the branch under test or from main's tree, since the gate runs both and the
 * Lab reads only the branch's lines (`BENCH_LAB_BRANCH` is the branch's checkout; unset means every line is the branch).
 */
import { appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { realNow } from "./clock.mjs";
import { labNodeFor } from "./labNodes.mjs";
import { requestHash, stableJson } from "./modelSocket.mjs";

export const STEP_LOG_ENV = "BENCH_STEP_LOG";
export const LAB_BRANCH_ENV = "BENCH_LAB_BRANCH";
/** Main's checkout in a Lab run (`lab.mjs`): checked first, so a main worktree nested inside the branch is still main. */
export const LAB_MAIN_ENV = "BENCH_LAB_MAIN";
/** The most of an answer's text a line keeps: enough to read what a step said, never a whole long reply. */
export const OUTPUT_CHARS = 4000;

/** About four characters to a token: the same rough measure the bench uses everywhere else. */
const tokens = (chars) => Math.ceil(chars / 4);

/**
 * What a call sent, as characters. A Claude call's system, messages and tools, which is what the provider bills as input;
 * a Workers AI call's whole input.
 */
function sentChars(kind, request) {
  if (kind === "claude") {
    return stableJson(request?.system ?? null).length + stableJson(request?.messages ?? null).length + stableJson(request?.tools ?? null).length;
  }
  return stableJson(request ?? null).length;
}

/** Which side of the gate a call came from: the branch when its checkout is `BENCH_LAB_BRANCH` (or none is named), else main. */
function sideOf(env, cwd = process.cwd()) {
  const within = (dir) => {
    const root = resolve(dir);
    return cwd === root || cwd.startsWith(root + sep);
  };
  if (env[LAB_MAIN_ENV] && within(env[LAB_MAIN_ENV])) return "main";
  const branch = env[LAB_BRANCH_ENV];
  return !branch || within(branch) ? "branch" : "main";
}

/**
 * One line for one call. `answer` is what the socket gave (a Claude answer `{ text, toolCalls?, thinking? }`, or a
 * Workers AI answer object); `ok: false` is a call that got no answer, and then `answer` is ignored.
 */
export function stepLine({ env = {}, kind, request, answer, ms, ok }) {
  const hash = requestHash(kind, request).slice(0, 12);
  const base = {
    node: labNodeFor(kind, request),
    model: request?.model ?? null,
    kind,
    ms: Math.round(ms),
    in: tokens(sentChars(kind, request)),
  };
  const tail = { side: sideOf(env), hash, est: true };
  if (!ok) return { ...base, out: 0, thinking: "", steps: [], output: "", ok: false, ...tail };
  if (kind !== "claude") {
    const output = stableJson(answer).slice(0, OUTPUT_CHARS);
    return { ...base, out: tokens(stableJson(answer).length), thinking: "", steps: [], output, ok: true, ...tail };
  }
  const text = String(answer?.text ?? "");
  const calls = (Array.isArray(answer?.toolCalls) ? answer.toolCalls : []).map((call) => ({ name: call.name, input: call.input ?? {} }));
  const out = tokens(text.length + (calls.length ? stableJson(calls).length : 0));
  const thinking = typeof answer?.thinking === "string" ? answer.thinking : "";
  return { ...base, out, thinking, steps: calls, output: text.slice(0, OUTPUT_CHARS), ok: true, ...tail };
}

/** Appends one line. A failure to write is swallowed: the log is a record of the run, never a reason for it to fail. */
export function appendStep(file, line) {
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // The call's answer stands whether or not its line was kept.
  }
}

/**
 * The socket with each call written to the step log once it is answered or missed. The answer, and a miss's error, pass
 * through unchanged. `missed` and `mode` are the socket's own, so a run that reads them sees the same thing.
 */
export function withStepLog(socket, env) {
  const file = env[STEP_LOG_ENV];
  const askThrough = socket.ask;
  return {
    ...socket,
    async ask(kind, request) {
      const started = realNow();
      let answer;
      try {
        answer = await askThrough(kind, request);
      } catch (error) {
        appendStep(file, stepLine({ env, kind, request, ms: realNow() - started, ok: false }));
        throw error;
      }
      appendStep(file, stepLine({ env, kind, request, answer, ms: realNow() - started, ok: true }));
      return answer;
    },
  };
}
