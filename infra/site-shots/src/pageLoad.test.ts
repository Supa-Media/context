import { describe, expect, it } from "vitest";
import { gotoFailureReason, pageLoadFailure } from "./pageLoad";

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
});
