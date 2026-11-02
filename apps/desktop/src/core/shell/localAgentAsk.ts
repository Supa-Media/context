/**
 * A question for the CLI on this machine, as the console sent it
 * (`agent.ask`, bridge version 7), rebuilt field by field rather than
 * forwarded. Moved out of `main/consoleBridge.ts` unchanged.
 *
 * `features/agent/gateway.ts` holds the same rule for the same reason on the
 * other road: what leaves for the model is decided in one place, so a field
 * added to the page's own object for a local purpose — a cached body, a
 * draft — is not carried along by a spread. Here the reader is a subprocess
 * on this machine rather than a Worker, which changes nothing about the rule
 * and everything about who would see the mistake.
 */

import type { LocalAgentAsk } from "@context/desktop-bridge";

export function localAgentAskFrom(payload: unknown): LocalAgentAsk {
  const source = (payload ?? {}) as { question?: unknown; place?: unknown };
  const place = (source.place ?? {}) as {
    context?: unknown;
    note?: unknown;
    meetingLive?: unknown;
  };
  const note = (place.note ?? null) as {
    path?: unknown;
    visibility?: unknown;
    readable?: unknown;
    unsaved?: unknown;
  } | null;
  return {
    question: typeof source.question === "string" ? source.question : "",
    place: {
      context: typeof place.context === "string" ? place.context : null,
      note:
        note !== null && typeof note.path === "string"
          ? {
              path: note.path,
              visibility: typeof note.visibility === "string" ? note.visibility : "private",
              readable: note.readable !== false,
              unsaved: note.unsaved === true,
            }
          : null,
      meetingLive: place.meetingLive === true,
    },
  };
}
