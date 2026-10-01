/**
 * Checking an in-app feedback report before anything is stored or sent.
 *
 * The app builds every field to a safe shape already; this checks again,
 * because it is the last point where a mistake in the app, or a client that
 * is not the app, can be stopped before a vendor has it. The definitions are
 * the app's own (`@context/shared`'s `feedbackReport.ts`).
 *
 * A refusal says which field and never what was in it: the value is exactly
 * what must not end up in a log line or an error report.
 */

import { ConvexError } from "convex/values";
import {
  CLIENT_REPORT_ID_PATTERN,
  EVENT_ID_PATTERN,
  FEEDBACK_LIMITS,
  FEEDBACK_PLATFORMS,
  FEEDBACK_SOURCES,
  SYSTEM_FAMILIES,
  VERSION_PATTERN,
  isActivityLine,
  isCleanRoute,
  type FeedbackPlatform,
  type FeedbackSource,
  type SystemFamily,
} from "@context/shared";

/** What the action receives, before checking. */
export interface FeedbackReportInput {
  clientReportId: string;
  message: string;
  source: string;
  screen: string;
  activity?: string;
  errorEventId?: string;
  screenshot?: ArrayBuffer;
  screenshotType?: string;
  app: { platform: string; build?: string };
  system?: { family: string; version?: string };
}

/** A report that passed every check. */
export interface FeedbackReport {
  clientReportId: string;
  message: string;
  /** `agent` only ever comes from `parseAgentReport`: the app's intake refuses it. */
  source: FeedbackSource | "agent";
  screen: string;
  activity?: string;
  errorEventId?: string;
  screenshot?: { data: Uint8Array; contentType: "image/jpeg" | "image/png" };
  app: { platform: FeedbackPlatform | "agent"; build?: string };
  system?: { family: SystemFamily; version?: string };
  /** For an agent's report: which AI app filed it, as its grant names it. */
  agentClient?: string;
}

function refuse(field: string): never {
  throw new ConvexError({
    code: "FEEDBACK_INVALID",
    field,
    message: `The report's ${field} is not in a shape this accepts.`,
  });
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length > magic.length && magic.every((byte, index) => bytes[index] === byte);
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function parseFeedbackReport(input: FeedbackReportInput): FeedbackReport {
  if (!CLIENT_REPORT_ID_PATTERN.test(input.clientReportId)) refuse("clientReportId");

  const message = input.message.trim();
  if (message === "" || [...message].length > FEEDBACK_LIMITS.messageChars) refuse("message");

  if (!oneOf(input.source, FEEDBACK_SOURCES)) refuse("source");
  if (!isCleanRoute(input.screen)) refuse("screen");

  let activity: string | undefined;
  if (input.activity !== undefined && input.activity !== "") {
    const lines = input.activity.split("\n");
    if (
      lines.length > FEEDBACK_LIMITS.activityLines ||
      new TextEncoder().encode(input.activity).byteLength > FEEDBACK_LIMITS.activityBytes ||
      !lines.every(isActivityLine)
    ) {
      refuse("activity");
    }
    activity = input.activity;
  }

  if (input.errorEventId !== undefined && !EVENT_ID_PATTERN.test(input.errorEventId)) refuse("errorEventId");

  let screenshot: FeedbackReport["screenshot"];
  if (input.screenshot !== undefined || input.screenshotType !== undefined) {
    if (input.screenshot === undefined) refuse("screenshot");
    const data = new Uint8Array(input.screenshot);
    if (data.byteLength > FEEDBACK_LIMITS.screenshotBytes) refuse("screenshot");
    // The bytes must be the picture the type claims, so a report cannot
    // attach some other file under an image's name.
    if (input.screenshotType === "image/jpeg" && startsWith(data, JPEG_MAGIC)) {
      screenshot = { data, contentType: "image/jpeg" };
    } else if (input.screenshotType === "image/png" && startsWith(data, PNG_MAGIC)) {
      screenshot = { data, contentType: "image/png" };
    } else {
      refuse("screenshot");
    }
  }

  if (!oneOf(input.app.platform, FEEDBACK_PLATFORMS)) refuse("app");
  if (input.app.build !== undefined && !VERSION_PATTERN.test(input.app.build)) refuse("app");
  const app: FeedbackReport["app"] = { platform: input.app.platform };
  if (input.app.build !== undefined) app.build = input.app.build;

  let system: FeedbackReport["system"];
  if (input.system !== undefined) {
    if (input.system.version !== undefined && !VERSION_PATTERN.test(input.system.version)) refuse("system");
    const family = input.system.family.toLowerCase();
    system = { family: oneOf(family, SYSTEM_FAMILIES) ? family : "other" };
    if (input.system.version !== undefined) system.version = input.system.version;
  }

  const report: FeedbackReport = {
    clientReportId: input.clientReportId,
    message,
    source: input.source,
    screen: input.screen,
    app,
  };
  if (activity !== undefined) report.activity = activity;
  if (input.errorEventId !== undefined) report.errorEventId = input.errorEventId;
  if (screenshot !== undefined) report.screenshot = screenshot;
  if (system !== undefined) report.system = system;
  return report;
}
