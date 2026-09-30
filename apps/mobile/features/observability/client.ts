import { redactTelemetryText, redactTelemetryValue, telemetryRoute } from "./privacy";
import {
  createAnalyticsClient,
  hasSentryNativeRuntime,
} from "./runtime";
import type { AnalyticsClient, TelemetryProperties } from "./types";
import { recordActivity } from "./activity";
import { loadPreferences, onPreferencesChange, preferences } from "./preferences";

export type { TelemetryProperties } from "./types";

interface ErrorContext {
  componentStack?: string | null;
  mechanism?: string;
}

type SentrySdk = typeof import("@sentry/react-native");

/**
 * How the SDK is fetched: a dynamic import, so a build without a DSN never
 * pays for it. An object rather than a bare call so a test can hand in a fake
 * SDK — Jest cannot run `import()` without flags this suite does not use.
 */
export const sentryLoader: { load: () => Promise<SentrySdk> } = {
  load: () => import("@sentry/react-native"),
};
let sentry: SentrySdk | null = null;
let posthog: AnalyticsClient | null = null;
let initPromise: Promise<void> | null = null;
let currentUserId: string | null = null;

const pendingErrors: Array<{ error: unknown; context?: ErrorContext }> = [];
const pendingScreens: string[] = [];
const MAX_PENDING = 20;

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() ?? "";
const posthogKey = process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim() ?? "";
const posthogHost = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

function sampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function cleanSentryEvent<T>(event: T): T {
  if (event === null || typeof event !== "object") return event;
  const source = event as T & {
    message?: string;
    data?: unknown;
    extra?: unknown;
    contexts?: unknown;
    request?: unknown;
    user?: { id?: string };
    breadcrumbs?: unknown[];
    exception?: { values?: Array<{ value?: string }> };
  };
  const clean = { ...source };

  if (typeof source.message === "string") clean.message = redactTelemetryText(source.message);
  if (source.data !== undefined) clean.data = redactTelemetryValue(source.data);
  if (source.extra !== undefined) clean.extra = redactTelemetryValue(source.extra);
  if (source.contexts !== undefined) clean.contexts = redactTelemetryValue(source.contexts);
  if (source.request !== undefined) clean.request = redactTelemetryValue(source.request);
  // The internal id is the entire identity contract. Drop any SDK-added fields.
  if (source.user !== undefined) clean.user = source.user.id ? { id: source.user.id } : undefined;
  if (source.breadcrumbs !== undefined) {
    clean.breadcrumbs = source.breadcrumbs.map((breadcrumb) => cleanSentryEvent(breadcrumb));
  }
  if (source.exception?.values !== undefined) {
    clean.exception = {
      ...source.exception,
      values: source.exception.values.map((value) => ({
        ...value,
        value:
          typeof value.value === "string" ? redactTelemetryText(value.value) : value.value,
      })),
    };
  }
  return clean;
}

async function initSentry(): Promise<void> {
  if (sentryDsn === "" || !hasSentryNativeRuntime()) return;
  // Sentry starts even with crash reports switched off, so turning them back
  // on works without a restart; `beforeSend` drops every error while the
  // switch is off. Feedback reports do not come through here at all: they go
  // to the control plane (`features/feedback/transport.ts`).
  const prefs = await loadPreferences();
  const sdk = await sentryLoader.load();
  sdk.init({
    dsn: sentryDsn,
    enabled: true,
    environment: __DEV__ ? "development" : "production",
    sendDefaultPii: false,
    enableAutoSessionTracking: prefs.crashReports,
    tracesSampleRate: sampleRate(
      process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      __DEV__ ? 1 : 0.1,
    ),
    beforeSend: (event) => (preferences().crashReports ? cleanSentryEvent(event) : null),
    beforeBreadcrumb: (breadcrumb) => cleanSentryEvent(breadcrumb),
  });
  sentry = sdk;
  if (currentUserId !== null) sdk.setUser({ id: currentUserId });
  for (const item of pendingErrors.splice(0)) sendErrorToSentry(item.error, item.context);
}

async function initPostHog(): Promise<void> {
  if (posthogKey === "" || posthog !== null) return;
  const prefs = await loadPreferences();
  if (!prefs.screenCounts) return;
  const client = await createAnalyticsClient({
    apiKey: posthogKey,
    host: posthogHost,
    replaySampleRate: prefs.recordings
      ? sampleRate(process.env.EXPO_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE, __DEV__ ? 1 : 0.1)
      : 0,
  });
  await client.ready();
  posthog = client;
  if (currentUserId !== null) client.identify(currentUserId);
  for (const screen of pendingScreens.splice(0)) client.screen(screen);
}

/**
 * Settings → Feedback, applied without a restart where the vendor
 * allows it. Turning recordings back on waits for the next visit: starting a
 * recording mid-session would skip the sampling the rate exists to apply.
 */
onPreferencesChange((next) => {
  if (!next.screenCounts) posthog?.setCapturing(false);
  else if (posthog === null) void initPostHog();
  else posthog.setCapturing(true);
  if (!next.recordings) posthog?.stopRecording();
});

/** Idempotent and deliberately non-fatal: telemetry can never stop the app. */
export function initObservability(): Promise<void> {
  if (initPromise !== null) return initPromise;
  initPromise = Promise.allSettled([initSentry(), initPostHog()]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        // This is the one failure that cannot reliably report itself remotely.
        console.warn("[observability] initialization failed", result.reason);
      }
    }
  });
  return initPromise;
}

function sendErrorToSentry(error: unknown, context?: ErrorContext): string | undefined {
  if (sentry === null) {
    pendingErrors.push({ error, context });
    if (pendingErrors.length > MAX_PENDING) pendingErrors.shift();
    return undefined;
  }
  let eventId: string | undefined;
  sentry.withScope((scope) => {
    if (context?.mechanism) scope.setTag("context.mechanism", context.mechanism);
    if (context?.componentStack) {
      scope.setContext("react", { componentStack: redactTelemetryText(context.componentStack) });
    }
    if (posthog !== null) scope.setTag("posthog.session_id", posthog.getSessionId());
    eventId = sentry?.captureException(error);
  });
  return eventId;
}

/**
 * Reports an error and answers the Sentry event id, so a feedback report
 * written about it can point at it. `undefined` while Sentry is starting.
 */
export function reportError(error: unknown, context?: ErrorContext): string | undefined {
  const eventId = sendErrorToSentry(error, context);
  // The error's class name and a reference, never its message: a message can
  // quote whatever the failing code was holding.
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
  recordActivity("error", eventId === undefined ? name : `${name} · ref ${eventId.slice(0, 8)}`);
  return eventId;
}

export function trackEvent(name: string, properties?: TelemetryProperties): void {
  const cleanProperties =
    properties === undefined
      ? undefined
      : (redactTelemetryValue(properties) as TelemetryProperties);
  if (preferences().screenCounts) posthog?.capture(name, cleanProperties);
  sentry?.addBreadcrumb({ category: "product", message: name, data: cleanProperties });
}

export function trackScreen(pathname: string): void {
  const screen = telemetryRoute(pathname);
  recordActivity("screen", screen);
  if (!preferences().screenCounts) {
    // Counted nowhere; the breadcrumb below still helps a crash report.
  } else if (posthog === null) {
    if (pendingScreens.at(-1) !== screen) pendingScreens.push(screen);
    if (pendingScreens.length > MAX_PENDING) pendingScreens.shift();
  } else {
    posthog.screen(screen);
  }
  sentry?.addBreadcrumb({ category: "navigation", message: screen });
}

/** Stable database id only. Never send email, note path, context slug or name. */
export function setObservabilityUser(userId: string): void {
  if (currentUserId === userId) return;
  currentUserId = userId;
  sentry?.setUser({ id: userId });
  posthog?.identify(userId);
  for (const listener of userListeners) listener();
}

export function resetObservabilityUser(): void {
  const changed = currentUserId !== null;
  currentUserId = null;
  sentry?.setUser(null);
  posthog?.reset();
  if (changed) for (const listener of userListeners) listener();
}

const userListeners = new Set<() => void>();

/** Who is signed in, as telemetry knows it: the account id, or null. */
export function observedUserId(): string | null {
  return currentUserId;
}

export function onObservedUserChange(listener: () => void): () => void {
  userListeners.add(listener);
  return () => userListeners.delete(listener);
}

/**
 * Whether somebody is signed in, as far as telemetry knows — the root layout
 * sets the user on sign-in and resets it on sign-out. The broken page sits
 * outside the signed-in layout and reads this to offer a report only to
 * someone we can answer.
 */
export function hasObservedUser(): boolean {
  return currentUserId !== null;
}
