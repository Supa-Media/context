/**
 * A feedback report as a Sentry envelope: the same wire format the Sentry SDK
 * sends, built here so the report travels from the control plane and the app
 * never talks to Sentry about it.
 *
 * The event carries the account id and nothing else about the person — never
 * their email, never their name. We answer a report by looking the id up.
 */

import type { FeedbackReport } from "./report";

export interface SentryTarget {
  /** Where envelopes go: `https://<host>/api/<project>/envelope/`. */
  endpoint: string;
  /** The DSN itself, which authenticates the envelope from its header. */
  dsn: string;
}

/**
 * The ingest address a DSN names, or null for anything that is not an https
 * DSN with a public key and a numeric project — so a mistyped variable leaves
 * the intake off rather than posting reports somewhere unexpected.
 */
export function parseDsn(value: string | undefined): SentryTarget | null {
  if (value === undefined || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^[0-9a-f]{16,64}$/i.test(url.username) || url.password !== "") return null;
  const project = /^\/(\d{1,20})\/?$/.exec(url.pathname);
  if (project === null || url.search !== "" || url.hash !== "") return null;
  return { endpoint: `https://${url.host}/api/${project[1]}/envelope/`, dsn: value.trim() };
}

export interface EnvelopeInput {
  dsn: string;
  eventId: string;
  userId: string;
  environment: string;
  /** Milliseconds, as `Date.now()`. */
  now: number;
  report: FeedbackReport;
}

function line(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function attachment(filename: string, contentType: string, data: Uint8Array): Uint8Array[] {
  return [
    line({
      type: "attachment",
      length: data.byteLength,
      filename,
      content_type: contentType,
      attachment_type: "event.attachment",
    }),
    data,
    new TextEncoder().encode("\n"),
  ];
}

export function buildFeedbackEnvelope(input: EnvelopeInput): Uint8Array<ArrayBuffer> {
  const { report } = input;
  const feedback: Record<string, string> = {
    message: report.message,
    url: report.screen,
    source: report.source,
  };
  if (report.errorEventId !== undefined) feedback.associated_event_id = report.errorEventId;

  const contexts: Record<string, Record<string, string>> = { feedback };
  if (report.system !== undefined) {
    const os: Record<string, string> = { name: report.system.family };
    if (report.system.version !== undefined) os.version = report.system.version;
    contexts.os = os;
  }

  const event: Record<string, unknown> = {
    type: "feedback",
    event_id: input.eventId,
    timestamp: input.now / 1000,
    platform: "javascript",
    level: "info",
    environment: input.environment,
    user: { id: input.userId },
    contexts,
    tags: {
      "feedback.client_report_id": report.clientReportId,
      "feedback.source": report.source,
      "feedback.platform": report.app.platform,
    },
  };
  if (report.app.build !== undefined) event.release = report.app.build;

  const parts: Uint8Array[] = [
    line({ event_id: input.eventId, sent_at: new Date(input.now).toISOString(), dsn: input.dsn }),
    line({ type: "feedback" }),
    line(event),
  ];
  if (report.activity !== undefined) {
    parts.push(...attachment("activity.txt", "text/plain", new TextEncoder().encode(report.activity)));
  }
  if (report.screenshot !== undefined) {
    const name = report.screenshot.contentType === "image/png" ? "screenshot.png" : "screenshot.jpg";
    parts.push(...attachment(name, report.screenshot.contentType, report.screenshot.data));
  }

  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
