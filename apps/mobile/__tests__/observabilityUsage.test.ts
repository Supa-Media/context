/**
 * What the app sends for the Usage tab, and where it sends it.
 *
 *  1. **A button press is its fixed name and nothing else**, and only names in
 *     `USAGE_BUTTONS` exist — the type is the list.
 *  2. **Time in use needs a person**: a tab in front with no input for two
 *     minutes is not counted, and neither is a hidden one.
 *  3. **Events go through our own address** on our hosts, and to the
 *     configured host anywhere else, never to a host the page did not name.
 *  4. **Every event says which deployment it came from**, by hostname.
 */

import { describe, expect, test } from "@jest/globals";
import { USAGE_BUTTONS, isUsageButton } from "@context/shared";
import { IDLE_AFTER_MS, isActive } from "../features/observability/activeTime";
import { analyticsEnvironment, ingestHost, postHogWebOptions } from "../features/observability/runtime.web";

describe("button names", () => {
  test("every name is a fixed snake_case word, and its label is plain words", () => {
    for (const [name, label] of Object.entries(USAGE_BUTTONS)) {
      expect(name).toMatch(/^[a-z][a-z_]{1,39}$/);
      expect(label.length).toBeGreaterThan(0);
      expect(isUsageButton(name)).toBe(true);
    }
    expect(isUsageButton("toString")).toBe(false);
    expect(isUsageButton("__proto__")).toBe(false);
    expect(isUsageButton("Q3 board pay review")).toBe(false);
  });
});

describe("time in use", () => {
  const now = 1_000_000_000;
  test("counts only with the page in front and somebody at it", () => {
    expect(isActive({ visible: true, lastInputAt: now - 1_000, now })).toBe(true);
    expect(isActive({ visible: true, lastInputAt: now - IDLE_AFTER_MS, now })).toBe(true);
    expect(isActive({ visible: true, lastInputAt: now - IDLE_AFTER_MS - 1, now })).toBe(false);
    expect(isActive({ visible: false, lastInputAt: now, now })).toBe(false);
  });
});

describe("where events go", () => {
  test("our hosts send to their own /ingest", () => {
    for (const origin of ["https://context.lc", "https://tex.lc", "https://staging.context.lc", "https://tex-staging.context.lc"]) {
      expect(ingestHost("https://us.i.posthog.com", origin)).toBe(`${origin}/ingest`);
    }
  });

  test("anywhere else sends to the configured host, never to the page's", () => {
    for (const origin of ["http://localhost:8081", "https://customer-site.example", "http://context.lc", "not a url"]) {
      expect(ingestHost("https://us.i.posthog.com", origin)).toBe("https://us.i.posthog.com");
    }
    expect(ingestHost("https://us.i.posthog.com", undefined)).toBe("https://us.i.posthog.com");
  });

  test("the SDK is told the same, and links to PostHog's own app", () => {
    const options = postHogWebOptions({ apiKey: "phc_fixture", host: "https://us.i.posthog.com", replaySampleRate: 0, pageOrigin: "https://tex.lc" });
    expect(options.api_host).toBe("https://tex.lc/ingest");
    expect(options.ui_host).toBe("https://us.posthog.com");
    // Still nothing captured the app did not decide to capture.
    expect(options.autocapture).toBe(false);
  });

  test("the deployment is read from the hostname", () => {
    expect(analyticsEnvironment("context.lc")).toBe("production");
    expect(analyticsEnvironment("tex.lc")).toBe("production");
    expect(analyticsEnvironment("staging.context.lc")).toBe("staging");
    expect(analyticsEnvironment("localhost")).toBe("development");
    expect(analyticsEnvironment("context.lc.evil.example")).toBe("development");
  });
});
