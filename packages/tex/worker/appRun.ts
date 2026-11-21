/**
 * The app's run card while a turn runs (in-app Tex section A2; mock: "the run card above it shows the real live
 * steps"). The gateway streams each of the turn's steps as a `{ "live": step }` line when the ask says `live: true`
 * (`packages/tex/gateway/agent/liveSteps.js`); an app chat asks for them and keeps the newest here, under
 * `APP_RUN_KEY`, for the app's read (`packages/tex/gateway/texChat/appChat.js` outbox). Cleared when the turn ends.
 * Only an app chat keeps one: a phone has no card to show.
 */
import type { InboxStorage } from "./inbox";

export const APP_RUN_KEY = "app:run";
/** The most steps kept: the newest. */
export const MAX_RUN_STEPS = 40;

export type LiveStep = { k: "think" | "tool"; at: number; text?: string; name?: string; what?: string; ok?: boolean; ms?: number; res?: string; held?: true };
export type AppRun = { turn: string; covers: string[]; startedAt: number; steps: LiveStep[] };

/** A step off the stream, kept only in the shape the card draws; anything else is dropped. */
export function liveStepFrom(value: unknown): LiveStep | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ((raw.k !== "think" && raw.k !== "tool") || !Number.isFinite(raw.at)) return null;
  const text = (key: string, max: number) => (typeof raw[key] === "string" && raw[key] !== "" ? { [key]: (raw[key] as string).slice(0, max) } : {});
  return {
    k: raw.k,
    at: Math.max(0, Math.round(raw.at as number)),
    ...text("text", 300),
    ...text("name", 40),
    ...text("what", 130),
    ...text("res", 150),
    ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
    ...(Number.isFinite(raw.ms) ? { ms: Math.round(raw.ms as number) } : {}),
    ...(raw.held === true ? { held: true as const } : {}),
  };
}

/** Keeps the run's steps as they come, one write at a time; `end` clears it. Never throws into the turn. */
export function appRunKeeper(storage: InboxStorage, turn: string, covers: string[], now: number): { onLive: (step: unknown) => void; end: () => Promise<void> } {
  const run: AppRun = { turn, covers, startedAt: now, steps: [] };
  let chain: Promise<unknown> = storage.put<AppRun>(APP_RUN_KEY, run).catch(() => {});
  let ended = false;
  return {
    onLive: (value) => {
      const step = liveStepFrom(value);
      if (step === null || ended) return;
      const last = run.steps.at(-1);
      // Thinking streams in pieces: a piece that carries on the last one takes its place (`liveSteps.js` `keepLive`).
      if (step.k === "think" && last?.k === "think" && step.text?.startsWith((last.text ?? "").replace(/…$/, ""))) run.steps[run.steps.length - 1] = step;
      else run.steps = [...run.steps, step].slice(-MAX_RUN_STEPS);
      const kept = structuredClone(run);
      chain = chain.then(() => (ended ? undefined : storage.put<AppRun>(APP_RUN_KEY, kept))).catch(() => {});
    },
    end: async () => {
      ended = true;
      await chain;
      await storage.delete(APP_RUN_KEY).catch(() => false);
    },
  };
}
