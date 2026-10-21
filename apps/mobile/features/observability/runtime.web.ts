import type { CaptureResult, CapturedNetworkRequest } from "posthog-js";
import { redactTelemetryValue, telemetryRoute } from "./privacy";
import type { AnalyticsClient } from "./types";

/** Sentry's JavaScript transport works in the web build without a native module. */
export function hasSentryNativeRuntime(): boolean {
  return true;
}

/** React Native replay is native-only; PostHog analytics still work on web. */
export function hasPostHogReplayRuntime(): boolean {
  return false;
}

/**
 * The app's own hosts, where the router forwards `/ingest` to PostHog
 * (`infra/router/src/analyticsIngest.ts`). Exact names, like the router's.
 */
const FIRST_PARTY_HOSTS: ReadonlySet<string> = new Set([
  "context.lc",
  "tex.lc",
  "staging.context.lc",
  "tex-staging.context.lc",
]);

/** The hosts whose traffic is production, as the Usage tab counts it. */
const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(["context.lc", "tex.lc"]);

/**
 * Where events are sent: the page's own origin under `/ingest` on our hosts,
 * so a blocker that drops requests to PostHog's address does not drop them,
 * and the configured host anywhere else (a local build, a self-hosted one).
 */
export function ingestHost(configured: string, pageOrigin?: string): string {
  if (pageOrigin === undefined) return configured;
  try {
    const url = new URL(pageOrigin);
    return url.protocol === "https:" && FIRST_PARTY_HOSTS.has(url.hostname) ? `${url.origin}/ingest` : configured;
  } catch {
    return configured;
  }
}

/** PostHog's own app, for links its SDK draws: `us.i.posthog.com` is `us.posthog.com`. */
function uiHost(configured: string): string | undefined {
  const match = /^https:\/\/(us|eu)\.i\.posthog\.com\/?$/.exec(configured);
  return match ? `https://${match[1]}.posthog.com` : undefined;
}

/**
 * `production`, `staging` or `development`, sent with every event so the one
 * PostHog project the three share can be told apart. On the web the hostname
 * decides, which is the one thing a staging build cannot claim by accident.
 */
export function analyticsEnvironment(hostname?: string): string {
  const host = hostname ?? (typeof location === "undefined" ? "" : location.hostname);
  if (PRODUCTION_HOSTS.has(host)) return "production";
  return FIRST_PARTY_HOSTS.has(host) ? "staging" : "development";
}

function sanitizedCurrentUrl(defaultUrl: string): string {
  try {
    const url = new URL(defaultUrl);
    return `${url.origin}${telemetryRoute(url.pathname)}`;
  } catch {
    return telemetryRoute(defaultUrl.split(/[?#]/, 1)[0] ?? "/");
  }
}

export function cleanPostHogProperties(
  properties: Record<string, unknown>,
  projectKey: string,
): Record<string, unknown> {
  // rrweb's snapshot payload is already protected by the recorder-level text,
  // element-attribute and URL masks below. Walking/rebuilding it here would be
  // expensive and can corrupt the replay format.
  //
  // `token` is PostHog's own required ingest routing field. The shared
  // redactor quite correctly treats every token-shaped property as sensitive,
  // but replacing this one sends the event to no project at all. Do not trust
  // the event's copy: restore the public write-only project key from the
  // configuration closure after every ordinary property has been scrubbed.
  // Nested/user-supplied token fields still pass through the redactor.
  const { $snapshot_data: snapshot, token: _transportToken, ...ordinary } = properties;
  const clean = redactTelemetryValue(ordinary) as Record<string, unknown>;
  return snapshot === undefined
    ? { ...clean, token: projectKey }
    : { ...clean, token: projectKey, $snapshot_data: snapshot };
}

/**
 * Everything that keeps a recorded session unreadable, as a value.
 *
 * **Separated from `createAnalyticsClient` so it can be asserted on.** This
 * object is the entire privacy boundary for web session replay — the recorder
 * is deliberately ON here, and what makes that acceptable is `maskTextSelector`
 * and the four rules under it. It used to be a literal inside a function whose
 * first line is `await import("posthog-js")`, and a dynamic import is the one
 * construct this suite's transform cannot reduce to a `require`, so **no test
 * could reach it at all**. Returning it is what makes it checkable; nothing
 * about the configuration itself changed.
 */
export function postHogWebOptions({
  apiKey,
  host,
  replaySampleRate,
  pageOrigin,
}: {
  apiKey: string;
  host: string;
  replaySampleRate: number;
  /** Where the app is served from; `location.origin` in the browser. */
  pageOrigin?: string;
}) {
  return {
    api_host: ingestHost(host, pageOrigin),
    ui_host: uiHost(host),
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: false,
    person_profiles: "identified_only" as const,
    get_current_url: sanitizedCurrentUrl,
    before_send: (event: CaptureResult | null): CaptureResult | null => {
      if (event === null) return null;
      return {
        ...event,
        properties: cleanPostHogProperties(event.properties, apiKey) as typeof event.properties,
      };
    },
    session_recording: {
      // Text includes rendered note bodies, not only inputs, so mask the whole DOM.
      maskAllInputs: true,
      maskTextSelector: "*",
      blockSelector: "img, video, canvas, input[type=file], [data-ph-block]",
      maskAttributeFn: (name: string, value: string) =>
        /^(?:alt|aria-label|data-testid|href|id|name|placeholder|src|title|value)$/i.test(name)
          ? "[masked]"
          : value,
      recordCrossOriginIframes: false,
      maskCapturedNetworkRequestFn: (request: CapturedNetworkRequest) => ({
        ...request,
        name: sanitizedCurrentUrl(request.name ?? ""),
        requestHeaders: undefined,
        requestBody: undefined,
        responseHeaders: undefined,
        responseBody: undefined,
      }),
      sampleRate: replaySampleRate,
    },
  };
}

export async function createAnalyticsClient({
  apiKey,
  host,
  replaySampleRate,
}: {
  apiKey: string;
  host: string;
  replaySampleRate: number;
}): Promise<AnalyticsClient> {
  const { default: posthog } = await import("posthog-js");
  const client = posthog.init(
    apiKey,
    postHogWebOptions({ apiKey, host, replaySampleRate, pageOrigin: location.origin }),
  );

  return {
    ready: async () => {},
    capture: (name, properties) => {
      client.capture(name, properties);
    },
    screen: (name) => {
      client.capture("$screen", { $screen_name: name });
    },
    register: (properties) => client.register(properties),
    identify: (userId) => client.identify(userId),
    reset: () => client.reset(),
    getSessionId: () => client.get_session_id(),
    setCapturing: (enabled) => {
      if (enabled) client.opt_in_capturing();
      else client.opt_out_capturing();
    },
    stopRecording: () => client.stopSessionRecording(),
  };
}
