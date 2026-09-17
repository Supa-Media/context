import { NativeModules } from "react-native";
import type { AnalyticsClient } from "./types";

/** New native builds have the module; old builds receiving an OTA update do not. */
export function hasSentryNativeRuntime(): boolean {
  return NativeModules.RNSentry !== undefined;
}

/**
 * The native client's options, as a value — see the web half for why.
 *
 * The decision that matters is `enableSessionReplay: false`, and it was held
 * only by a test grepping this file's **source text** for that literal. A
 * string match passes if the line moves into a comment and cannot see the value
 * being overridden afterwards; the option is returned here so the assertion can
 * read what the SDK is actually handed.
 */
export function postHogNativeOptions({ host }: { host: string }) {
  return {
    host,
    captureAppLifecycleEvents: true,
    // PostHog can mask native inputs, images and WebViews, but not every
    // rendered React Native text label. Context names and other private UI
    // therefore make native replay unsafe until the SDK has a global text mask.
    enableSessionReplay: false,
    errorTracking: { autocapture: false },
    capturePushNotificationOpened: false,
    capturePushNotificationSubscriptions: false,
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
  const { PostHog } = await import("posthog-react-native");
  const client = new PostHog(apiKey, postHogNativeOptions({ host }));

  // Kept in the cross-platform constructor contract so web and native share
  // one caller. Native replay is deliberately disabled above.
  void replaySampleRate;

  return {
    ready: () => client.ready(),
    capture: (name, properties) => {
      void client.capture(name, properties);
    },
    screen: (name) => {
      void client.screen(name);
    },
    identify: (userId) => client.identify(userId),
    reset: () => client.reset(),
    getSessionId: () => client.getSessionId(),
  };
}
