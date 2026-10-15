/** @jest-environment jsdom */
import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useOnlineMoves } from "../features/console/files/fileBrowser/useOnlineMoves";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const page = (paths: string[]): FolderListing => ({
  path: "", folderDefault: "private", truncated: false, manifestUsable: true,
  entries: paths.map(path => ({kind:"file",path,name:path,visibility:"private",inherited:"private",exception:false,readOnly:false})),
});
let current: ReturnType<typeof useOnlineMoves>;
let scope: {current:{epoch:number}};
let render: () => void;
let unmount: () => void;
beforeEach(() => {
  scope = {current:{epoch:0}};
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() { current = useOnlineMoves(scope); return null; }
  render = () => act(() => root.render(createElement(Probe)));
  unmount = () => act(() => root.unmount());
  render();
});
afterEach(() => unmount());

test("a pending rename overlays intervening live pages until committed identity is confirmed", async () => {
  let change!: ReturnType<typeof current.beginOnlineMove>;
  act(() => { change = current.beginOnlineMove("old.md", "new.md"); });
  expect(current.overlayOnlineMoves({"":page(["old.md"])} )[""]!.entries.map(e=>e.path)).toEqual(["new.md"]);
  act(() => current.confirmOnlineMoves("", page(["old.md"])));
  expect(current.pendingMoveTo("new.md")).toBeDefined();
  const done = current.pendingMoveTo("new.md")!.done;
  act(() => change.commit());
  await expect(done).resolves.toBe(true);
  act(() => current.confirmOnlineMoves("", page(["old.md"])));
  expect(current.overlayOnlineMoves({"":page(["old.md"])} )[""]!.entries.map(e=>e.path)).toEqual(["new.md"]);
  act(() => current.confirmOnlineMoves("", page(["new.md"])));
  // Once confirmed, future server changes must not be concealed by an overlay.
  expect(current.overlayOnlineMoves({"":page([])})[""]!.entries).toEqual([]);
});

test("cross-folder confirmation needs both authoritative parents", () => {
  let change!: ReturnType<typeof current.beginOnlineMove>;
  act(() => { change = current.beginOnlineMove("a/old.md", "b/new.md"); change.commit(); });
  act(() => current.confirmOnlineMoves("a", page([])));
  const base = {a:page(["a/old.md"]),b:page([])};
  expect(current.overlayOnlineMoves(base).b!.entries.map(e=>e.path)).toEqual(["b/new.md"]);
  act(() => current.confirmOnlineMoves("b", page(["b/new.md"])));
  expect(current.overlayOnlineMoves(base)).toBe(base);
});

test("a create remains visible across stale pages and yields to subsequent server changes", () => {
  let change!: ReturnType<typeof current.beginOnlineCreate>;
  act(() => { change = current.beginOnlineCreate("new.md"); });
  act(() => current.confirmOnlineMoves("", page([])));
  expect(current.overlayOnlineMoves({"":page([])})[""]!.entries.map(e=>e.path)).toEqual(["new.md"]);
  act(() => change.commit());
  act(() => current.confirmOnlineMoves("", page(["new.md"])));
  expect(current.overlayOnlineMoves({"":page([])})[""]!.entries).toEqual([]);
});

test("root refusal clears nested overlays and releases waiters despite eventual storage success", async () => {
  let change!: ReturnType<typeof current.beginOnlineMove>;
  act(() => { change = current.beginOnlineMove("a/old.md", "a/new.md"); });
  const done = current.pendingMoveTo("a/new.md")!.done;
  act(() => current.confirmOnlineMoves("", null, true));
  await expect(done).resolves.toBe(false);
  act(() => change.commit());
  const base = {a:page(["a/old.md"])};
  expect(current.overlayOnlineMoves(base)).toBe(base);
});

test("workspace departure resolves waiters and A to B to A cannot revive overlays", async () => {
  act(() => { current.beginOnlineCreate("new.md"); });
  const done = current.pendingCreateTo("new.md")!.done;
  scope.current = {epoch:1}; render();
  await expect(done).resolves.toBe(false);
  scope.current = {epoch:2}; render();
  expect(current.pendingCreateTo("new.md")).toBeUndefined();
  const base = {"":page([])};
  expect(current.overlayOnlineMoves(base)).toBe(base);
});

test("unmount releases pending navigation", async () => {
  act(() => { current.beginOnlineCreate("new.md"); });
  const done = current.pendingCreateTo("new.md")!.done;
  unmount(); unmount = () => {};
  await expect(done).resolves.toBe(false);
});

test("create then rename before confirmation cannot resurrect the created source", () => {
  act(() => { current.beginOnlineCreate("untitled.md").commit(); });
  act(() => { current.beginOnlineMove("untitled.md", "named.md").commit(); });
  act(() => current.confirmOnlineMoves("", page(["named.md"])));
  const confirmed = {"":page(["named.md"])};
  expect(current.overlayOnlineMoves(confirmed)).toBe(confirmed);
});

test("consecutive renames carry older unconfirmed overlays to the final identity", () => {
  act(() => { current.beginOnlineMove("a/first.md", "b/second.md").commit(); });
  act(() => { current.beginOnlineMove("b/second.md", "c/final.md").commit(); });
  act(() => current.confirmOnlineMoves("b", page([])));
  act(() => current.confirmOnlineMoves("c", page(["c/final.md"])));
  const base = {a:page(["a/first.md"]), b:page([]), c:page(["c/final.md"])};
  const shown = current.overlayOnlineMoves(base);
  expect(shown.a!.entries).toEqual([]);
  expect(shown.b!.entries).toEqual([]);
  expect(shown.c!.entries.map(e => e.path)).toEqual(["c/final.md"]);
  act(() => current.confirmOnlineMoves("a", page([])));
  expect(current.overlayOnlineMoves(base)).toBe(base);
});

test("rename followed by undo retires the original identity overlay", () => {
  act(() => { current.beginOnlineMove("old.md", "new.md").commit(); });
  act(() => { current.beginOnlineMove("new.md", "old.md").commit(); });
  act(() => current.confirmOnlineMoves("", page(["old.md"])));
  const base = {"":page([])};
  expect(current.overlayOnlineMoves(base)).toBe(base);
});
