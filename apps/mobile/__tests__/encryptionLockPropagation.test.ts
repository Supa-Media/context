/**
 * @jest-environment jsdom
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useNoteLockPropagation } from "../features/console/encryption/lockPropagation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(message: unknown) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && !channel.closed && channel.name === this.name) {
        channel.onmessage?.({ data: message } as MessageEvent<unknown>);
      }
    }
  }

  close() {
    this.closed = true;
  }
}

let originalChannel: typeof globalThis.BroadcastChannel | undefined;

beforeEach(() => {
  originalChannel = globalThis.BroadcastChannel;
  FakeBroadcastChannel.channels = [];
  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: FakeBroadcastChannel,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: originalChannel,
    configurable: true,
  });
});

function mount(
  workspaceId: string,
  received: string[],
): { announce(path: string): void; unmount(): void } {
  const container = document.createElement("div");
  const root = createRoot(container);
  let announce: (path: string) => void = () => undefined;

  function Probe() {
    announce = useNoteLockPropagation(workspaceId, (path) =>
      received.push(path),
    );
    return null;
  }

  act(() => root.render(createElement(Probe)));
  return {
    announce: (path) => act(() => announce(path)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("cross-tab encryption lock propagation", () => {
  test("notifies another console in the same workspace without notifying the sender", () => {
    const firstReceived: string[] = [];
    const secondReceived: string[] = [];
    const first = mount("w1", firstReceived);
    const second = mount("w1", secondReceived);

    first.announce("1-projects/private.md");

    expect(firstReceived).toEqual([]);
    expect(secondReceived).toEqual(["1-projects/private.md"]);
    first.unmount();
    second.unmount();
  });

  test("does not cross workspace boundaries and ignores malformed messages", () => {
    const received: string[] = [];
    const first = mount("w1", []);
    const otherWorkspace = mount("w2", received);

    first.announce("1-projects/private.md");
    FakeBroadcastChannel.channels[0]!.postMessage({
      v: 1,
      type: "note-encrypted",
      workspaceId: "w2",
      path: "",
    });

    expect(received).toEqual([]);
    first.unmount();
    otherWorkspace.unmount();
  });

  test("is a safe no-op where BroadcastChannel is unavailable", () => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: undefined,
      configurable: true,
    });
    const received: string[] = [];
    const mounted = mount("w1", received);

    expect(() => mounted.announce("1-projects/private.md")).not.toThrow();
    expect(received).toEqual([]);
    mounted.unmount();
  });
});
