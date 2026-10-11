/**
 * `/tex/<handle>`'s rules, without a renderer: who the page opens for, how
 * the gateway's answer is read, and where a tap lands on the page.
 * `texComputerRender.test.ts` proves the screen uses them.
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
  readFrame,
  resolveTexPage,
  tapToPage,
  texComputerEndpoint,
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
      href: "/login?next=%2Ftex%2Fseyi",
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
    expect(texComputerEndpoint("https://mcp.context.lc/mcp", "stop")).toBe("https://mcp.context.lc/tex/computer/stop");
    expect(texComputerEndpoint("not a url", "frame")).toBeNull();
    expect(texHref("seyi")).toBe("/tex/seyi");
  });

  test("an answer is read field by field", () => {
    const read = readFrame(200, { running: true, url: "https://chatgpt.com/", title: "ChatGPT", width: 1280, height: 860, frame: "QQ==", session: "SECRET" });
    expect(read).toEqual({ kind: "frame", frame: { running: true, url: "https://chatgpt.com/", title: "ChatGPT", width: 1280, height: 860, frame: "QQ==" } });
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

describe("where a tap lands", () => {
  test("scales from the picture to the page's viewport", () => {
    expect(tapToPage({ x: 195, y: 100 }, { width: 390, height: 262 }, { width: 1280, height: 860 })).toEqual({ x: 640, y: 328.2 });
  });

  test("is clamped to the page and refused with no size", () => {
    expect(tapToPage({ x: 500, y: -4 }, { width: 390, height: 262 }, { width: 1280, height: 860 })).toEqual({ x: 1280, y: 0 });
    expect(tapToPage({ x: 1, y: 1 }, { width: 0, height: 0 }, { width: 1280, height: 860 })).toBeNull();
  });
});

describe("telemetry", () => {
  test("never names whose agent computer it is", () => {
    expect(telemetryRoute("/tex/seyi")).toBe("/tex/:context");
    expect(redactTelemetryText("https://context.lc/tex/seyi")).toBe("https://context.lc/tex/:context");
    expect(redactTelemetryText("https://context.lc/texts/abc")).toBe("https://context.lc/texts/:token");
  });
});
