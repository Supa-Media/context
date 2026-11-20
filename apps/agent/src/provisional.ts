/**
 * A Provisional run (Dev2, 2026-11-17; the config's `provisional` wire, `packages/tex/src/texGraph.cjs`;
 * docs/decisions/texting-assistant/provisional-run.md).
 *
 * Front door is the longest step of a turn, and it waited for Triage, Decide and the Queue. When the config wires them
 * to the Front door as a Provisional run, a group's burst starts its turn at once, beside Decide, and Decide's choice
 * is the go or the stop: the same messages chosen to answer is the go (`/agent/go`), anything else (quiet, wait, a
 * different set) stops it (`/agent/cancel` with `provisional: true`), mid-model-call if need be, and the drain carries
 * on as it would have. Until the go nothing it says reaches the chat (no tapback, no progress line, no answer), and on
 * the gateway nothing it would change runs that cannot be undone (`apps/mcp/src/agent/steer.js`).
 *
 * The wiring is read from the config the Worker was built with, or the Lab draft a test chat runs on (`env.TEX_GRAPH`).
 * Every run is logged as its own step (`provisional`): started, go, stop and why, how long it ran before the verdict.
 */

import { TEX_CONFIG as bundled } from "../../../packages/tex/src/texConfig.cjs";
import { provisionalHeld, provisionalWiring } from "../../../packages/tex/src/texGraph.cjs";
import { post, record, type Fetch } from "./clients";

export type Verdict = "go" | "stop";
export type Allow = "read" | "revertible";
/** What a provisional run's Worker side waits on: the verdict, and the turn the gateway knows it by once asked. */
export type ProvisionalGate = {
  allow: Allow;
  decided: Promise<Verdict>;
  /** The verdict, once given. */
  readonly verdict: Verdict | null;
  /** The turn's id on the gateway, once it asked. */
  readonly turn: string | null;
  /** The turn's id and grant, from the moment it asks the gateway: the verdict goes to it then (or at once, if given). */
  bind(turn: string, accessToken: string): void;
};

/** How long, and how often, the go is tried while the gateway has not yet marked the turn running. */
export const GO_TRY_MS = 10_000;
const GO_POLL_MS = 150;
const CALL_MS = 5_000;

/** What the config says: whether the Front door (`doorStep`) runs provisionally, what it may do before the go, and which bursts do not start it (`unless`, the union of the wires'). */
export function provisionalDoor(graph?: unknown): { on: boolean; allow: Allow; unless: string[] } {
  const wiring = provisionalWiring((graph ?? bundled) as Parameters<typeof provisionalWiring>[0]) as unknown as { on: boolean; target: string | null; sources: { allow: Allow; unless?: string[] }[] };
  if (!wiring.on || wiring.target !== "doorStep") return { on: false, allow: "read", unless: [] };
  const unless: string[] = [];
  for (const source of wiring.sources) for (const fact of source.unless ?? []) if (!unless.includes(fact)) unless.push(fact);
  // The narrowest of the wires' grants: one source that allows reads only holds every write.
  return { on: true, allow: wiring.sources.some((source) => source.allow === "read") ? "read" : "revertible", unless };
}

/** The facts a group burst carries for the wires' `unless`: a first look, an SMS, and a worker with only one of the two paths. */
export function earlyFacts(
  items: ReadonlyArray<{ look?: boolean; message?: { sms?: boolean } }>,
  deps: { startTurn?: unknown; answerFirst?: unknown },
): string[] {
  const facts: string[] = [];
  if (items.some((item) => item.look === true)) facts.push("firstLook");
  if (items.some((item) => item.message?.sms === true)) facts.push("sms");
  if ((deps.startTurn === undefined) !== (deps.answerFirst === undefined)) facts.push("unpaired");
  return facts;
}

/**
 * Whether this burst starts the provisional run. `start` is false when the door is not wired, or when `held` names a
 * fact the wires' `unless` lists (`provisionalHeld`, the same read the Lab's simulation uses). `held` is empty when
 * the door is off, so a skip is logged only for a run the config would have started.
 */
export function earlyGate(
  graph: unknown,
  items: ReadonlyArray<{ look?: boolean; message?: { sms?: boolean } }>,
  deps: { startTurn?: unknown; answerFirst?: unknown },
): { start: boolean; allow: Allow; held: string[] } {
  const door = provisionalDoor(graph);
  if (!door.on) return { start: false, allow: door.allow, held: [] };
  const held = provisionalHeld(door.unless, earlyFacts(items, deps)) as string[];
  return { start: held.length === 0, allow: door.allow, held };
}

type GateDeps = { fetch: Fetch; gatewayOrigin: string; now: () => number; sleep?: (ms: number) => Promise<void> };

/** A gate, and `decide` for whoever gives the verdict (the drain). */
export function provisionalGate(deps: GateDeps, allow: Allow): ProvisionalGate & { decide(verdict: Verdict): Promise<void> } {
  let verdict: Verdict | null = null;
  let resolve!: (verdict: Verdict) => void;
  const decided = new Promise<Verdict>((r) => (resolve = r));
  let bound: { turn: string; accessToken: string } | null = null;
  let told: Promise<void> | null = null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tell = () => {
    if (bound === null || verdict === null || told !== null) return told ?? Promise.resolve();
    const { turn, accessToken } = bound;
    told = verdict === "stop" ? stopTurn(deps, accessToken, turn).then(() => {}) : goTurn({ ...deps, sleep }, accessToken, turn).then(() => {});
    return told;
  };
  return {
    allow,
    decided,
    get verdict() {
      return verdict;
    },
    get turn() {
      return bound?.turn ?? null;
    },
    bind(turn, accessToken) {
      if (bound !== null) return;
      bound = { turn, accessToken };
      void tell();
    },
    async decide(given) {
      if (verdict !== null) return;
      verdict = given;
      resolve(given);
      await tell();
    },
  };
}

/** `POST /agent/go`, tried until the gateway has the turn running (it marks itself beside the model) or `GO_TRY_MS` pass. */
async function goTurn(deps: GateDeps & { sleep: (ms: number) => Promise<void> }, accessToken: string, turn: string): Promise<boolean> {
  const until = deps.now() + GO_TRY_MS;
  for (;;) {
    try {
      const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/go`, accessToken, { turn }, CALL_MS);
      if (status === 200 && record(json).go === true) return true;
    } catch {
      // tried again
    }
    if (deps.now() >= until) return false;
    await deps.sleep(GO_POLL_MS);
  }
}

/** `POST /agent/cancel { turn, provisional: true }`: stopped whether or not it has marked itself running yet. */
async function stopTurn(deps: GateDeps, accessToken: string, turn: string): Promise<boolean> {
  try {
    const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/cancel`, accessToken, { turn, provisional: true }, CALL_MS);
    return status === 200 && record(json).cancelled === true;
  } catch {
    return false;
  }
}

/** Whether `keys` names exactly the messages the run started on: only then is Decide's choice its go. */
export function sameMessages(started: readonly string[], chosen: readonly string[]): boolean {
  return started.length === chosen.length && started.every((key) => chosen.includes(key));
}

/** The run's step, one line each: started, its verdict and why, and how long it had run (never words). */
export function logProvisional(outcome: "started" | "go" | "stop" | "ended" | "skipped", fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ event: "group_turn", step: "provisional", outcome, ...fields }));
}
