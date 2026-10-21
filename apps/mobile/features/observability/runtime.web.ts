import type { CaptureResult, CapturedNetworkRequest, PostHog } from "posthog-js";
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

const AUTOCAPTURE_PROPERTIES = new Set([
  "distinct_id", "$device_id", "$user_id", "$session_id", "$window_id", "$is_identified",
  "$current_url", "$pathname", "$host", "$referrer", "$screen_name", "$event_type", "$ce_version",
  "$lib", "$lib_version", "$browser", "$browser_version", "$os", "$os_version", "$device_type",
  "$screen_height", "$screen_width", "$viewport_height", "$viewport_width",
  "app_env", "app_product", "app_platform", "app_build",
]);

/** SDK person properties can nest the initial URL under $set_once. */
function cleanVendorProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanVendorProperties);
  if (value === null || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^\$(?:title|initial_title|el_text|elements|elements_chain|external_click_url)$/.test(key)) continue;
    if (/^\$(?:.*_)?(?:url|referrer|pathname)$/.test(key) && typeof item === "string") {
      if (key.endsWith("referrer")) {
        try { clean[key] = new URL(item).origin; } catch { /* No opaque referrer. */ }
      } else clean[key] = sanitizedCurrentUrl(item);
    } else clean[key] = cleanVendorProperties(item);
  }
  return clean;
}

export function cleanPostHogProperties(
  properties: Record<string, unknown>,
  projectKey: string,
  eventName?: string,
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
  const { $snapshot_data: snapshot, $heatmap_data: heatmap, token: _transportToken, ...ordinary } = properties;
  const clean = cleanVendorProperties(redactTelemetryValue(ordinary)) as Record<string, unknown>;
  // DOM text, classes and hrefs can hold note titles, phone numbers or capabilities.
  // Named product events identify controls; heatmaps need only coordinates.
  for (const key of Object.keys(clean)) {
    // data-ph-capture-attribute-* bypasses SDK masks. Keep no arbitrary DOM properties.
    if (eventName === "$autocapture" && !AUTOCAPTURE_PROPERTIES.has(key)) delete clean[key];
  }
  // The heatmap SDK keys its buffer by the RAW location.href, independently
  // of get_current_url. Admit only the public homepage and strip its query.
  if (heatmap && typeof heatmap === "object") {
    const points: Record<string, unknown[]> = {};
    for (const [address, value] of Object.entries(heatmap)) {
      try {
        const url = new URL(address);
        if (url.pathname !== "/" || !Array.isArray(value)) continue;
        const key = `${url.origin}/`;
        points[key] = [...(points[key] ?? []), ...value.map((point) => {
          const safe: Record<string, unknown> = {};
          if (point && typeof point === "object") for (const [name, field] of Object.entries(point)) {
            if (["x", "y", "target_width", "target_height", "viewport_width", "viewport_height"].includes(name) && typeof field === "number" && Number.isFinite(field)) safe[name] = field;
            if (name === "target_fixed" && typeof field === "boolean") safe[name] = field;
            if (name === "type" && ["click", "mousemove", "deadclick", "rageclick"].includes(String(field))) safe[name] = field;
          }
          return safe;
        })];
      } catch { /* An unknown URL never becomes a telemetry key. */ }
    }
    clean.$heatmap_data = points;
  }
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
  pagePath,
}: {
  apiKey: string;
  host: string;
  replaySampleRate: number;
  /** Where the app is served from; `location.origin` in the browser. */
  pageOrigin?: string;
  pagePath?: string;
}) {
  // Only the public homepage. The signed-in editor never gets DOM autocapture.
  const marketing = pagePath === "/";
  return {
    api_host: ingestHost(host, pageOrigin),
    ui_host: uiHost(host),
    autocapture: marketing ? {
      dom_event_allowlist: ["click" as const],
      css_selector_allowlist: ["[data-analytics-action]"],
    } : false as const,
    ip: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_heatmaps: marketing,
    capture_pageview: false,
    capture_pageleave: true,
    save_campaign_params: false,
    save_referrer: false,
    enable_recording_console_log: false,
    disable_session_recording: false,
    person_profiles: "identified_only" as const,
    get_current_url: sanitizedCurrentUrl,
    before_send: (event: CaptureResult | null): CaptureResult | null => {
      if (event === null) return null;
      return {
        ...event,
        properties: cleanPostHogProperties(event.properties, apiKey, event.event) as typeof event.properties,
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

/** Disable listeners and discard their in-memory buffer as soon as counts are off. */
export function setWebCapturing(
  client: Pick<PostHog, "set_config" | "opt_in_capturing" | "opt_out_capturing">,
  enabled: boolean,
  pagePath: string,
): void {
  client.set_config({
    capture_heatmaps: enabled && pagePath === "/",
    autocapture: enabled && pagePath === "/" ? {
      dom_event_allowlist: ["click"], css_selector_allowlist: ["[data-analytics-action]"],
    } : false,
  });
  if (enabled) client.opt_in_capturing();
  else client.opt_out_capturing();
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
    postHogWebOptions({ apiKey, host, replaySampleRate, pageOrigin: location.origin, pagePath: location.pathname }),
  );

  return {
    ready: async () => {},
    capture: (name, properties) => {
      client.capture(name, properties, {
        send_instantly: ["signup_result", "signin_code_result", "tex_messages_opened", "landing_cta_clicked"].includes(name),
      });
    },
    screen: (name) => {
      const page = postHogWebOptions({ apiKey, host, replaySampleRate, pageOrigin: location.origin, pagePath: name });
      client.set_config({ autocapture: page.autocapture, capture_heatmaps: page.capture_heatmaps });
      client.capture("$screen", { $screen_name: name });
      // Expo Router owns navigation. One explicit pageview per screen also
      // powers PostHog Web Analytics and pageleave/scroll-depth calculations.
      client.capture("$pageview", { $screen_name: name });
    },
    register: (properties) => client.register(properties),
    identify: (userId) => client.identify(userId),
    reset: () => client.reset(),
    getSessionId: () => client.get_session_id(),
    setCapturing: (enabled) => {
      setWebCapturing(client, enabled, location.pathname);
    },
    stopRecording: () => client.stopSessionRecording(),
  };
}
