import { describe, expect, jest, test } from "@jest/globals";
import { cleanPostHogProperties, postHogWebOptions, setWebCapturing } from "../features/observability/runtime.web";

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

test("opting out stops heatmap listeners and discards buffered clicks immediately", () => {
  const client = { set_config: jest.fn(), opt_in_capturing: jest.fn(), opt_out_capturing: jest.fn() };
  setWebCapturing(client, false, "/");
  expect(client.set_config).toHaveBeenLastCalledWith({ capture_heatmaps: false, autocapture: false });
  expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
  setWebCapturing(client, true, "/console/@private");
  expect(client.set_config).toHaveBeenLastCalledWith({ capture_heatmaps: false, autocapture: false });
  setWebCapturing(client, true, "/");
  expect(client.set_config).toHaveBeenLastCalledWith({
    capture_heatmaps: true,
    autocapture: { dom_event_allowlist: ["click"], css_selector_allowlist: ["[data-analytics-action]"] },
  });
});

test("pageleave and SPA pageview previous-path properties are sanitized too", () => {
  const clean = cleanPostHogProperties({
    $prev_pageview_pathname: "/console/@private",
    $initial_pathname: "/note/@private/payroll.md",
    $prev_pageview_duration: 12,
  }, "phc_fixture");
  expect(clean.$prev_pageview_pathname).toBe("/console/:context");
  expect(clean.$initial_pathname).toBe("/note/:context");
  expect(clean.$prev_pageview_duration).toBe(12);
  expect(JSON.stringify(clean)).not.toMatch(/private|payroll/);
});
