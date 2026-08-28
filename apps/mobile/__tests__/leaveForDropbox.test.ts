/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { leaveForDropbox } from "../features/console/storage/leaveForDropbox";

/**
 * The one navigation in this flow that deliberately leaves the app.
 *
 * `isDropboxAuthorizeUrl` is tested on its own in `dropboxConnect.test.ts`.
 * This is the other half, and it is the half that has been wrong before in
 * this repository: **a guard nobody has checked is not a guard.** A version of
 * `leaveForDropbox` that imported the check and never called it would pass
 * every assertion in that file.
 *
 * The URL comes from our own control plane, built from a constant. The check
 * runs anyway, for `redirectSafety.ts`'s reason — a navigation target
 * assembled somewhere else is exactly the value you do not hand to a
 * navigation API on trust, and here the person is clicking on purpose.
 *
 * `jest.config.js` resolves `.web.ts` ahead of the bare extension, so this
 * exercises the web half — the one that actually runs in the browser where
 * this flow happens.
 */

const realLocation = window.location;
let assigned: string[] = [];

beforeEach(() => {
  assigned = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { assign: (url: string) => assigned.push(url), origin: realLocation.origin },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe("leaveForDropbox", () => {
  test("Dropbox's own authorize URL is followed, in this tab", () => {
    // In *this* tab, not a popup: the callback reads the session from this
    // origin and a blocked `window.open` is an OAuth flow that silently does
    // nothing. Same reasoning as `features/consent/leave.web.ts`.
    leaveForDropbox("https://www.dropbox.com/oauth2/authorize?client_id=x&state=y");
    expect(assigned).toEqual([
      "https://www.dropbox.com/oauth2/authorize?client_id=x&state=y",
    ]);
  });

  test("anywhere that is not Dropbox is not followed at all", () => {
    for (const url of [
      "https://dropbox.com.evil.example/oauth2/authorize",
      "https://evil.example/?next=https://www.dropbox.com",
      "http://www.dropbox.com/oauth2/authorize",
      "javascript:alert(1)",
      "",
    ]) {
      leaveForDropbox(url);
    }
    expect(assigned).toEqual([]);
  });
});
