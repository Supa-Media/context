import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OP_PATHS, isBridgeRoute } from "./routes";

const validate = readFileSync(new URL("../container/validate.mjs", import.meta.url), "utf8");

describe("the public Worker door", () => {
  it("forwards every outbound op as a POST", () => {
    for (const op of OP_PATHS) {
      expect(isBridgeRoute("POST", `/${op}`), op).toBe(true);
    }
  });

  it("lists exactly the ops the container serves", () => {
    const served = [...validate.matchAll(/^\s{2}"?([a-z/]+)"?: \{\n\s+method: "POST"/gm)].map((match) => match[1]);
    expect([...OP_PATHS].sort()).toEqual([...served].sort());
  });

  it("serves the health, ready and attachment reads only as GET", () => {
    expect(isBridgeRoute("GET", "/health")).toBe(true);
    expect(isBridgeRoute("GET", "/ready")).toBe(true);
    expect(isBridgeRoute("GET", "/attachment/at_0_fixture")).toBe(true);
    expect(isBridgeRoute("POST", "/health")).toBe(false);
    expect(isBridgeRoute("GET", "/send/text")).toBe(false);
  });

  it("refuses the internal wake, the container's own routes, and anything unknown", () => {
    expect(isBridgeRoute("POST", "/__wake")).toBe(false);
    expect(isBridgeRoute("POST", "/start")).toBe(false);
    expect(isBridgeRoute("POST", "/ack")).toBe(false);
    expect(isBridgeRoute("GET", "/next")).toBe(false);
    expect(isBridgeRoute("POST", "/send/text/extra")).toBe(false);
    expect(isBridgeRoute("POST", "//send/text")).toBe(false);
    expect(isBridgeRoute("PUT", "/send/text")).toBe(false);
    expect(isBridgeRoute("GET", "/attachment/a/b")).toBe(false);
  });
});
