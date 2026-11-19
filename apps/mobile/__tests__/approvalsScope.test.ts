/**
 * Which contexts the approvals in the Tex chat are listed from (`features/approvals/scope.ts`).
 *
 * The pinned context is reach, not membership: the control plane refuses a
 * console grant for it, so it must never be asked (google-review, 2026-11-19).
 */

import { describe, expect, test } from "@jest/globals";
import { approvalsScope } from "../features/approvals/scope";

describe("approvalsScope", () => {
  test("the pinned row is left out of the workspaces asked about", () => {
    const scope = approvalsScope(
      [{ id: "ws_review" }, { id: "ws_pinned", pinned: true }],
      "ws_review",
    );
    expect(scope.workspaceIds).toEqual(["ws_review"]);
  });

  test("a selected context that is not pinned is the shown workspace", () => {
    const scope = approvalsScope(
      [{ id: "ws_a" }, { id: "ws_b" }],
      "ws_b",
    );
    expect(scope).toEqual({ workspaceId: "ws_b", workspaceIds: ["ws_a", "ws_b"] });
  });

  test("a selected pinned context falls back to the first reachable one", () => {
    const scope = approvalsScope(
      [{ id: "ws_pinned", pinned: true }, { id: "ws_a" }, { id: "ws_b" }],
      "ws_pinned",
    );
    expect(scope).toEqual({ workspaceId: "ws_a", workspaceIds: ["ws_a", "ws_b"] });
  });

  test("with only the pinned context there is nothing to ask about", () => {
    const scope = approvalsScope([{ id: "ws_pinned", pinned: true }], "ws_pinned");
    expect(scope).toEqual({ workspaceId: null, workspaceIds: [] });
  });

  test("with no selection the first reachable context is shown", () => {
    const scope = approvalsScope(
      [{ id: "ws_pinned", pinned: true }, { id: "ws_a" }, { id: "ws_b" }],
      null,
    );
    expect(scope).toEqual({ workspaceId: "ws_a", workspaceIds: ["ws_a", "ws_b"] });
  });

  test("a row without a pinned flag counts as reachable", () => {
    const scope = approvalsScope([{ id: "ws_a" }, { id: "ws_b", pinned: false }], "ws_a");
    expect(scope).toEqual({ workspaceId: "ws_a", workspaceIds: ["ws_a", "ws_b"] });
  });
});
