import { describe, expect, it } from "vitest";
import { gotoFailureReason, navigationFailure, pageLoadFailure, proxyConnectFailure } from "./pageLoad";

describe("pageLoadFailure", () => {
  it("is Chrome's network error page, with the net error text when we have it", () => {
    expect(pageLoadFailure("chrome-error://chromewebdata/", "net::ERR_TUNNEL_CONNECTION_FAILED")).toBe("net::ERR_TUNNEL_CONNECTION_FAILED");
    expect(pageLoadFailure("https://chromewebdata/", "")).toBe("chrome error page");
    expect(pageLoadFailure("chrome://crash/", "net::ERR_ABORTED")).toBe("net::ERR_ABORTED");
  });

  it("is not a real host, including one that answered 403", () => {
    expect(pageLoadFailure("https://wwws.airfrance.com/check-in", "")).toBeNull();
    expect(pageLoadFailure("about:blank", "")).toBeNull();
    expect(pageLoadFailure(true, "net::ERR_FAILED")).toBeNull();
  });

  it("keeps a net error out of a generic step failure", () => {
    expect(gotoFailureReason(new Error("chrome error page: net::ERR_CONNECTION_RESET"))).toBe("net::ERR_CONNECTION_RESET");
    expect(gotoFailureReason(new Error("no such element"))).toBe("that did not work on this page");
  });

  it("is a proxy that failed to connect, and not every net error", () => {
    expect(proxyConnectFailure("net::ERR_SOCKS_CONNECTION_FAILED")).toBe(true);
    expect(proxyConnectFailure("net::ERR_PROXY_CONNECTION_FAILED")).toBe(true);
    expect(proxyConnectFailure("net::ERR_TUNNEL_CONNECTION_FAILED")).toBe(true);
    expect(proxyConnectFailure("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(proxyConnectFailure("that did not work on this page")).toBe(false);
  });
});

describe("navigationFailure", () => {
  it("ignores ERR_ABORTED once a redirect has landed on a real host", () => {
    expect(navigationFailure("https://www.airfrance.fr/", "net::ERR_ABORTED", 200)).toBeNull();
    expect(navigationFailure("https://wwws.airfrance.us/check-in", "net::ERR_ABORTED", 302)).toBeNull();
    expect(navigationFailure("https://www.airfrance.com/", "Page.navigate net::ERR_ABORTED", 200)).toBeNull();
  });

  it("still fails an abort that did not land, and any other net error", () => {
    expect(navigationFailure("chrome-error://chromewebdata/", "net::ERR_ABORTED", 200)).toBe("net::ERR_ABORTED");
    expect(navigationFailure("https://www.airfrance.com/", "net::ERR_ABORTED", 0)).toBe("net::ERR_ABORTED");
    expect(navigationFailure("https://chromewebdata/", "net::ERR_SOCKS_CONNECTION_FAILED", 0)).toBe("net::ERR_SOCKS_CONNECTION_FAILED");
    expect(navigationFailure("https://wwws.airfrance.us/check-in", "", 200)).toBeNull();
  });
});
