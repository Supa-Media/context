import type { TexEvent } from "./events";

/** The chat's log as the gateway read it from storage, to hold in the sender's object from now on (`events.ts` `keepLog`): events only, at most as many as are kept (`MAX_KEPT_EVENTS`). */
export function readLog(value: unknown): TexEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((event): event is TexEvent => typeof event?.id === "string" && typeof event.chat === "string" && Number.isFinite(event.at) && typeof event.kind === "string" && typeof event.from?.kind === "string")
    .slice(-400);
}
