import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { databaseNameFor } from "../functions/lib/d1";
import { meaningIndexNameFor } from "../functions/lib/vectorize";
import {
  FREE_MANAGED_STORAGE_ENV_VAR,
  freeManagedStorageSwitchedOn,
  managedBucketName,
  previewStorageIsFree,
  stagingStorageIsFree,
} from "../functions/lib/managedStorage";

/**
 * A per-branch preview shares the customer-data account with production and
 * staging, so the names it creates must be its own (`pr<N>-`), and the names
 * production and staging create must not move by a byte.
 *
 * Every name below is asserted against a literal, not against the function's
 * own output, so a change to the shared formula fails here rather than
 * silently renaming production's buckets and indexes.
 */

const WORKSPACE = "k17abc000000000000000000000000ab" as Id<"workspaces">;

/** A preview's variables for one pull request number; its router origin must name the same number. */
function previewOf(name: string): Record<string, string> {
  return {
    APP_ENV: "preview",
    PREVIEW_NAME: name,
    APP_ORIGIN: `https://context-router-${name}.example-sub.workers.dev`,
    CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud",
  };
}
const PREVIEW = previewOf("pr42");

const PRODUCTION = {
  APP_ENV: "production",
  APP_ORIGIN: "https://context.lc",
  CONVEX_CLOUD_URL: "https://prod-example-1.convex.cloud",
};

const STAGING = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://staging.context.lc",
  STAGING_CONVEX_DEPLOYMENT: "example-deployment",
  CONVEX_CLOUD_URL: "https://example-deployment.convex.cloud",
};

const NAME_VARIABLES = ["APP_ENV", "PREVIEW_NAME", "APP_ORIGIN", "CONVEX_CLOUD_URL", "STAGING_CONVEX_DEPLOYMENT", FREE_MANAGED_STORAGE_ENV_VAR];

/** Set exactly this deployment: every variable named here, and every other one cleared. */
function deployment(env: Record<string, string | undefined>): void {
  for (const name of NAME_VARIABLES) vi.stubEnv(name, env[name]);
}

afterEach(() => vi.unstubAllEnvs());

describe("production and staging names are unchanged", () => {
  test("managed bucket", () => {
    deployment(PRODUCTION);
    expect(managedBucketName(WORKSPACE)).toBe("ctx-k17abc000000000000000000000000ab");
    deployment(STAGING);
    expect(managedBucketName(WORKSPACE)).toBe("staging-ctx-k17abc000000000000000000000000ab");
  });

  test("search database", () => {
    deployment(PRODUCTION);
    expect(databaseNameFor(WORKSPACE)).toBe("context-search-k17abc000000000000000000000000ab");
    deployment(STAGING);
    expect(databaseNameFor(WORKSPACE)).toBe("context-search-k17abc000000000000000000000000ab");
  });

  test("meaning index", () => {
    deployment(PRODUCTION);
    expect(meaningIndexNameFor(WORKSPACE)).toBe("context-meaning-k17abc000000000000000000000000ab");
    deployment(STAGING);
    expect(meaningIndexNameFor(WORKSPACE)).toBe("context-meaning-k17abc000000000000000000000000ab");
  });

  test("a production deployment with the preview variables copied onto it keeps production's names", () => {
    deployment({ ...PRODUCTION, APP_ENV: "preview", PREVIEW_NAME: "pr42" });
    expect(managedBucketName(WORKSPACE)).toBe("ctx-k17abc000000000000000000000000ab");
    expect(databaseNameFor(WORKSPACE)).toBe("context-search-k17abc000000000000000000000000ab");
    expect(meaningIndexNameFor(WORKSPACE)).toBe("context-meaning-k17abc000000000000000000000000ab");
  });
});

describe("a preview's names carry its prefix", () => {
  test("managed bucket is pr42-ctx-<id>", () => {
    deployment(PREVIEW);
    expect(managedBucketName(WORKSPACE)).toBe("pr42-ctx-k17abc000000000000000000000000ab");
  });

  test("search database is pr42-context-search-<id>", () => {
    deployment(PREVIEW);
    expect(databaseNameFor(WORKSPACE)).toBe("pr42-context-search-k17abc000000000000000000000000ab");
  });

  test("meaning index is pr42-context-meaning-<id>", () => {
    deployment(PREVIEW);
    expect(meaningIndexNameFor(WORKSPACE)).toBe("pr42-context-meaning-k17abc000000000000000000000000ab");
  });

  test("no preview name equals a production or staging name for the same workspace", () => {
    deployment(PRODUCTION);
    const production = [managedBucketName(WORKSPACE), databaseNameFor(WORKSPACE), meaningIndexNameFor(WORKSPACE)];
    deployment(STAGING);
    const staging = [managedBucketName(WORKSPACE), databaseNameFor(WORKSPACE), meaningIndexNameFor(WORKSPACE)];
    deployment(PREVIEW);
    const preview = [managedBucketName(WORKSPACE), databaseNameFor(WORKSPACE), meaningIndexNameFor(WORKSPACE)];
    for (const [index, name] of preview.entries()) {
      expect(name).not.toBe(production[index]);
      expect(name).not.toBe(staging[index]);
    }
  });

  test("the largest preview number still fits every cap", () => {
    deployment(previewOf("pr9999999"));
    expect(managedBucketName(WORKSPACE).length).toBeLessThanOrEqual(63);
    expect(databaseNameFor(WORKSPACE)).toBe("pr9999999-context-search-k17abc000000000000000000000000ab");
    expect(databaseNameFor(WORKSPACE).length).toBeLessThanOrEqual(63);
    expect(meaningIndexNameFor(WORKSPACE)).toBe("pr9999999-context-meaning-k17abc000000000000000000000000ab");
    expect(meaningIndexNameFor(WORKSPACE).length).toBeLessThanOrEqual(64);
  });
});

describe("the prefix counts toward each cap and is never truncated away", () => {
  // Production fits a 48-character tail in the 63-character D1 cap. With the
  // preview prefix (10 characters) only 38 remain, so a 39-character id must be
  // refused on a preview, not cut down to fit.
  const TAIL_39 = "c".repeat(39);

  test("a 39-character id is accepted in production", () => {
    deployment(PRODUCTION);
    expect(databaseNameFor(TAIL_39)).toBe(`context-search-${TAIL_39}`);
    expect(meaningIndexNameFor(TAIL_39)).toBe(`context-meaning-${TAIL_39}`);
  });

  test("the same id is refused on a preview, never truncated into another name", () => {
    deployment(previewOf("pr9999999"));
    expect(() => databaseNameFor(TAIL_39)).toThrow(/at most 63 characters/);
    expect(() => meaningIndexNameFor(TAIL_39)).toThrow(/at most 64 long/);
  });
});

describe("the free tier on a preview", () => {
  test("is on for a preview, and staging's own test stays false there", () => {
    deployment(PREVIEW);
    expect(previewStorageIsFree()).toBe(true);
    expect(freeManagedStorageSwitchedOn()).toBe(true);
    expect(stagingStorageIsFree()).toBe(false);
  });

  test("is off for production, and for production with the preview variables copied onto it", () => {
    deployment({ ...PRODUCTION, FREE_MANAGED_STORAGE: "disabled" });
    expect(previewStorageIsFree()).toBe(false);
    deployment({ ...PRODUCTION, APP_ENV: "preview", PREVIEW_NAME: "pr42", FREE_MANAGED_STORAGE: "disabled" });
    expect(previewStorageIsFree()).toBe(false);
    expect(freeManagedStorageSwitchedOn()).toBe(false);
  });
});
