import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>;
const staging = config.env.staging;

describe("the eval service's deployment", () => {
  it("has no public address in either environment: only the gateway's bindings reach it", () => {
    expect(config.workers_dev).toBe(false);
    expect(staging.workers_dev).toBe(false);
    for (const c of [config, staging]) {
      expect(c).not.toHaveProperty("routes");
      expect(c).not.toHaveProperty("route");
    }
  });

  it("keeps the Test Set in one SQLite Durable Object, and runs nothing on staging", () => {
    expect(config.name).toBe("context-tex-eval");
    expect(staging.name).toBe("context-tex-eval-staging");
    expect(config.durable_objects.bindings).toEqual([{ name: "TEST_SET", class_name: "TestSet" }]);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TestSet"] }]);
    expect(config.vars?.RUNS).toBeUndefined();
    expect(staging.vars).toEqual({ RUNS: "off" });
  });
});
