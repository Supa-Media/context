/**
 * The file tree's socket to the workspace object (`objectTree.ts`): watched
 * folders sent on open and on change, listings laid down, `not_served`
 * handing the tree back to Convex, a re-authorization reconnecting at once,
 * and a gateway that keeps refusing not minting a grant every few seconds.
 *
 * Sabotage-checked: dropping the re-send of folders on open fails "the
 * folders are sent when the socket opens"; retrying a refusing gateway on the
 * short backoff forever fails "a gateway that keeps refusing is asked again
 * only after a while".
 */

import { describe, expect, test } from "@jest/globals";
import { NOT_SERVED_RETRY_MS, openObjectTree, treeSocketProtocols, treeSocketUrl } from "../features/console/files/fileBrowser/objectTree";

type Fake = {
  url: string;
  protocols: string[];
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

function harness() {
  const sockets: Fake[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const listings: Array<[string, unknown]> = [];
  const served: boolean[] = [];
  const refreshes: boolean[] = [];
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const tree = openObjectTree({
    gatewayOrigin: "https://gateway.example",
    token: async (refresh) => {
      refreshes.push(refresh);
      return "tok";
    },
    onListing: (folder, page) => listings.push([folder, page]),
    onServed: (value) => served.push(value),
    open: (url, protocols) => {
      const socket: Fake = {
        url,
        protocols,
        readyState: 0,
        sent: [],
        send(data) {
          this.sent.push(data);
        },
        close() {
          this.readyState = 3;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as { fn: () => void; ms: number });
      if (at >= 0) timers.splice(at, 1);
    },
  });
  const opened = (socket: Fake) => {
    socket.readyState = 1;
    socket.onopen?.({});
  };
  const runRetry = async () => {
    const retry = timers.filter((timer) => timer.ms !== 30_000).pop();
    if (!retry) throw new Error("no retry scheduled");
    timers.splice(timers.indexOf(retry), 1);
    retry.fn();
    await flush();
    return retry.ms;
  };
  return { tree, sockets, timers, listings, served, refreshes, flush, opened, runRetry };
}

describe("the tree socket to the workspace object", () => {
  test("its address and token never put the token in the URL", () => {
    expect(treeSocketUrl("https://gateway.example")).toBe("wss://gateway.example/tree");
    expect(treeSocketUrl("http://127.0.0.1:8799")).toBe("ws://127.0.0.1:8799/tree");
    expect(treeSocketProtocols("tok")).toEqual(["context.tree", "context.token.tok"]);
  });

  test("the folders are sent when the socket opens, and again when they change", async () => {
    const h = harness();
    h.tree.watch(["", "projects"]);
    await h.flush();
    h.opened(h.sockets[0]);
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({ t: "watch", folders: ["", "projects"] });
    h.tree.watch([""]);
    expect(JSON.parse(h.sockets[0].sent[1])).toEqual({ t: "watch", folders: [""] });
  });

  test("a listing is laid down and says the object serves the tree", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    const page = { path: "projects", entries: [], folderDefault: "team", truncated: false, manifestUsable: true };
    h.sockets[0].onmessage?.({ data: JSON.stringify({ t: "listing", folder: "projects", page }) });
    expect(h.listings).toEqual([["projects", page]]);
    expect(h.served).toEqual([true]);
  });

  test("not_served hands the tree to Convex and asks the object again only after a while", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    h.sockets[0].onmessage?.({ data: JSON.stringify({ t: "not_served" }) });
    h.sockets[0].onclose?.({ code: 4404 });
    expect(h.served).toEqual([false]);
    expect(await h.runRetry()).toBe(NOT_SERVED_RETRY_MS);
    expect(h.sockets).toHaveLength(2);
  });

  test("closed to be authorized again, it reconnects at once", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    h.sockets[0].onclose?.({ code: 4001 });
    expect(await h.runRetry()).toBe(0);
    expect(h.sockets).toHaveLength(2);
  });

  test("a gateway that keeps refusing is asked again only after a while, minting a new grant once", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0].onclose?.({ code: 1006 });
    const first = await h.runRetry();
    h.sockets[1].onclose?.({ code: 1006 });
    const second = await h.runRetry();
    h.sockets[2].onclose?.({ code: 1006 });
    const third = await h.runRetry();
    expect(first).toBeLessThan(5_000);
    expect(second).toBeLessThan(5_000);
    expect(third).toBe(NOT_SERVED_RETRY_MS);
    expect(h.refreshes).toEqual([false, true, false, false]);
  });

  test("closing it stops every retry", async () => {
    const h = harness();
    await h.flush();
    h.tree.close();
    h.sockets[0].onclose?.({ code: 1006 });
    expect(h.timers.filter((timer) => timer.ms !== 30_000)).toHaveLength(0);
  });
});
