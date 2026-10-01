/**
 * A problem report an agent files through the gateway's `report_problem` tool,
 * checked and shaped into the same `FeedbackReport` the app's reports become.
 *
 * An agent sends a message and nothing else. It has no screen, no activity log
 * and no screenshot, and the fields that say where a report came from are set
 * here rather than taken from the request: the source is always `agent` and
 * the AI app is the one the grant names. The app's own intake refuses `agent`,
 * so neither kind of report can pass itself off as the other.
 */

import { ConvexError } from "convex/values";
import { FEEDBACK_LIMITS } from "@context/shared";
import type { FeedbackReport } from "./report";

/** The AI app's name, as a tag: one line, bounded, never empty. */
function clientLabel(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line === "" ? "unknown" : [...line].slice(0, 80).join("");
}

function randomReportId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseAgentReport(input: { message: unknown; clientName: string }): FeedbackReport {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message === "" || [...message].length > FEEDBACK_LIMITS.messageChars) {
    throw new ConvexError({ code: "FEEDBACK_INVALID", field: "message", message: "The report's message is empty or too long." });
  }
  return {
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
