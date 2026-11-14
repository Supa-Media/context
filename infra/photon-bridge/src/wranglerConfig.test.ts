import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The file is JSONC: strip whole-line comments before parsing.
const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>;
const staging = config.env.staging;

describe("the bridge's deployment", () => {
  it("has no public address: no workers.dev and no routes, in either environment", () => {
    expect(config.workers_dev).toBe(false);
    expect(staging.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(staging).not.toHaveProperty("routes");
  });

  it("names the production and staging Workers", () => {
    expect(config.name).toBe("context-photon-bridge");
    expect(staging.name).toBe("context-photon-bridge-staging");
  });

  it("reaches the agent only through its PhotonEvents entrypoint", () => {
    expect(config.services).toEqual([
      { binding: "AGENT", service: "context-agent", entrypoint: "PhotonEvents" },
    ]);
    expect(staging.services).toEqual([
      { binding: "AGENT", service: "context-agent-staging", entrypoint: "PhotonEvents" },
    ]);
  });

  it("binds one Container-backed Durable Object class through a SQLite migration", () => {
    expect(config.durable_objects.bindings).toEqual([{ name: "PHOTON_BRIDGE", class_name: "PhotonBridge" }]);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["PhotonBridge"] }]);
    expect(config.containers).toEqual([
      { class_name: "PhotonBridge", image: "./Dockerfile", instance_type: "lite", max_instances: 1 },
    ]);
    expect(staging.containers).toEqual(config.containers);
  });

  it("wakes the object every minute in both environments", () => {
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(staging.triggers.crons).toEqual(["* * * * *"]);
  });

  it("does not bind storage or write deployment addresses into source", () => {
    expect(raw).not.toMatch(/"(?:r2_buckets|kv_namespaces|d1_databases|vars)"\s*:/);
    expect(raw).not.toMatch(/https:\/\//);
  });
});
