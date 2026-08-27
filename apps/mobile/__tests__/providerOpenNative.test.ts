/**
 * @jest-environment jsdom
 */

/**
 * The native half of the connect-link opener.
 *
 * `connectClients.test.ts` exercises `open.web.ts`, because jest resolves
 * `.web.ts` first (see `jest.config.js`). This file reaches the native half by
 * its explicit path, which is the only way it runs in this suite at all.
 *
 * One thing to prove: the rejection is caught. `Linking.openURL("cursor://…")`
 * **rejects** on a phone with no Cursor installed, and an uncaught rejection
 * there is a button that does nothing and says nothing, with the only trace in
 * a log nobody reads. The assertion is not that the error is handled well —
 * there is no surface for that yet — but that it is handled at all.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { Linking } from "react-native";

const native = require("../features/console/clients/open.ts") as typeof import("../features/console/clients/open");

afterEach(() => {
  jest.restoreAllMocks();
});

/** Resolve after the microtask queue has drained, so a rejection has surfaced. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openProviderLink — native", () => {
  test("a scheme with no handler on this device does not reject unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    jest
      .spyOn(Linking, "openURL")
      .mockImplementation(() => Promise.reject(new Error("no handler for cursor://")));

    expect(() => native.openProviderLink("cursor://anysphere.cursor-deeplink/mcp/install")).not.toThrow();
    await settle();

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  test("a safe link is handed to Linking verbatim", () => {
    const spy = jest.spyOn(Linking, "openURL").mockImplementation(() => Promise.resolve());
    native.openProviderLink("https://claude.ai/customize/connectors");
    expect(spy).toHaveBeenCalledWith("https://claude.ai/customize/connectors");
  });

  /** The same shared rule the web half uses — see `redirectSafety.ts`. */
  test("an executing scheme never reaches Linking", () => {
    const spy = jest.spyOn(Linking, "openURL").mockImplementation(() => Promise.resolve());
    for (const href of ["javascript:alert(1)", "data:text/html,x", "not-a-url"]) {
      native.openProviderLink(href);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
