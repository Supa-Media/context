/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, test } from "@jest/globals";

/**
 * An unfinished setup, picked back up at sign-in (`onboarding/resume.ts`).
 *
 * The rule is narrow on purpose, and every narrowing is a case here: no
 * binding at all (not a failing one), a session that came in by the front
 * door (not a followed link), asked once per sign-in (not every load), and
 * nothing decided while an answer is missing.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  RESUME_STORAGE_HREF,
  isFrontDoor,
  markResumeAsked,
  resetResumeAsked,
  resumeAsked,
  resumeAtLogin,
  sessionEntry,
} from "../features/onboarding/resume";
import { ResumeNotice } from "../features/onboarding/ResumeNotice";
import { landAfterSignIn } from "../features/auth/landing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetResumeAsked();
  window.localStorage.clear();
});

const OWNER = [{ workspaceId: "ws_mine", kind: "personal", role: "owner" }];
const base = {
  rows: OWNER,
  binding: null,
  asked: false,
  entry: "front" as const,
  pathname: "/console",
};

describe("who is sent back to finish", () => {
  test("an owner whose personal workspace has no storage, in by the front door", () => {
    expect(resumeAtLogin(base)).toEqual({ action: "redirect", href: RESUME_STORAGE_HREF });
    expect(RESUME_STORAGE_HREF).toBe("/welcome?resume=storage");
  });

  test("even once the console has forwarded them on to their last place", () => {
    // `/console` forwards within a tick; the binding lands later. The entry is
    // what is judged, so the front door still counts.
    expect(resumeAtLogin({ ...base, pathname: "/console/@mine" }).action).toBe("redirect");
  });

  test("not somebody with a binding, whatever state it is in", () => {
    for (const status of ["connected", "unverified", "error"]) {
      expect(resumeAtLogin({ ...base, binding: { status } })).toEqual({ action: "render" });
    }
  });

  test("not while the binding is loading or its query failed", () => {
    expect(resumeAtLogin({ ...base, binding: undefined })).toEqual({ action: "render" });
  });

  test("not while the workspace list is outstanding", () => {
    expect(resumeAtLogin({ ...base, rows: undefined })).toEqual({ action: "render" });
  });

  test("not a member of other people's workspaces with nothing of their own", () => {
    const rows = [
      { workspaceId: "ws_team", kind: "shared", role: "editor" },
      { workspaceId: "ws_theirs", kind: "personal", role: "member" },
      { workspaceId: "ws_ours", kind: "shared", role: "owner" },
    ];
    expect(resumeAtLogin({ ...base, rows })).toEqual({ action: "render" });
  });

  test("not somebody who signed in to follow a link", () => {
    expect(resumeAtLogin({ ...base, entry: "deep" })).toEqual({ action: "render" });
  });

  test("not twice in one sign-in", () => {
    expect(resumeAtLogin({ ...base, asked: true })).toEqual({ action: "render" });
  });

  test("never from /welcome or /invite, which is a loop and a lost invitation", () => {
    expect(resumeAtLogin({ ...base, pathname: "/welcome" })).toEqual({ action: "render" });
    expect(resumeAtLogin({ ...base, pathname: "/invite" })).toEqual({ action: "render" });
    expect(resumeAtLogin({ ...base, pathname: "/invite/tok_live" })).toEqual({ action: "render" });
  });
});

describe("how the session came in", () => {
  test("the front door is /console and nothing under it", () => {
    expect(isFrontDoor("/console")).toBe(true);
    expect(isFrontDoor("/console/")).toBe(true);
    expect(isFrontDoor("/console?x=1")).toBe(true);
    expect(isFrontDoor("/console/@seyi")).toBe(false);
    expect(isFrontDoor("/console/connections")).toBe(false);
  });

  test("is judged once, by the first path, until the next sign-in", () => {
    expect(sessionEntry("/console/@seyi?note=a.md")).toBe("deep");
    // The console forwarding, a click — none of it re-judges the entry.
    expect(sessionEntry("/console")).toBe("deep");
    resetResumeAsked();
    expect(sessionEntry("/console")).toBe("front");
  });
});

describe("asked once per sign-in", () => {
  test("survives a reload, and a sign-in clears it", () => {
    expect(resumeAsked()).toBe(false);
    markResumeAsked();
    expect(resumeAsked()).toBe(true);
    // A reload is a fresh module; what is left is what was written down.
    expect(window.localStorage.length).toBe(1);
    landAfterSignIn("/console", () => {});
    expect(resumeAsked()).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("the line above the resumed step", () => {
  test("says why they are here, and the way out works", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let later = 0;
    act(() => {
      root.render(createElement(ResumeNotice, { slug: "seyi", onLater: () => later++ }));
    });
    expect(container.textContent).toContain("@seyi is yours");
    expect(container.textContent).toContain("nowhere to keep notes yet");
    act(() => {
      (container.querySelector('[data-testid="welcome-resume-later"]') as HTMLElement).click();
    });
    expect(later).toBe(1);
    act(() => root.unmount());
    container.remove();
  });
});
