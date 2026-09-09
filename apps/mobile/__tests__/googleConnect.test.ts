import { describe, expect, test } from "@jest/globals";
import {
  GOOGLE_CALLBACK_PATH,
  googleRedirectUri,
  isGoogleAuthorizeUrl,
  parseGoogleCallback,
  rememberGoogleCompletionSecret,
  stateFromGoogleAuthorizeUrl,
  takeGoogleCompletionSecret,
} from "../features/console/google/google";

describe("Google connect helpers", () => {
  test("the callback path matches the registered web origins", () => {
    expect(googleRedirectUri("https://context.lc")).toBe(
      `https://context.lc${GOOGLE_CALLBACK_PATH}`,
    );
    expect(googleRedirectUri("http://localhost:4601")).toBe(
      `http://localhost:4601${GOOGLE_CALLBACK_PATH}`,
    );
    expect(googleRedirectUri("https://attacker.invalid")).toBeNull();
    expect(googleRedirectUri(null)).toBeNull();
  });

  test("only a Google consent URL is followed", () => {
    expect(isGoogleAuthorizeUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isGoogleAuthorizeUrl("https://evil.example/o/oauth2/v2/auth")).toBe(false);
    expect(isGoogleAuthorizeUrl("javascript:alert(1)")).toBe(false);
  });

  test("the OAuth state carries the browser-only completion secret lookup", () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=state-1";
    expect(stateFromGoogleAuthorizeUrl(authorizeUrl)).toBe("state-1");
    expect(rememberGoogleCompletionSecret("state-1", "completion-1")).toBe(true);
    expect(takeGoogleCompletionSecret("state-1")).toBe("completion-1");
    expect(takeGoogleCompletionSecret("state-1")).toBeNull();
  });

  test("a callback needs both code and state", () => {
    expect(parseGoogleCallback({ code: "code", state: "state" })).toEqual({
      kind: "ready",
      code: "code",
      state: "state",
    });
    expect(parseGoogleCallback({ code: "code" })).toEqual({ kind: "incomplete" });
    expect(parseGoogleCallback({ error: "access_denied", state: "state" })).toEqual({
      kind: "cancelled",
    });
  });
});
