/**
 * A Lab draft made from main carries main's whole graph to `/gateway/tex/dev` (2026-11-17: main's graph passed 64 KB
 * escaped (66 KB), and every `tex_dev create` answered "could not be reached"). Sabotage: the route back on the 64 KB
 * default (no cap passed in `http.ts`) fails "http.ts gives the route that cap".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_TEX_DEV_REQUEST_BYTES } from "../../functions/lib/gatewayAuth";
import { MAX_JSON } from "../../functions/texLab";
import { TEX_CONFIG } from "@context/shared/src/texConfig.cjs";

const bodyOf = (graph: string) => JSON.stringify({ accessToken: "t".repeat(64), action: "create", args: { name: "A draft", from: "main", graph, base: "0".repeat(15) } });

describe("the tex_dev route's request cap", () => {
  it("a draft made from main fits the route's cap", () => {
    const body = bodyOf(JSON.stringify(TEX_CONFIG));
    expect(body.length).toBeLessThan(MAX_TEX_DEV_REQUEST_BYTES);
  });

  it("so does the biggest draft a row can hold, escaped", () => {
    expect(bodyOf("\"".repeat(MAX_JSON)).length).toBeLessThan(MAX_TEX_DEV_REQUEST_BYTES);
  });

  it("http.ts gives the route that cap", () => {
    const http = readFileSync(new URL("../../http.ts", import.meta.url), "utf8");
    expect(http).toMatch(/path === "\/gateway\/tex\/dev" \? MAX_TEX_DEV_REQUEST_BYTES/);
  });
});
