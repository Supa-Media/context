import { describe, expect, test } from "@jest/globals";
import {
  CONSOLE_ROUTE,
  LOGIN_ROUTE,
  authorizeHref,
  landingCtaHref,
  landingCtaLabel,
  loginHref,
  resolveAuthRoute,
  resolveProtectedRoute,
  resolveRootRoute,
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

  /**
   * `isLoading` is not "the token is being read off the device" — that part is
   * local. It is "the socket has not answered", so with no network it never
   * ends and this gate rendered `null` for as long as the app stayed open. A
   * relaunch on a train was an app that would not start, on a device holding a
   * complete offline copy of the notes somebody wanted to read.
   */
  test("renders offline for a device that remembers a session", () => {
    expect(resolveProtectedRoute(loading, null, true)).toEqual({ action: "render" });
  });

  /**
   * And the bound on it. The caller only passes `true` when it is offline *and*
   * something was written down, and sign-out clears that — so a signed-out
   * device waits exactly as it did before. The default matters as much as the
   * behaviour: every existing caller and test gets today's answer without
   * saying anything.
   */
  test("a device that remembers nothing waits, as it always did", () => {
    expect(resolveProtectedRoute(loading, null, false)).toEqual({ action: "wait" });
    expect(resolveProtectedRoute(loading)).toEqual({ action: "wait" });
  });

  /**
   * A remembered session is not a claim about *who*. Once the server has
   * answered, its answer decides — a signed-out visitor is still sent to sign
   * in, remembered rows or not, and the sign-out that produced that state has
   * already cleared them.
   */
  test("it never overrides a server answer", () => {
    expect(resolveProtectedRoute(signedOut, null, true)).toEqual({
      action: "redirect",
      href: LOGIN_ROUTE,
    });
  });
});

/**
 * `/` on a phone, which is where every native launch lands. The remembered
 * session above was unreachable from a cold start because this gate sat in
 * front of it with a bare `wait`: offline `isLoading` never ends, so `/`
 * rendered `null` forever and the phone showed a blank ground, however many
 * times it was relaunched.
 */
describe("the root route on a phone", () => {
  test("sends a remembered session to the console while the server has not answered", () => {
    expect(resolveRootRoute(loading, false, true)).toEqual({
      action: "redirect",
      href: CONSOLE_ROUTE,
    });
  });

  test("a device that remembers nothing waits, as it always did", () => {
    expect(resolveRootRoute(loading, false, false)).toEqual({ action: "wait" });
    expect(resolveRootRoute(loading, false)).toEqual({ action: "wait" });
  });

  test("it never overrides a server answer", () => {
    expect(resolveRootRoute(signedOut, false, true)).toEqual({
      action: "redirect",
      href: LOGIN_ROUTE,
    });
    expect(resolveRootRoute(signedIn, false, true)).toEqual({
      action: "redirect",
      href: CONSOLE_ROUTE,
    });
  });

  test("the web keeps its landing page either way", () => {
    expect(resolveRootRoute(loading, true, true)).toEqual({ action: "render" });
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
    expect(landingCtaLabel(signedOut)).toBe("Create your workspace");
  });

  test("offers a signed-in visitor their console instead", () => {
    expect(landingCtaHref(signedIn)).toBe(CONSOLE_ROUTE);
    expect(landingCtaLabel(signedIn)).toBe("Open your console");
  });
});

/**
 * `?next=` exists for the links whose meaning is in the query.
 *
 * The OAuth consent screen was the first: an AI client redirects a browser to
 * `/authorize?request_id=…`, and sending a signed-out visitor to a bare
 * `/login` drops the request id, so the client's attempt fails with nothing to
 * retry. A **team link** is the second, and it is the one people actually send
 * each other — `teamShareLink` builds `/console/@seyi?note=…`, and the note is
 * the whole reason that URL exists rather than `/console/@seyi`.
 */
describe("coming back after signing in", () => {
  test("a plain login link when there is nowhere in particular to return to", () => {
    expect(loginHref(null)).toBe(LOGIN_ROUTE);
    expect(loginHref(undefined)).toBe(LOGIN_ROUTE);
    expect(loginHref(CONSOLE_ROUTE)).toBe(LOGIN_ROUTE);
  });

  test("carries a safe target, url-encoded", () => {
    expect(loginHref("/authorize?request_id=abc")).toBe(
      "/login?next=%2Fauthorize%3Frequest_id%3Dabc",
    );
  });

  // The target is narrowed on the way *in* as well as on the way out, so a link
  // that would leave the app never even gets built.
  test("an off-site target never survives being built into a link", () => {
    for (const evil of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      expect(loginHref(evil)).toBe(LOGIN_ROUTE);
    }
  });

  test("resolveAuthRoute follows a safe next and ignores an unsafe one", () => {
    expect(resolveAuthRoute(signedIn, "/authorize?request_id=abc")).toEqual({
      action: "redirect",
      href: "/authorize?request_id=abc",
    });
    expect(resolveAuthRoute(signedIn, "https://evil.example")).toEqual({
      action: "redirect",
      href: CONSOLE_ROUTE,
    });
  });

  test("a team link's note survives both narrowings, out and back", () => {
    /*
      The round trip a colleague makes: they are sent a note link, they have no
      session on that device, they sign in, and they must arrive at the note
      rather than at the context's empty "choose a note" screen.

      Both halves are asserted together because each is narrowed by
      `safeNextRoute` independently, and losing the query at either end
      produces the same symptom. The gate that *supplies* this value is the
      other half of the bug and is pinned in `appLayoutGate.test.ts` — that is
      where the pathname was being passed instead of the href.
    */
    const link = "/console/@seyi?note=3-resources/engineering/note.md";
    const href = loginHref(link);
    expect(href).toBe(`/login?next=${encodeURIComponent(link)}`);
    expect(resolveAuthRoute(signedIn, link)).toEqual({ action: "redirect", href: link });
  });

  test("authorizeHref encodes the request id rather than concatenating it", () => {
    expect(authorizeHref("abc")).toBe("/authorize?request_id=abc");
    expect(authorizeHref("a&b=c")).toBe("/authorize?request_id=a%26b%3Dc");
  });
});
