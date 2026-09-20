import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const worker = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("the container deployment", () => {
  it("binds the same container class through config and a SQLite DO migration", () => {
    expect(config).toMatch(/"class_name"\s*:\s*"EgressContainer"/);
    expect(config).toMatch(/"new_sqlite_classes"\s*:\s*\["EgressContainer"\]/);
    expect(config).toMatch(/"max_instances"\s*:\s*1/);
  });

  it("does not bind storage or put deployment addresses in source", () => {
    expect(config).not.toMatch(/"(?:r2_buckets|kv_namespaces|d1_databases|vars)"\s*:/);
    expect(config).not.toMatch(/workers\.dev|https:\/\//);
  });

  it("explicitly enables outbound internet on the low-level container start", () => {
    expect(worker).toMatch(/container\.start\(\{\s*enableInternet:\s*true\s*\}\)/);
  });
});
