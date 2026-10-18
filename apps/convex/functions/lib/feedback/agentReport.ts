/**
 * A problem report an agent files through the gateway's `report_problem` tool,
 * checked and shaped into the same `FeedbackReport` the app's reports become.
 *
 * An agent sends a message and nothing else. It has no screen, no activity log
 * and no screenshot, and the fields that say where a report came from are set
 * here rather than taken from the request: the source is always `agent` and
 * the AI app is the one the grant names. The app's own intake refuses `agent`,
 * so neither kind of report can pass itself off as the other.
 *
 * One exception: a bug report the person files by text carries their recent
 * texts with Tex, which the gateway attaches only after their YES to the exact
 * report (`apps/mcp/src/tools/reportGate.js`). Accepted from the texting
 * grant alone, so no other AI's token can hand the team a conversation.
 */

import { ConvexError } from "convex/values";
import { FEEDBACK_LIMITS } from "@context/shared";
import type { FeedbackReport } from "./report";

/** The AI app's name, as a tag: one line, bounded, never empty. */
function clientLabel(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line === "" ? "unknown" : [...line].slice(0, 80).join("");
}

/** Kept equal to `apps/mcp/src/tools/reportGate.js`'s `MAX_REPORT_TEXTS_CHARS`. */
export const MAX_REPORT_TEXTS_CHARS = 16_000;
/** The texting assistant's grant (`functions/textLinks.ts`), the only one that may attach texts. */
export const TEXTS_CLIENT_ID = "context_texts";

function randomReportId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseAgentReport(input: {
  message: unknown;
  clientName: string;
  clientId?: string;
  texts?: unknown;
}): FeedbackReport {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message === "" || [...message].length > FEEDBACK_LIMITS.messageChars) {
    throw new ConvexError({ code: "FEEDBACK_INVALID", field: "message", message: "The report's message is empty or too long." });
  }
  let texts: string | undefined;
  if (input.texts !== undefined) {
    const ok =
      input.clientId === TEXTS_CLIENT_ID &&
      typeof input.texts === "string" &&
      input.texts.trim() !== "" &&
      [...input.texts].length <= MAX_REPORT_TEXTS_CHARS;
    if (!ok) throw new ConvexError({ code: "FEEDBACK_INVALID", field: "texts", message: "The report's texts are not accepted." });
    texts = input.texts as string;
  }
  return {
    ...(texts === undefined ? {} : { texts }),
    // One per call: an agent that retries files a second report, which the
    // day's budget bounds.
    clientReportId: randomReportId(),
    message,
    source: "agent",
    screen: "/mcp",
    app: { platform: "agent" },
    agentClient: clientLabel(input.clientName),
  };
}
