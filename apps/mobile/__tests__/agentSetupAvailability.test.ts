import { describe, expect, test } from "@jest/globals";
import { agentSetupAvailable } from "../features/console/layout/sheets";
import type { ConsoleData } from "../features/console/types";

function data({
  demo = false,
  kind = "personal",
  role = "owner",
  pinned = false,
}: {
  demo?: boolean;
  kind?: string;
  role?: string;
  pinned?: boolean;
} = {}): ConsoleData {
  return {
    demo,
    selectedContextId: "w1",
    contexts: [{ id: "w1", slug: "acme", displayName: "Acme", kind, role, pinned, status: "ok" }],
  } as unknown as ConsoleData;
}

describe("where the guided agent setup is available", () => {
  test("a shared workspace owner gets the same guide as an invited member", () => {
    expect(agentSetupAvailable(data({ kind: "shared", role: "owner" }))).toBe(true);
    expect(agentSetupAvailable(data({ kind: "shared", role: "member" }))).toBe(true);
  });

  test("the demo and pinned read-only context still cannot open it", () => {
    expect(agentSetupAvailable(data({ demo: true }))).toBe(false);
    expect(agentSetupAvailable(data({ kind: "shared", role: "member", pinned: true }))).toBe(false);
  });
});
