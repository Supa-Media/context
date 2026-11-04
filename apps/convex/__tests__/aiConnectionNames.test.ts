import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { holdsGrantedNames } from "../functions/lib/controlPlane/liveGrants";
import { holdsGrantedNames as objectHolds } from "../../mcp/src/workspaceStore/personRows.js";

/**
 * An AI connection holds its person's names; Context's own clients do not (2026-11-03,
 * `docs/decisions/privacy-and-sharing/ai-connection-names.md`). The rule is "an id not beginning `context_`", so a
 * first-party client named any other way would quietly be handed a person's names, sealed chat homes included. This
 * reads every `*_CLIENT_ID = "..."` constant in the control plane and the gateway and holds each to the prefix.
 */

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "_generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const ROOTS = [join(__dirname, "../functions"), join(__dirname, "../../mcp/src")];
const constants = ROOTS.flatMap((root) => sources(root)).flatMap((path) =>
  [...readFileSync(path, "utf8").matchAll(/\b([A-Z_]+_CLIENT_ID)\s*(?::\s*string\s*)?=\s*"([^"]+)"/g)].map((match) => ({ path, name: match[1], id: match[2] })),
);

describe("which connections hold a person's names", () => {
  test("every first-party client id begins context_, so none is mistaken for an AI connection", () => {
    expect(constants.length).toBeGreaterThan(10);
    for (const { path, name, id } of constants) expect(id.startsWith("context_"), `${name} in ${path}`).toBe(true);
  });

  test("the app and AI connections hold them; every other first-party client does not, on both sides", () => {
    for (const holds of [holdsGrantedNames, objectHolds]) {
      expect(holds("context_console")).toBe(true);
      expect(holds("mcp_abcdefghijklmnopqr")).toBe(true);
      for (const { id } of constants) if (id !== "context_console") expect(holds(id), id).toBe(false);
    }
  });
});
