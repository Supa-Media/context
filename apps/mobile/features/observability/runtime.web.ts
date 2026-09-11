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
  const client = posthog.init(apiKey, {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: false,
    person_profiles: "identified_only",
    get_current_url: sanitizedCurrentUrl,
    before_send: (event) => {
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
      maskAttributeFn: (name, value) =>
        /^(?:alt|aria-label|data-testid|href|id|name|placeholder|src|title|value)$/i.test(name)
          ? "[masked]"
          : value,
      recordCrossOriginIframes: false,
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: sanitizedCurrentUrl(request.name),
        requestHeaders: undefined,
        requestBody: undefined,
        responseHeaders: undefined,
        responseBody: undefined,
      }),
      sampleRate: replaySampleRate,
    },
  });

  return {
    ready: async () => {},
    capture: (name, properties) => {
      client.capture(name, properties);
    },
    screen: (name) => {
      client.capture("$screen", { $screen_name: name });
    },
    identify: (userId) => client.identify(userId),
    reset: () => client.reset(),
    getSessionId: () => client.get_session_id(),
  };
}
