/**
 * `/tex/<handle>`'s rules, without a renderer: who the page opens for, how
 * and the gateway's answer is read. Where a touch lands on the page is
 * `texRemoteView.test.ts`; `texComputerRender.test.ts` proves the screen
 * uses both.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-10-11):
 *  1. `ownWorkspace` taking any personal workspace, not only one the person
 *     owns → "a member of somebody else's personal workspace is not its owner".
 *  2. `resolveTexPage` skipping the handle comparison → "somebody else's
 *     handle is not yours, and says nothing about their browser".
 *  3. `readFrame` returning the body as is → "an answer is read field by field".
 */

import { describe, expect, test } from "@jest/globals";
import {
  normalizeHandle,
  ownTexHref,
  readFrame,
  resolveTexPage,
  texComputerEndpoint,
  groupWordsOf,
  normalizeGroupWords,
  resolveTexGroupPage,
  texGroupHref,
  texHref,
  type WorkspaceRow,
} from "../features/tex/texComputer";
import { redactTelemetryText, telemetryRoute } from "../features/observability/privacy";

const SIGNED_IN = { isLoading: false, isAuthenticated: true };
const ROWS: WorkspaceRow[] = [
  { workspaceId: "ws_team", slug: "crew", kind: "shared", role: "owner" },
  { workspaceId: "ws_bola", slug: "bola", kind: "personal", role: "editor" },
  { workspaceId: "ws_seyi", slug: "seyi", kind: "personal", role: "owner" },
];

describe("who the page opens for", () => {
  test("waits for auth and for the workspace list", () => {
    expect(resolveTexPage({ handle: "seyi", auth: { isLoading: true, isAuthenticated: false }, workspaces: undefined })).toEqual({ kind: "wait" });
    expect(resolveTexPage({ handle: "seyi", auth: SIGNED_IN, workspaces: undefined })).toEqual({ kind: "wait" });
  });

  test("signed out goes to sign in and comes back to the same page", () => {
    expect(resolveTexPage({ handle: "seyi", auth: { isLoading: false, isAuthenticated: false }, workspaces: undefined })).toEqual({
      kind: "signIn",
      href: "/login?next=%2Ftex%2F%40seyi",
    });
  });

  test("the owner of the handle gets the page, for their own personal workspace", () => {
    expect(resolveTexPage({ handle: "@Seyi", auth: SIGNED_IN, workspaces: ROWS })).toEqual({ kind: "ready", handle: "seyi", workspaceId: "ws_seyi" });
  });

  test("somebody else's handle is not yours, and says nothing about their browser", () => {
    expect(resolveTexPage({ handle: "crew", auth: SIGNED_IN, workspaces: ROWS })).toEqual({ kind: "notYours", own: "seyi" });
  });

  test("a member of somebody else's personal workspace is not its owner", () => {
    expect(resolveTexPage({ handle: "bola", auth: SIGNED_IN, workspaces: ROWS })).toEqual({ kind: "notYours", own: "seyi" });
    expect(resolveTexPage({ handle: "bola", auth: SIGNED_IN, workspaces: [ROWS[1]!] })).toEqual({ kind: "notYours", own: null });
  });

  test("a group's address is always the signed-in person's own page, and its words must be words", () => {
    expect(resolveTexGroupPage({ words: "brave-otter-lamp", auth: SIGNED_IN, workspaces: ROWS })).toEqual({ kind: "ready", handle: "seyi", workspaceId: "ws_seyi" });
    expect(resolveTexGroupPage({ words: "brave-otter-lamp", auth: { isLoading: false, isAuthenticated: false }, workspaces: undefined })).toEqual({
      kind: "signIn",
      href: "/login?next=%2Ftex%2Fgroup%2Fbrave-otter-lamp",
    });
    expect(resolveTexGroupPage({ words: "brave-otter-lamp", auth: SIGNED_IN, workspaces: [ROWS[1]!] })).toEqual({ kind: "notYours", own: null });
    expect(resolveTexGroupPage({ words: "../x", auth: SIGNED_IN, workspaces: ROWS })).toEqual({ kind: "notFound" });
  });

  test("a handle outside the namespace is no page at all", () => {
    for (const raw of [null, "", "a", "has space", "x".repeat(33), "../seyi"]) {
      expect(normalizeHandle(raw)).toBeNull();
      expect(resolveTexPage({ handle: raw, auth: SIGNED_IN, workspaces: ROWS }).kind).toBe("notFound");
    }
  });
});

describe("the gateway's answer", () => {
  test("the routes are on the gateway's origin", () => {
    expect(texComputerEndpoint("https://mcp.context.lc/mcp", "frame")).toBe("https://mcp.context.lc/tex/computer");
    expect(texComputerEndpoint("https://mcp.context.lc/mcp", "input")).toBe("https://mcp.context.lc/tex/computer/input");
    expect(texComputerEndpoint("https://mcp.context.lc/mcp", "done")).toBe("https://mcp.context.lc/tex/computer/done");
    expect(texComputerEndpoint("https://mcp.context.lc/mcp", "stop")).toBe("https://mcp.context.lc/tex/computer/stop");
    expect(texComputerEndpoint("not a url", "frame")).toBeNull();
    expect(texHref("seyi")).toBe("/tex/@seyi");
    expect(texGroupHref("brave-otter-lamp")).toBe("/tex/group/brave-otter-lamp");
    expect(normalizeGroupWords(" Brave-Otter-Lamp ")).toBe("brave-otter-lamp");
    for (const bad of ["one", "a-b-c-d-e-f", "a_b", "../x", "", null]) expect(normalizeGroupWords(bad)).toBeNull();
    expect(groupWordsOf("tex/groups/brave-otter-lamp")).toBe("brave-otter-lamp");
    expect(groupWordsOf("tex/groups/brave-otter-lamp/about.md")).toBeNull();
  });

  test("an answer is read field by field", () => {
    const read = readFrame(200, { running: true, url: "https://chatgpt.com/", title: "ChatGPT", width: 1280, height: 860, frame: "QQ==", session: "SECRET" });
    expect(read).toEqual({ kind: "frame", frame: { running: true, url: "https://chatgpt.com/", title: "ChatGPT", width: 1280, height: 860, scale: 1, frame: "QQ==" } });
    // The picture's scale when the gateway says it, and 1 when it says nothing sane.
    const scaled = readFrame(200, { running: true, width: 1280, height: 860, scale: 0.6, frame: "QQ==" });
    expect(scaled.kind === "frame" && scaled.frame.running && scaled.frame.scale).toBe(0.6);
    for (const scale of ["0.6", -1, 0, Number.POSITIVE_INFINITY]) {
      const read = readFrame(200, { running: true, width: 1280, height: 860, scale, frame: "QQ==" });
      expect(read.kind === "frame" && read.frame.running && read.frame.scale).toBe(1);
    }
    expect(readFrame(200, { running: false })).toEqual({ kind: "frame", frame: { running: false } });
  });

  test("a refusal is told apart from an expired grant and a failure", () => {
    expect(readFrame(403, { error: "not_yours" })).toEqual({ kind: "notYours" });
    expect(readFrame(401, null)).toEqual({ kind: "expired" });
    expect(readFrame(403, { error: "forbidden" })).toEqual({ kind: "expired" });
    expect(readFrame(502, { error: "unavailable" })).toEqual({ kind: "failed" });
    expect(readFrame(200, { running: true, frame: "", width: 1, height: 1 })).toEqual({ kind: "failed" });
    expect(readFrame(200, { running: true, frame: "QQ==", width: 0, height: 1 })).toEqual({ kind: "failed" });
    expect(readFrame(200, [])).toEqual({ kind: "failed" });
  });
});

describe("telemetry", () => {
  test("never names whose agent computer it is", () => {
    expect(telemetryRoute("/tex/seyi")).toBe("/tex/:context");
    expect(telemetryRoute("/tex/@seyi/job/j_123")).toBe("/tex/:context/:value/:value");
    expect(redactTelemetryText("https://context.lc/tex/seyi")).toBe("https://context.lc/tex/:context");
    // A group's words name its home, so they go as the handle does.
    expect(telemetryRoute("/tex/group/brave-otter-lamp")).toBe("/tex/group/:context");
    expect(redactTelemetryText("https://context.lc/tex/group/brave-otter-lamp")).toBe("https://context.lc/tex/:context");
    expect(redactTelemetryText("https://context.lc/texts/abc")).toBe("https://context.lc/texts/:token");
  });
});

describe("bare /tex", () => {
  const signedIn = { isLoading: false, isAuthenticated: true };
  const mine = [
    { workspaceId: "ws_other", slug: "friend", kind: "personal", role: "member" },
    { workspaceId: "ws_me", slug: "seyi", kind: "personal", role: "owner" },
  ];

  // A runner's pairing link is made before anyone is known, so it has no handle.
  test("goes to the person's own page with the query kept", () => {
    expect(ownTexHref({ auth: signedIn, workspaces: mine }, "view=machines&code=NQJ-FSV")).toEqual({
      kind: "go",
      href: "/tex/@seyi?view=machines&code=NQJ-FSV",
    });
  });

  test("signed out, signs in and comes back to the same link", () => {
    const next = ownTexHref({ auth: { isLoading: false, isAuthenticated: false }, workspaces: undefined }, "view=machines");
    expect(next.kind).toBe("go");
    expect(next.kind === "go" && next.href).toContain(encodeURIComponent("/tex?view=machines"));
  });

  test("waits while sign-in or the workspaces load, and never lands on a workspace the person only joined", () => {
    expect(ownTexHref({ auth: { isLoading: true, isAuthenticated: false }, workspaces: undefined }, "")).toEqual({ kind: "wait" });
    expect(ownTexHref({ auth: signedIn, workspaces: undefined }, "")).toEqual({ kind: "wait" });
    expect(ownTexHref({ auth: signedIn, workspaces: [mine[0]] }, "")).toEqual({ kind: "go", href: null });
  });
});
