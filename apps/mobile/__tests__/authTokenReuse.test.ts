/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Deliberately the dist file, not a re-export: this suite exists to pin the
// patch in `patches/@convex-dev__auth.patch`, so it must exercise the
// exact code the app ships. If the dependency is ever bumped and the patch
// dropped, this file failing is the signal that the sign-out bug is back.
import {
  AuthProvider,
  useAuth,
} from "../node_modules/@convex-dev/auth/dist/react/client.js";

/**
 * The random sign-out bug, pinned.
 *
 * Upstream behavior: every cold load calls `fetchAccessToken({
 * forceRefreshToken: true })`, which spends the **single-use** refresh token
 * even when the stored JWT is hours from expiring. If navigation interrupts
 * the localStorage save of the replacement pair (exactly what a Dropbox
 * OAuth redirect does), the browser keeps the old refresh token; presenting
 * it after the server's 10s reuse window is treated as token theft and the
 * whole session tree is invalidated — the "it keeps signing me out" Seyi hit
 * live on 2026-08-27.
 *
 * The patch: a forced fetch first reaches for the stored JWT, and only
 * rotates when that JWT is missing, near expiry, unparseable, or was already
 * handed out by a previous forced fetch (i.e. the server rejected it). Each
 * test here fails against the unpatched 0.0.90 client, which is the point.
 */

const NAMESPACE = "test";
const JWT_KEY = `__convexAuthJWT_${NAMESPACE}`;
const REFRESH_KEY = `__convexAuthRefreshToken_${NAMESPACE}`;

function makeJwt(expiresInMs: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode({
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    sub: "person",
  })}.signature`;
}

function makeStorage(seed: Record<string, string>) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    data,
  };
}

type FetchAccessToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

async function mountAuth(seed: Record<string, string>, rotatedJwt: string) {
  const unauthenticatedCall = jest.fn(async () => ({
    tokens: { token: rotatedJwt, refreshToken: "rt-child" },
  }));
  const client = {
    authenticatedCall: jest.fn(async () => ({})),
    unauthenticatedCall,
    verbose: false,
    logger: undefined,
  };
  const storage = makeStorage(seed);
  const grabbed: { auth?: { fetchAccessToken: FetchAccessToken } } = {};
  function Grab() {
    grabbed.auth = useAuth() as { fetchAccessToken: FetchAccessToken };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      createElement(
        AuthProvider as never,
        {
          client,
          storage,
          storageNamespace: NAMESPACE,
          replaceURL: async () => {},
        } as never,
        createElement(Grab),
      ),
    );
  });
  const fetchAccessToken: FetchAccessToken = async (args) => {
    let result: string | null = null;
    await act(async () => {
      result = await grabbed.auth!.fetchAccessToken(args);
    });
    return result;
  };
  return { fetchAccessToken, unauthenticatedCall, storage };
}

describe("a cold load with a still-valid stored JWT", () => {
  test("the forced fetch returns it without spending the refresh token", async () => {
    const storedJwt = makeJwt(60 * 60 * 1000);
    const { fetchAccessToken, unauthenticatedCall, storage } = await mountAuth(
      { [JWT_KEY]: storedJwt, [REFRESH_KEY]: "rt-parent" },
      makeJwt(2 * 60 * 60 * 1000),
    );

    const token = await fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe(storedJwt);
    // The whole bug is this call happening when it doesn't need to: rotation
    // spends a single-use token, and an interrupted save of its replacement
    // is what the server later reads as theft.
    expect(unauthenticatedCall).not.toHaveBeenCalled();
    expect(storage.data.get(REFRESH_KEY)).toBe("rt-parent");
  });

  test("a second forced fetch of the same JWT really rotates — a rejected token is never offered twice", async () => {
    const storedJwt = makeJwt(60 * 60 * 1000);
    const rotatedJwt = makeJwt(2 * 60 * 60 * 1000);
    const { fetchAccessToken, unauthenticatedCall, storage } = await mountAuth(
      { [JWT_KEY]: storedJwt, [REFRESH_KEY]: "rt-parent" },
      rotatedJwt,
    );

    await fetchAccessToken({ forceRefreshToken: true });
    const second = await fetchAccessToken({ forceRefreshToken: true });

    expect(second).toBe(rotatedJwt);
    expect(unauthenticatedCall).toHaveBeenCalledTimes(1);
    expect(unauthenticatedCall).toHaveBeenCalledWith("auth:signIn", {
      refreshToken: "rt-parent",
    });
    expect(storage.data.get(REFRESH_KEY)).toBe("rt-child");
  });
});

describe("a stored JWT that cannot be reused", () => {
  test("near expiry: rotation happens as before", async () => {
    const dyingJwt = makeJwt(30 * 1000); // under the 60s reuse margin
    const rotatedJwt = makeJwt(2 * 60 * 60 * 1000);
    const { fetchAccessToken, unauthenticatedCall } = await mountAuth(
      { [JWT_KEY]: dyingJwt, [REFRESH_KEY]: "rt-parent" },
      rotatedJwt,
    );

    const token = await fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe(rotatedJwt);
    expect(unauthenticatedCall).toHaveBeenCalledTimes(1);
  });

  test("unparseable: garbage in storage falls back to rotation, not a crash", async () => {
    const rotatedJwt = makeJwt(2 * 60 * 60 * 1000);
    const { fetchAccessToken, unauthenticatedCall } = await mountAuth(
      { [JWT_KEY]: "not-a-jwt", [REFRESH_KEY]: "rt-parent" },
      rotatedJwt,
    );

    const token = await fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe(rotatedJwt);
    expect(unauthenticatedCall).toHaveBeenCalledTimes(1);
  });
});
