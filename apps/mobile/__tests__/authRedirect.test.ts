import { describe, expect, test } from "@jest/globals";
import {
  CONSOLE_ROUTE,
  LOGIN_ROUTE,
  landingCtaHref,
  landingCtaLabel,
  resolveAuthRoute,
  resolveProtectedRoute,
  safeNextRoute,
} from "../features/auth/redirect";

const loading = { isLoading: true, isAuthenticated: false };
const signedOut = { isLoading: false, isAuthenticated: false };
const signedIn = { isLoading: false, isAuthenticated: true };

describe("protected routes", () => {
  test("waits while auth is still restoring, rather than flashing the login screen", () => {
    expect(resolveProtectedRoute(loading)).toEqual({ action: "wait" });
  });

  test("sends a signed-out visitor to sign in", () => {
    expect(resolveProtectedRoute(signedOut)).toEqual({
      action: "redirect",
      href: LOGIN_ROUTE,
    });
  });

  test("renders for a signed-in session", () => {
    expect(resolveProtectedRoute(signedIn)).toEqual({ action: "render" });
  });

  test("a stale token that is still loading is never treated as authenticated", () => {
    expect(resolveProtectedRoute({ isLoading: true, isAuthenticated: true })).toEqual({
      action: "wait",
    });
  });
});

describe("auth routes", () => {
  test("waits while auth resolves", () => {
    expect(resolveAuthRoute(loading)).toEqual({ action: "wait" });
  });

  test("shows the form to a signed-out visitor", () => {
    expect(resolveAuthRoute(signedOut)).toEqual({ action: "render" });
  });

  test("bounces an existing session to the console", () => {
    expect(resolveAuthRoute(signedIn)).toEqual({
      action: "redirect",
      href: CONSOLE_ROUTE,
    });
  });

  test("follows a safe next target", () => {
    expect(resolveAuthRoute(signedIn, "/console/storage")).toEqual({
      action: "redirect",
      href: "/console/storage",
    });
  });
});

describe("safeNextRoute", () => {
  test("accepts a rooted in-app path", () => {
    expect(safeNextRoute("/console/browse")).toBe("/console/browse");
    expect(safeNextRoute("/console?tab=1")).toBe("/console?tab=1");
  });

  test.each([
    ["https://evil.example/steal", "an absolute URL"],
    ["//evil.example/steal", "a protocol-relative URL"],
    ["/\\evil.example", "a backslash-disguised protocol-relative URL"],
    ["\\\\evil.example", "a UNC-style path"],
    ["javascript:alert(1)", "a javascript: payload"],
    ["console", "an unrooted path"],
    ["", "an empty string"],
    ["   ", "whitespace"],
    ["/console\nLocation: https://evil.example", "an embedded newline"],
    ["/console\tx", "an embedded tab"],
  ])("refuses %s (%s)", (candidate) => {
    expect(safeNextRoute(candidate)).toBe(CONSOLE_ROUTE);
  });

  test("refuses non-strings", () => {
    expect(safeNextRoute(undefined)).toBe(CONSOLE_ROUTE);
    expect(safeNextRoute(null)).toBe(CONSOLE_ROUTE);
    expect(safeNextRoute(123 as unknown as string)).toBe(CONSOLE_ROUTE);
  });
});

describe("landing call to action", () => {
  test("invites a visitor to create a context", () => {
    expect(landingCtaHref(signedOut)).toBe(LOGIN_ROUTE);
    expect(landingCtaLabel(signedOut)).toBe("Create your context");
  });

  test("offers a signed-in visitor their console instead", () => {
    expect(landingCtaHref(signedIn)).toBe(CONSOLE_ROUTE);
    expect(landingCtaLabel(signedIn)).toBe("Open your console");
  });
});
