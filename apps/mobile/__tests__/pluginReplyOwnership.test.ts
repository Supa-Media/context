/**
 * The host addresses suggestion, apply and preview requests to one sandbox
 * frame. A reply belongs to that same frame, not merely to whoever can guess
 * the next process-wide sequence number.
 *
 * The dialog and settings paths already keep this invariant. These tests pin
 * it for the three editor paths that used to index pending work by `seq` alone.
 */

import { describe, expect, jest, test } from "@jest/globals";
import type { Id } from "@context/convex/_generated/dataModel";
import type { ActiveSandbox } from "../features/console/plugins/runtime";
import type { SandboxEvent } from "../features/console/plugins/sandboxTypes";
import type { SandboxEventContext } from "../features/console/plugins/useRuntime/events";
import { handleSandboxEvent } from "../features/console/plugins/useRuntime/events";

const OWNER = sandbox("owner", "nonce-owner");
const IMPOSTOR = sandbox("impostor", "nonce-impostor");

function sandbox(pluginId: string, nonce: string): ActiveSandbox {
  return {
    bundle: {
      pluginId,
      version: "1.0.0",
      bundleFingerprint: `fp-${pluginId}`,
      manifestJson: `{"id":"${pluginId}"}`,
      mainJs: "module.exports = class {};",
      stylesCss: null,
      runtimeToken: `token-${pluginId}`,
      expiresAt: 4_102_444_800_000,
    },
    nonce,
    attempts: 1,
  };
}

function context(overrides: Record<string, unknown>): SandboxEventContext {
  const noop = jest.fn();
  return {
    workspaceId: "ws_one" as Id<"workspaces">,
    executeRequest: jest.fn(),
    loadBundle: jest.fn(),
    onNoteWrite: undefined,
    publish: noop,
    reportCrash: jest.fn(),
    reportStatus: jest.fn(),
    setRegistrations: noop,
    setStatusItems: noop,
    setModal: noop,
    setPickFailure: noop,
    setSettingsTabs: noop,
    setSettingsPane: noop,
    setTextModal: noop,
    setPending: noop,
    setOutcomes: noop,
    setSandboxes: noop,
    waiting: { current: new Map() },
    applying: { current: new Map() },
    previewing: { current: new Map() },
    modalWaiting: { current: new Map() },
    lastAsked: { current: null },
    lastModalAsked: { current: null },
    lastPreviewAsked: { current: null },
    offeredBy: { current: null },
    settingsOwner: { current: null },
    textModalOwner: { current: null },
    commandTimers: { current: new Map() },
    ...overrides,
  } as unknown as SandboxEventContext;
}

function ownedPending<T>(seq: number, resolve: (value: T) => void) {
  return new Map([
    [
      seq,
      {
        resolve,
        timer: setTimeout(() => undefined, 60_000),
        pluginId: OWNER.bundle.pluginId,
        nonce: OWNER.nonce,
      },
    ],
  ]);
}

describe("plugin reply ownership", () => {
  test("another frame cannot answer a suggestion query", () => {
    const resolve = jest.fn();
    const waiting = ownedPending(7, resolve);
    const ctx = context({ waiting: { current: waiting }, lastAsked: { current: 7 } });
    const answer: SandboxEvent = {
      type: "suggest-results",
      seq: 7,
      items: [{ text: "Genesis" }],
    };

    handleSandboxEvent(ctx, IMPOSTOR, answer);
    expect(resolve).not.toHaveBeenCalled();
    expect(waiting.has(7)).toBe(true);

    handleSandboxEvent(ctx, { ...OWNER, nonce: "nonce-restarted" }, answer);
    expect(resolve).not.toHaveBeenCalled();
    expect(waiting.has(7)).toBe(true);

    handleSandboxEvent(ctx, OWNER, answer);
    expect(resolve).toHaveBeenCalledWith([{ text: "Genesis" }]);
    expect(waiting.has(7)).toBe(false);
  });

  test("another frame cannot answer a preview query", () => {
    const resolve = jest.fn();
    const previewing = ownedPending(8, resolve);
    const ctx = context({ previewing: { current: previewing }, lastPreviewAsked: { current: 8 } });
    const answer: SandboxEvent = {
      type: "preview-results",
      seq: 8,
      previews: [{ href: "https://example.com", text: "Preview" }],
    };

    handleSandboxEvent(ctx, IMPOSTOR, answer);
    expect(resolve).not.toHaveBeenCalled();
    expect(previewing.has(8)).toBe(true);

    handleSandboxEvent(ctx, { ...IMPOSTOR, nonce: OWNER.nonce }, answer);
    expect(resolve).not.toHaveBeenCalled();
    expect(previewing.has(8)).toBe(true);

    handleSandboxEvent(ctx, OWNER, answer);
    expect(resolve).toHaveBeenCalledWith([{ href: "https://example.com", text: "Preview" }]);
    expect(previewing.has(8)).toBe(false);
  });

  test("a restarted or different frame cannot supply the line applied to the editor", () => {
    const resolve = jest.fn();
    const applying = ownedPending(9, resolve);
    const ctx = context({ applying: { current: applying } });
    const answer: SandboxEvent = {
      type: "suggest-applied",
      seq: 9,
      line: "trusted replacement",
    };

    handleSandboxEvent(ctx, { ...OWNER, nonce: "nonce-restarted" }, answer);
    expect(resolve).not.toHaveBeenCalled();
    expect(applying.has(9)).toBe(true);

    handleSandboxEvent(ctx, OWNER, answer);
    expect(resolve).toHaveBeenCalledWith("trusted replacement");
    expect(applying.has(9)).toBe(false);
  });
});
