import { describe, expect, test } from "@jest/globals";
import { postHogWebOptions } from "../features/observability/runtime.web";

/** By explicit path: a bare import is the web half, which this suite resolves first. */
const { postHogNativeOptions } =
  require("../features/observability/runtime.ts") as typeof import("../features/observability/runtime");

/**
 * THE SESSION REPLAY MASKS, WHICH ARE THE ONLY THING KEEPING NOTE BODIES OUT OF
 * A THIRD PARTY'S RECORDER.
 *
 * `observabilityPrivacy.test.ts` is thorough about `privacy.ts` and about the
 * **native** decision — it asserts `enableSessionReplay: false` and that the
 * replay plugin is not a dependency. The native docblock says why, and that
 * sentence is the whole argument:
 *
 * > PostHog can mask native inputs, images and WebViews, but not every rendered
 * > React Native text label. Context names and other private UI therefore make
 * > native replay unsafe until the SDK has a global text mask.
 *
 * **On web, replay is ON** — `disable_session_recording: false` — and what
 * makes that acceptable is precisely the global text mask the native comment
 * says React Native lacks: `maskTextSelector: "*"`, alongside `maskAllInputs`,
 * a block list and two masking functions. So the web half is safe *because of
 * that configuration object*, and **nothing in the suite read a single field of
 * it.**
 *
 * What that costs if a field goes is not abstract. rrweb records the DOM of a
 * note-taking app: the text of whatever note is open, the tree of file names,
 * the context's name — continuously, to an analytics vendor, for the sampled
 * share of sessions.
 *
 * ## Why the options are now a function, and why that is the finding
 *
 * They were a literal inside `createAnalyticsClient`, whose first line is
 * `await import("posthog-js")`. **A dynamic import is the one construct this
 * suite's transform cannot reduce to a `require`** — it fails with *"A dynamic
 * import callback was invoked without --experimental-vm-modules"* — so no test
 * could reach past that line, whatever it mocked. There are exactly **three**
 * `await import(` sites in this whole app and **all three are these two files
 * and their Sentry sibling**: the one construct the harness cannot execute is
 * used only where the telemetry privacy configuration lives. That is the
 * mechanical reason this was unheld, rather than an oversight.
 *
 * Returning the object changes nothing about it and makes it a value. Reading
 * what is actually handed to the SDK is the same move
 * `pluginSandboxNativeBoundary.test.ts` makes for a WebView's props, and it
 * replaces the weakest assertion in the neighbouring file: `expect(runtime)
 * .toContain("enableSessionReplay: false")` over the file's **source text**,
 * which passes if the line moves into a comment and cannot see the value being
 * overridden afterwards.
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens |
 * | --- | --- |
 * | drop `maskTextSelector: "*"` | **1** |
 * | `maskAllInputs: false` | **1** |
 * | let `maskAttributeFn` pass `href` through | **1** |
 * | `maskCapturedNetworkRequestFn` keeps the response body | **1** |
 * | stop sanitising the captured request's URL | **1** |
 * | `recordCrossOriginIframes: true` | **1** |
 * | drop `img` from `blockSelector` | **1** |
 * | `autocapture: true` | **1** |
 * | stop sanitising `get_current_url` | **1** |
 * | turn replay on for native | **2** |
 *
 * **Every web row was 0 before this file**, measured together rather than
 * assumed: with the text mask deleted, inputs unmasked, cross-origin frames
 * recorded and autocapture on — a recorder taking legible note text — the
 * pre-existing suite is 326 suites and 6,192 tests, fully green.
 *
 * The native row is 2 because its source-text assertion was **repaired in the
 * same commit**, and the repair was prompted by measurement rather than taste:
 * at 1, the sabotage should have reddened the neighbouring `toContain` test
 * too. It did not — because **the docblock above `postHogNativeOptions` quotes
 * the literal**, so the string match passed while the option itself was
 * `true`. A file's own comment satisfying its own guard is as vacuous as a
 * guard gets, and it took writing one by accident to see it.
 */

const OPTIONS = {
  apiKey: "phc_public_write_only_key",
  host: "https://telemetry.example",
  replaySampleRate: 0.1,
};

/** A URL of the shape `observabilityPrivacy.test.ts` documents as a real leak. */
const NOTE_URL = "https://context.lc/note/@supa/1-projects/2026-pay-review.md";

const web = () => postHogWebOptions(OPTIONS);
const replay = () => web().session_recording;

describe("the web recorder is configured to record nothing legible", () => {
  test("replay is on, and every text node is masked", () => {
    /*
      The premise first, so the rest is not read as protecting something that is
      switched off. Web deliberately runs the recorder that native refuses.
    */
    expect(web().disable_session_recording).toBe(false);

    // And the reason that is allowed: the global text mask the native comment
    // says the React Native SDK lacks. `"*"` is every element, which is the
    // only correct selector for an app whose rendered text IS the content.
    expect(replay().maskTextSelector).toBe("*");
    expect(replay().maskAllInputs).toBe(true);
  });

  test("images, canvases and file pickers are not recorded at all", () => {
    // Masking replaces text; a drawing canvas or a pasted image has no text to
    // replace, so those are blocked outright rather than masked.
    for (const selector of ["img", "video", "canvas", "input[type=file]"]) {
      expect(replay().blockSelector).toContain(selector);
    }
  });

  test("and a cross-origin frame is never recorded, which is where plugins run", () => {
    // Third-party plugin bundles run in an opaque-origin iframe. Recording it
    // would pull whatever the plugin drew into our vendor's replay.
    expect(replay().recordCrossOriginIframes).toBe(false);
  });

  test("an attribute that could carry a note's title is masked", () => {
    /*
      `maskTextSelector` covers text nodes, not attributes — and react-native-
      web renders `nativeID` to `id`, `testID` to `data-testid`,
      `accessibilityLabel` to `aria-label` and a link to `href`, each of which
      is a place a path or a title reaches the DOM.
    */
    const mask = replay().maskAttributeFn;

    for (const name of [
      "href",
      "title",
      "aria-label",
      "data-testid",
      "id",
      "value",
      "alt",
      "placeholder",
      "name",
      "src",
    ]) {
      expect(mask(name, NOTE_URL)).toBe("[masked]");
    }

    // Anti-vacuity: a function that masked everything would satisfy the loop
    // above while saying nothing about which attributes it actually names.
    expect(mask("role", "button")).toBe("button");
  });

  test("a captured request keeps neither its body nor its headers, nor its path", () => {
    const masked = replay().maskCapturedNetworkRequestFn({
      name: NOTE_URL,
      requestHeaders: { authorization: "Bearer a-real-token" },
      requestBody: "the note body on its way to the bucket",
      responseHeaders: { "set-cookie": "session=abc" },
      responseBody: "the note body coming back",
      // The timing fields a `PerformanceEntry` carries: kept, and the reason
      // this is a mask rather than a drop — the point of capturing a request
      // at all is how long it took.
      duration: 12,
      entryType: "resource",
      startTime: 100,
    });

    expect(masked.requestHeaders).toBeUndefined();
    expect(masked.requestBody).toBeUndefined();
    expect(masked.responseHeaders).toBeUndefined();
    expect(masked.responseBody).toBeUndefined();

    // The URL is not a header, and it carries the context handle and the note's
    // whole path — the failure the route allowlist exists for, arriving by a
    // second door.
    expect(String(masked.name)).not.toContain("supa");
    expect(String(masked.name)).not.toContain("pay-review");
    expect(String(masked.name)).not.toContain("1-projects");

    // And the timing survives, so this is masking rather than discarding.
    expect(masked.duration).toBe(12);
  });

  test("$current_url on every event is a route, never an address", () => {
    const seen = web().get_current_url(NOTE_URL);

    expect(seen).not.toContain("supa");
    expect(seen).not.toContain("pay-review");
    // The origin is kept on purpose — it is the deployment, not the customer.
    expect(seen.startsWith("https://context.lc/note/")).toBe(true);
  });

  test("nothing is captured that the app did not decide to capture", () => {
    /*
      Autocapture sends clicks and form interactions with element text and
      attributes attached, on a path that never goes through `trackEvent` and
      therefore never meets `redactTelemetryValue`. `before_send` is the second
      line, asserted here as wired rather than merely existing.
    */
    expect(web().autocapture).toBe(false);
    expect(web().capture_pageview).toBe(false);
    expect(web().capture_pageleave).toBe(false);
    expect(web().person_profiles).toBe("identified_only");

    expect(web().before_send(null)).toBeNull();


    const sent = web().before_send({
      uuid: "00000000-0000-4000-8000-000000000000",
      event: "$pageview",
      properties: { token: "stale", nested: { secret: "customer-secret" } },
    });
    expect(sent?.properties.nested).toEqual({ secret: "[redacted]" });
    // PostHog's own routing field is restored from the configuration closure
    // rather than trusted from the event.
    expect(sent?.properties.token).toBe(OPTIONS.apiKey);
  });
});

describe("the native recorder is not configured, it is off", () => {
  test("replay stays off, read from the options rather than from the source text", () => {
    const options = postHogNativeOptions({ host: OPTIONS.host });

    expect(options.enableSessionReplay).toBe(false);
    expect(options.errorTracking).toEqual({ autocapture: false });
    expect(options.capturePushNotificationOpened).toBe(false);
    expect(options.capturePushNotificationSubscriptions).toBe(false);

    // Anti-vacuity: the object really is the one the constructor gets, so an
    // empty return would not satisfy this.
    expect(options.host).toBe(OPTIONS.host);
  });

  test("and there is no replay configuration for a sample rate to reach", () => {
    // `replaySampleRate` stays in the cross-platform constructor contract so
    // web and native share one caller, and it reaches nothing here. If a future
    // edit wires it to a native replay switch, the assertion above is what
    // catches it.
    expect(postHogNativeOptions({ host: OPTIONS.host })).not.toHaveProperty(
      "sessionReplayConfig",
    );
  });
});
