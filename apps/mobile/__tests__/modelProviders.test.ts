import { describe, expect, test } from "@jest/globals";
/**
 * The model account, as facts the console can be held to.
 *
 * Everything here is a rule that would otherwise live inside a component, where
 * `features/console/capabilities.ts` says it would be held by nothing. The two
 * that matter most:
 *
 *  - **a refusal never quotes the key.** A settings screen's error text is the
 *    single most likely thing in this app to end up in a screenshot pasted into
 *    a support thread, and #661 is what an error that names the value it
 *    rejected costs;
 *  - **an unanswered query is not an empty one.** `connectionFor(undefined, …)`
 *    is `null` the same way an unconnected provider is, so a card cannot draw a
 *    Connect button over an account that is already connected and merely has
 *    not loaded yet.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `keyProblem` interpolating the value into its "too long" sentence.
 *     → **1 fails**: `no refusal quotes the key back`.
 *  2. `canChangeModel` accepting `member`, matching what a reader would guess
 *     from "anyone in the context can use the agent".
 *     → **1 fails**: `a member may not connect a model account`.
 *  3. `keyProblem` requiring an `sk-` prefix — the check somebody adds to be
 *     helpful, and the one the backend deliberately does not make.
 *     → **2 fail**: `a key is checked for shape and never for a prefix` and
 *     `an ordinary key is sendable`. The second was not predicted and is the
 *     more useful of the two: the happy-path test uses a sentinel shaped like
 *     nothing any provider issues, on purpose, so it is itself a check that
 *     this file refuses shapes rather than brands.
 */

import {
  MAX_KEY_LENGTH,
  MODEL_PROVIDERS,
  canChangeModel,
  canConnectKey,
  connectionFor,
  keyProblem,
} from "../features/console/model/providers";

const KEY = "zarquon-plumbago-9471-not-a-real-key-and-never-was";

describe("what makes a key sendable", () => {
  test("an ordinary key is sendable", () => {
    expect(keyProblem(KEY)).toBeNull();
    expect(canConnectKey(KEY)).toBe(true);
  });

  test("nothing pasted is refused", () => {
    expect(keyProblem("")).not.toBeNull();
    expect(canConnectKey("")).toBe(false);
  });

  test("a pasted paragraph is refused", () => {
    expect(keyProblem("x".repeat(MAX_KEY_LENGTH + 1))).not.toBeNull();
  });

  test("a key with whitespace in it is refused, which is what a bad paste looks like", () => {
    for (const bad of [` ${KEY}`, `${KEY} `, `${KEY.slice(0, 8)} ${KEY.slice(8)}`, `${KEY}\n`]) {
      expect(canConnectKey(bad)).toBe(false);
    }
  });

  /**
   * The backend's argument, mirrored: matching `sk-ant-` would refuse a key
   * whose prefix changed and produce a support ticket blaming us for somebody
   * else's rename. A shape that is *not* a known prefix must still be sendable,
   * because the server will accept it.
   */
  test("a key is checked for shape and never for a prefix", () => {
    expect(keyProblem("some-other-providers-key-format-entirely")).toBeNull();
  });

  test("no refusal quotes the key back", () => {
    const refusals = ["", "x".repeat(MAX_KEY_LENGTH + 1), ` ${KEY}`, `${KEY}\n`]
      .map((value) => keyProblem(value) ?? "")
      .join("\n");
    expect(refusals).not.toContain(KEY);
    expect(refusals).not.toContain(KEY.slice(0, 12));
    expect(refusals).not.toContain("x".repeat(20));
  });
});

describe("who may change it", () => {
  test("an owner and an editor may", () => {
    expect(canChangeModel("owner")).toBe(true);
    expect(canChangeModel("editor")).toBe(true);
  });

  /** `connectProvider` requires `editor`; a control a member cannot use is absent. */
  test("a member may not connect a model account", () => {
    expect(canChangeModel("member")).toBe(false);
  });

  test("an unknown or absent role may not", () => {
    expect(canChangeModel(undefined)).toBe(false);
    expect(canChangeModel("viewer")).toBe(false);
  });
});

describe("reading one connection", () => {
  const connections = [
    { provider: "anthropic", fingerprint: "0011aabb", connectedAt: 5 },
  ];

  test("a connected provider is found", () => {
    expect(connectionFor(connections, "anthropic")?.fingerprint).toBe("0011aabb");
  });

  test("an unconnected one is null, and so is an unanswered query", () => {
    expect(connectionFor(connections, "openai")).toBeNull();
    expect(connectionFor(undefined, "anthropic")).toBeNull();
  });

});

describe("the catalogue", () => {
  /**
   * The names are the control plane's, and a drift here is a connect call that
   * is refused with `UNKNOWN_PROVIDER` on a screen that offered the button.
   */
  test("the provider names are the ones the control plane knows", () => {
    expect(MODEL_PROVIDERS.map((provider) => provider.name)).toEqual(["anthropic", "openai"]);
  });

  test("every provider says where its key comes from", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(provider.console.length).toBeGreaterThan(0);
      expect(provider.label.length).toBeGreaterThan(0);
    }
  });
});
