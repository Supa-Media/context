import { describe, expect, test } from "@jest/globals";
import { cleanPostHogProperties, postHogWebOptions } from "../features/observability/runtime.web";

const options = (path: string) => postHogWebOptions({
  apiKey: "phc_fixture", host: "https://us.i.posthog.com", replaySampleRate: 0.1,
  pageOrigin: "https://tex.lc", pagePath: path,
});

describe("marketing interaction privacy", () => {
  test("only explicitly named controls on the public landing get autocapture and heatmaps", () => {
    expect(options("/").autocapture).toEqual({ dom_event_allowlist: ["click"], css_selector_allowlist: ["[data-analytics-action]"] });
    expect(options("/").capture_heatmaps).toBe(true);
    expect(options("/").mask_all_text).toBe(true);
    expect(options("/").mask_all_element_attributes).toBe(true);
    for (const path of ["/console/@private", "/note/@private/payroll.md", "/text", "/waitlist", "/login"]) {
      expect(options(path).autocapture).toBe(false);
      expect(options(path).capture_heatmaps).toBe(false);
    }
  });
  test("SDK-added titles, referrers, element metadata and arbitrary DOM properties never leave", () => {
    const clean = cleanPostHogProperties({
      token: "stale", $current_url: "https://tex.lc/console/@private?note=payroll.md#code=123",
      $referrer: "https://example.com/private/payroll?secret=123", $title: "Private payroll",
      $elements: [{ tag_name: "a", attr__href: "sms:+15555550123", $el_text: "Private payroll" }],
      $elements_chain: 'a.private-payroll[href="sms:+15555550123"]',
      $el_text: "Private payroll", $external_click_url: "sms:+15555550123",
      private_dom_attribute: "Private payroll", distinct_id: "anonymous-fixture", app_env: "production",
    }, "phc_fixture", "$autocapture");
    expect(JSON.stringify(clean)).not.toMatch(/private|payroll|15555550123|code=123|secret=123/i);
    expect(clean.$current_url).toBe("https://tex.lc/console/:context");
    expect(clean.$referrer).toBe("https://example.com");
    expect(clean.distinct_id).toBe("anonymous-fixture");
    expect(clean.token).toBe("phc_fixture");
    expect(clean.app_env).toBe("production");
  });
  test("pageviews remain explicit while pageleaves enable scroll and exit analysis", () => {
    expect(options("/").capture_pageview).toBe(false);
    expect(options("/").capture_pageleave).toBe(true);
  });
});

describe("buffered heatmap URLs", () => {
  test("a SPA visit never leaks a private route or a homepage query through heatmap dictionary keys", () => {
    const clean = cleanPostHogProperties({ $heatmap_data: {
      "https://tex.lc/?code=secret#token=secret": [{ x: 12, y: 24, type: "click", text: "private payroll" }],
      "https://tex.lc/console/@private?note=payroll.md": [{ x: 50, y: 60, type: "click" }],
    } }, "phc_fixture", "$$heatmap");
    expect(clean.$heatmap_data).toEqual({ "https://tex.lc/": [{ x: 12, y: 24, type: "click" }] });
    expect(JSON.stringify(clean)).not.toMatch(/secret|private|payroll/);
  });
});

test("initial person properties keep no private URL or document title", () => {
  const clean = cleanPostHogProperties({ $set_once: {
    $initial_current_url: "https://context.lc/note/@private/payroll.md?code=secret",
    $initial_referrer: "https://example.com/payroll?token=secret",
    $title: "Private payroll", harmless: true,
  } }, "phc_fixture");
  expect(JSON.stringify(clean)).not.toMatch(/private|payroll|secret/);
  expect(clean.$set_once).toEqual({
    $initial_current_url: "https://context.lc/note/:context",
    $initial_referrer: "https://example.com", harmless: true,
  });
});
