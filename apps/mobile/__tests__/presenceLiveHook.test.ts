/** @jest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import * as Y from "yjs";

const mockMint = jest.fn(async () => ({
  accessToken: "grant-token",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));

jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => mockMint,
}));

import { DurableCollaborationController, type CollaborationResponse } from "../features/console/collaboration/durable";
import { memoryStore } from "../features/offline/memory";
import { createSharedDoc, toBase64 } from "../features/console/presence/sharedDoc";
import { useNoteRoom } from "../features/console/presence/useNoteRoom";
import { usePresence, type Presence } from "../features/console/presence/usePresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(text: string): string {
  const doc = createSharedDoc({});
  doc.doc.transact(() => doc.text.insert(0, text), "server");
  const update = doc.snapshot();
  doc.destroy();
  return update;
}

function response(documentId: string, text: string): CollaborationResponse {
  return { documentId, update: snapshot(text), text, etag: `${documentId}-etag` };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Expose the constructed browser substitute to drive its network events.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestSocket = this;
  }

  send(value: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(value: string): void {
    this.onmessage?.({ data: value } as MessageEvent);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

let latestSocket: FakeWebSocket | null = null;
let mounted: { root: Root; container: HTMLDivElement; controller: DurableCollaborationController } | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (mounted) {
    const held = mounted;
    act(() => held.root.unmount());
    held.controller.stop();
    held.container.remove();
    mounted = null;
  }
  latestSocket = null;
  mockMint.mockClear();
});

describe("durable updates through the real presence hook", () => {
  test("sends controller edits as live v2 frames and applies peer frames without echo", async () => {
    const base = response("doc-live", "hello");
    const controller = new DurableCollaborationController({
      workspaceId: "workspace",
      path: "notes/a.md",
      scope: "private",
      initialText: "hello",
      transport: {
        mint: async () => "grant-token",
        request: async (_token, body) => {
          if (body.update) return new Promise<CollaborationResponse>(() => {});
          return base;
        },
      },
      store: memoryStore(),
      onText: () => {},
      onState: () => {},
      online: () => true,
      canWrite: () => true,
    });
    await controller.start();

    const oldWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;

    const seen: { current: Presence | null } = { current: null };
    function Probe() {
      seen.current = usePresence({
        workspaceId: "workspace",
        endpoint: "https://gateway.example/mcp",
        notePath: "notes/a.md",
        enabled: true,
        textForSeed: () => "hello",
        mode: "presence",
        durable: true,
        documentId: controller.state.documentId,
        shared: controller.state.shared,
        subscribeLiveUpdates: controller.state.subscribeLiveUpdates,
        onLiveUpdate: (documentId, update) => controller.receiveLiveUpdate(documentId, update),
      });
      return null;
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    mounted = { root, container, controller };
    try {
      await act(async () => root.render(createElement(Probe)));
      await settle();
      expect(latestSocket).not.toBeNull();
      const socket = latestSocket!;
      expect(socket.url).toContain("documentId=doc-live");
      await act(async () => {
        socket.open();
        socket.receive(JSON.stringify({
          t: "welcome",
          v: 2,
          you: "self",
          members: [],
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        }));
      });

      // Returning to the last-sent position must cancel a queued intermediate
      // position. Otherwise A -> B -> A leaves B queued and sends a stale
      // caret after the user has already stopped at A.
      await act(async () => {
        seen.current?.report(1, 1);
      });
      await act(async () => {
        seen.current?.report(2, 2);
        seen.current?.report(1, 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 160));
      });
      const cursorFrames = socket.sent
        .map((value) => JSON.parse(value) as { t?: string })
        .filter((frame) => frame.t === "cursor");
      expect(cursorFrames).toHaveLength(1);

      controller.changeForHook("hello!");
      await settle();
      const firstLive = socket.sent.map((value) => JSON.parse(value)).filter((frame) => frame.t === "live");
      expect(firstLive).toHaveLength(1);
      expect(firstLive[0]).toMatchObject({
        documentId: "doc-live",
        accessToken: "grant-token",
      });
      expect(typeof firstLive[0].d).toBe("string");

      controller.changeForHook("hello!!");
      await settle();
      const secondLive = socket.sent.map((value) => JSON.parse(value)).filter((frame) => frame.t === "live");
      expect(secondLive).toHaveLength(2);

      const peer = createSharedDoc({});
      peer.applyRemote(base.update);
      const before = Y.encodeStateVector(peer.doc);
      peer.text.insert(peer.text.length, " peer");
      const peerUpdate = toBase64(Y.encodeStateAsUpdate(peer.doc, before));
      const sentBeforePeer = socket.sent.length;
      await act(async () => {
        socket.receive(JSON.stringify({
          t: "live",
          documentId: "doc-live",
          d: peerUpdate,
          clientKey: "peer",
        }));
      });
      await settle();
      expect(socket.sent.length).toBe(sentBeforePeer);
      expect(controller.state.shared?.markdown()).toContain("peer");
      peer.destroy();
    } finally {
      act(() => root.unmount());
      controller.stop();
      (globalThis as unknown as { WebSocket: typeof oldWebSocket }).WebSocket = oldWebSocket;
      mounted = null;
    }
  });

  test("keeps the live subscription through the real note-room collaboration projection", async () => {
    const base = response("doc-note-room", "hello");
    const oldFetch = globalThis.fetch;
    const oldWebSocket = globalThis.WebSocket;
    let heldUpdateResolve: ((value: Response) => void) | null = null;
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { update?: string };
      if (body.update !== undefined) {
        return new Promise<Response>((resolve) => {
          heldUpdateResolve = resolve;
        });
      }
      return {
        ok: true,
        json: async () => base,
      } as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;

    const seen: { current: ReturnType<typeof useNoteRoom> | null } = { current: null };
    const onExternalWrite = jest.fn();
    const onSaved = jest.fn(() => () => {});
    const onCollaborationText = jest.fn();
    function Probe() {
      seen.current = useNoteRoom({
        workspaceId: "workspace",
        endpoint: "https://gateway.example/mcp",
        notePath: "notes/use-note-room-live.md",
        conflicted: false,
        textForSeed: () => "hello",
        onExternalWrite,
        onSaved,
        durable: true,
        canEdit: true,
        scope: "private",
        onCollaborationText,
      });
      return null;
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Probe)));
      await settle();
      await settle();
      await settle();
      const collaboration = seen.current?.presence.collaboration;
      expect(collaboration).toBeDefined();
      expect(collaboration?.documentId).toBe("doc-note-room");
      expect(collaboration?.shared?.markdown()).toBe("hello");
      expect(latestSocket).not.toBeNull();
      const socket = latestSocket!;
      expect(socket.url).toContain("documentId=doc-note-room");

      await act(async () => {
        socket.open();
        socket.receive(JSON.stringify({
          t: "welcome",
          v: 2,
          you: "self",
          members: [],
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        }));
      });

      // This is the same mutation yCollab makes on the shared Y.Text. The
      // HTTP update is intentionally held so live delivery proves it does not
      // depend on the server acknowledgement or a stale hook projection.
      await act(async () => {
        collaboration?.shared?.text.insert(collaboration.shared.text.length, "!");
      });
      await settle();
      await act(async () => {
        collaboration?.shared?.text.insert(collaboration.shared.text.length, "!");
      });
      await settle();

      const liveFrames = socket.sent
        .map((value) => JSON.parse(value) as { t?: string; documentId?: string; accessToken?: string })
        .filter((frame) => frame.t === "live");
      expect(liveFrames).toHaveLength(2);
      expect(liveFrames[0]).toMatchObject({
        documentId: "doc-note-room",
        accessToken: "grant-token",
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 160));
      });
      expect(heldUpdateResolve).not.toBeNull();

      const peer = createSharedDoc({});
      peer.applyRemote(base.update);
      const before = Y.encodeStateVector(peer.doc);
      peer.text.insert(peer.text.length, " peer");
      const peerUpdate = toBase64(Y.encodeStateAsUpdate(peer.doc, before));
      const sentBeforePeer = socket.sent.length;
      await act(async () => {
        socket.receive(JSON.stringify({
          t: "live",
          documentId: "doc-note-room",
          d: peerUpdate,
          clientKey: "peer",
        }));
      });
      await settle();
      expect(socket.sent.length).toBe(sentBeforePeer);
      expect(collaboration?.shared?.markdown()).toContain("peer");
      peer.destroy();
    } finally {
      act(() => root.unmount());
      globalThis.fetch = oldFetch;
      (globalThis as unknown as { WebSocket: typeof oldWebSocket }).WebSocket = oldWebSocket;
      latestSocket = null;
    }
  });
});
