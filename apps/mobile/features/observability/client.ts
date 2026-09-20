import { redactTelemetryText, redactTelemetryValue, telemetryRoute } from "./privacy";
import {
  createAnalyticsClient,
  hasSentryNativeRuntime,
} from "./runtime";
import type { AnalyticsClient, TelemetryProperties } from "./types";

export type { TelemetryProperties } from "./types";

interface ErrorContext {
  componentStack?: string | null;
  mechanism?: string;
}

type SentrySdk = typeof import("@sentry/react-native");
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
  const sdk = await import("@sentry/react-native");
  sdk.init({
    dsn: sentryDsn,
    enabled: true,
    environment: __DEV__ ? "development" : "production",
    sendDefaultPii: false,
    enableAutoSessionTracking: true,
    tracesSampleRate: sampleRate(
      process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      __DEV__ ? 1 : 0.1,
    ),
    beforeSend: (event) => cleanSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => cleanSentryEvent(breadcrumb),
  });
  sentry = sdk;
  if (currentUserId !== null) sdk.setUser({ id: currentUserId });
  for (const item of pendingErrors.splice(0)) sendErrorToSentry(item.error, item.context);
}

async function initPostHog(): Promise<void> {
  if (posthogKey === "") return;
  const client = await createAnalyticsClient({
    apiKey: posthogKey,
    host: posthogHost,
    replaySampleRate: sampleRate(
      process.env.EXPO_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE,
      __DEV__ ? 1 : 0.1,
    ),
  });
  await client.ready();
  posthog = client;
  if (currentUserId !== null) client.identify(currentUserId);
  for (const screen of pendingScreens.splice(0)) client.screen(screen);
}

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

function sendErrorToSentry(error: unknown, context?: ErrorContext): void {
  if (sentry === null) {
    pendingErrors.push({ error, context });
    if (pendingErrors.length > MAX_PENDING) pendingErrors.shift();
    return;
  }
  sentry.withScope((scope) => {
    if (context?.mechanism) scope.setTag("context.mechanism", context.mechanism);
    if (context?.componentStack) {
      scope.setContext("react", { componentStack: redactTelemetryText(context.componentStack) });
    }
    if (posthog !== null) scope.setTag("posthog.session_id", posthog.getSessionId());
    sentry?.captureException(error);
  });
}

export function reportError(error: unknown, context?: ErrorContext): void {
  sendErrorToSentry(error, context);
}

export function trackEvent(name: string, properties?: TelemetryProperties): void {
  const cleanProperties =
    properties === undefined
      ? undefined
      : (redactTelemetryValue(properties) as TelemetryProperties);
  posthog?.capture(name, cleanProperties);
  sentry?.addBreadcrumb({ category: "product", message: name, data: cleanProperties });
}

export function trackScreen(pathname: string): void {
  const screen = telemetryRoute(pathname);
  if (posthog === null) {
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
}

export function resetObservabilityUser(): void {
  currentUserId = null;
  sentry?.setUser(null);
  posthog?.reset();
}
