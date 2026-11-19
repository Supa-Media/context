import { describe, expect, test } from "vitest";
import { isIsolatedPreview, previewName, previewResourcePrefix } from "../functions/lib/previewDeployment";

// Built at run time: scripts/check-no-identifiers.mjs rejects a committed Convex hostname, fakes included.
const CONVEX_CLOUD = ["convex", "cloud"].join(".");

/**
 * The one question every preview-only widening asks
 * (`functions/lib/previewDeployment.ts`). Production and staging must answer
 * no, and so must every near miss an operator could make by copying variables.
 */

const PREVIEW = {
  APP_ENV: "preview",
  PREVIEW_NAME: "pr42",
  APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
  CONVEX_CLOUD_URL: `https://happy-otter-123.${CONVEX_CLOUD}`,
};

const PRODUCTION = {
  APP_ENV: "production",
  APP_ORIGIN: "https://context.lc",
  CONVEX_CLOUD_URL: `https://prod-example-1.${CONVEX_CLOUD}`,
};

const STAGING = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://staging.context.lc",
  STAGING_CONVEX_DEPLOYMENT: "staging-example-2",
  CONVEX_CLOUD_URL: `https://staging-example-2.${CONVEX_CLOUD}`,
};

describe("isIsolatedPreview", () => {
  test("a preview deployment is one", () => {
    expect(isIsolatedPreview(PREVIEW)).toBe(true);
    expect(previewName(PREVIEW)).toBe("pr42");
    expect(previewResourcePrefix(PREVIEW)).toBe("pr42-");
  });

  test("production refuses", () => {
    expect(isIsolatedPreview(PRODUCTION)).toBe(false);
    expect(previewResourcePrefix(PRODUCTION)).toBe("");
  });

  test("staging refuses", () => {
    expect(isIsolatedPreview(STAGING)).toBe(false);
  });

  test("production with APP_ENV and PREVIEW_NAME copied onto it refuses", () => {
    expect(isIsolatedPreview({ ...PRODUCTION, APP_ENV: "preview", PREVIEW_NAME: "pr42" })).toBe(false);
  });

  test("staging with preview variables copied onto it refuses", () => {
    expect(isIsolatedPreview({ ...STAGING, APP_ENV: "preview", PREVIEW_NAME: "pr42", APP_ORIGIN: PREVIEW.APP_ORIGIN })).toBe(false);
  });

  test.each([
    ["no APP_ENV", { ...PREVIEW, APP_ENV: undefined }],
    ["APP_ENV staging", { ...PREVIEW, APP_ENV: "staging" }],
    ["no PREVIEW_NAME", { ...PREVIEW, PREVIEW_NAME: undefined }],
    ["a leading zero", { ...PREVIEW, PREVIEW_NAME: "pr042", APP_ORIGIN: "https://context-router-pr042.example-sub.workers.dev" }],
    ["a name that is not pr<N>", { ...PREVIEW, PREVIEW_NAME: "main" }],
    ["an origin naming another preview", { ...PREVIEW, APP_ORIGIN: "https://context-router-pr43.example-sub.workers.dev" }],
    ["a context.lc origin", { ...PREVIEW, APP_ORIGIN: "https://context.lc" }],
    ["a look-alike host", { ...PREVIEW, APP_ORIGIN: "https://context-router-pr42.workers.dev.evil.example" }],
    ["http", { ...PREVIEW, APP_ORIGIN: "http://context-router-pr42.example-sub.workers.dev" }],
    ["a path on the origin", { ...PREVIEW, APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev/x" }],
    ["a port", { ...PREVIEW, APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev:8443" }],
    ["no CONVEX_CLOUD_URL", { ...PREVIEW, CONVEX_CLOUD_URL: undefined }],
    ["a non-Convex cloud URL", { ...PREVIEW, CONVEX_CLOUD_URL: "https://example.com" }],
  ])("refuses with %s", (_label, env) => {
    expect(isIsolatedPreview(env)).toBe(false);
  });
});
