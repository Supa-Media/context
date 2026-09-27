/**
 * The local-agent verbs' payloads (bridge version 7), split out of
 * `contract.ts` to keep that file under the size ceiling. Re-exported from
 * there, so every import site is unchanged.
 */

/**
 * Whether this machine can answer a question locally.
 *
 * `available: false` is the ordinary case and is never an error: most machines
 * have no `claude` installed, and nobody is shown a failure for not having
 * installed a developer tool. `name` is what the console puts on the control
 * that offers the choice, so it is the shell's word rather than the page's
 * guess.
 */
export interface LocalAgentStatus {
  available: boolean;
  name: string | null;
}

/**
 * One question, and where the person asking it is standing.
 *
 * `place` is the same shape the gateway's `/agent` route takes
 * (`apps/mobile/features/agent/gateway.ts`), deliberately: the two routes
 * answer the same question from the same input, so the panel builds one object
 * and picks a road afterwards rather than knowing two formats.
 *
 * It carries **references and never content** — a path, a visibility, whether
 * a draft diverged. If the agent wants the note it calls `read_note` and the
 * same privacy engine decides, rather than being handed text that the clamp
 * never saw. `apps/mobile/features/agent/page.ts` argues that at length.
 */
export interface LocalAgentAsk {
  question: string;
  place: {
    context: string | null;
    note: { path: string; visibility: string; readable: boolean; unsaved: boolean } | null;
    meetingLive: boolean;
  };
}

/**
 * What one local turn produced.
 *
 * An envelope rather than a value or a throw, for `ConsoleBridge`'s own reason:
 * a refusal somebody is meant to read has to travel as data. Every failure here
 * is on the person's own machine and every one of them is fixable by them, so
 * `message` is a sentence that names the fix rather than a category.
 */
export type LocalAgentReply =
  | { ok: true; answer: string; provider: string; steps: { tool: string; ok: boolean }[] }
  | { ok: false; message: string };
