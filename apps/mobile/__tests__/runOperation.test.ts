/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useRunOperation, LISTING_REFRESH_TIMEOUT_MS } from "../features/console/files/fileBrowser/useRunOperation";
import { OPERATION_TIMEOUT_MS } from "../features/console/files/fileBrowser/timing";
import { STALE_LISTING_MESSAGE, TIMED_OUT_MESSAGE } from "../features/console/files/fileBrowser/copy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deps = Parameters<typeof useRunOperation>[0];
type Confirmation = Awaited<ReturnType<Deps["refresh"]>>;
type Result = { touched: string[]; message?: string; undo?: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  await act(async () => { for (let n = 0; n < 12; n += 1) await Promise.resolve(); });
}

describe("operation completion is independent from confirmation and shared chrome", () => {
  let deps: Deps;
  let run: ReturnType<typeof useRunOperation>["run"];
  let unmount: () => void;
  let render: () => void;
  let busy: boolean;
  let notice: string | null;
  let refresh: jest.Mock<Deps["refresh"]>;
  let setBusy: jest.Mock<Deps["setBusy"]>;
  let setNotice: jest.Mock<Deps["setNotice"]>;
  beforeEach(() => {
    jest.useFakeTimers();
    busy = false;
    notice = null;
    refresh = jest.fn<Deps["refresh"]>().mockResolvedValue({ servedFromCache: false, pages: {} });
    setBusy = jest.fn<Deps["setBusy"]>((value) => { busy = typeof value === "function" ? value(busy) : value; });
    setNotice = jest.fn<Deps["setNotice"]>((value) => { notice = typeof value === "function" ? value(notice) : value; });
    deps = {
      options: { workspaceId: "w1", canEdit: true, tier: "private" },
      workspaceId: "w1" as Deps["workspaceId"],
      workspaceGenerationRef: { current: { workspaceId: "w1" as Deps["workspaceId"], epoch: 0 } },
      listingsRef: { current: {} },
      offlineRef: { current: { reachability: "online" } } as Deps["offlineRef"],
      nextToastId: { current: 0 }, operationRun: { current: 0 },
      setBusy, setNotice, setToasts: jest.fn<Deps["setToasts"]>(), refresh,
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    function Probe() { run = useRunOperation(deps).run; return null; }
    render = () => act(() => root.render(createElement(Probe)));
    render();
    unmount = () => { act(() => root.unmount()); container.remove(); };
  });
  afterEach(() => { unmount(); jest.useRealTimers(); });

  test("a committed mutation returns and releases busy before confirmation; a hung confirmation is bounded", async () => {
    const confirmation = deferred<Confirmation>();
    refresh.mockReturnValue(confirmation.promise);
    const committed = jest.fn();
    let answer: boolean | undefined;
    void run(async () => ({ touched: ["a.md"], message: "Created." }), undefined, committed).then(value => { answer = value; });
    await settle();
    expect(answer).toBe(true);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(busy).toBe(false);
    await act(async () => { jest.advanceTimersByTime(LISTING_REFRESH_TIMEOUT_MS); });
    await settle();
    expect(notice).toBe(STALE_LISTING_MESSAGE);
    confirmation.resolve({ servedFromCache: false, pages: {} }); await settle();
    expect(notice).toBe(STALE_LISTING_MESSAGE);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])("a mutation is still reconciled if it settles after its timeout (success: %s)", async (success) => {
    const operation = deferred<Result>();
    const committed = jest.fn();
    const revert = jest.fn();
    let answer: boolean | undefined;
    void run(() => operation.promise, revert, committed).then(value => { answer = value; });
    await act(async () => { jest.advanceTimersByTime(OPERATION_TIMEOUT_MS); }); await settle();
    expect(busy).toBe(false);
    expect(notice).toBe(TIMED_OUT_MESSAGE);
    expect(answer).toBeUndefined();
    expect(revert).not.toHaveBeenCalled();
    if (success) operation.resolve({ touched: ["a.md"], message: "Done." });
    else operation.reject(new Error("Denied"));
    await settle();
    expect(answer).toBe(success);
    expect(committed).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(revert).toHaveBeenCalledTimes(success ? 0 : 1);
    expect(refresh).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(notice).toBe(success ? "Done." : "That did not work. Try again.");
  });

  test("an older mutation still commits but cannot clear the newer operation's busy state or notice", async () => {
    const first = deferred<Result>();
    const second = deferred<Result>();
    const firstCommit = jest.fn();
    void run(() => first.promise, undefined, firstCommit);
    void run(() => second.promise);
    first.resolve({ touched: ["a.md"], message: "First." }); await settle();
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(busy).toBe(true);
    expect(notice).toBeNull();
    second.resolve({ touched: ["b.md"], message: "Second." }); await settle();
    expect(busy).toBe(false);
    expect(notice).toBe("Second.");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("a late old failure still reverts its mutation without overwriting newer success", async () => {
    const first = deferred<Result>();
    const revert = jest.fn();
    void run(() => first.promise, revert);
    await act(async () => { jest.advanceTimersByTime(OPERATION_TIMEOUT_MS); }); await settle();
    await run(async () => ({ touched: ["b.md"], message: "Second." })); await settle();
    first.reject(new Error("First failed")); await settle();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(notice).toBe("Second.");
    expect(busy).toBe(false);
  });

  test.each([true, false])("workspace switches discard old completion (success: %s)", async (success) => {
    const operation = deferred<Result>();
    const committed = jest.fn();
    const revert = jest.fn();
    const result = run(() => operation.promise, revert, committed);
    deps.workspaceGenerationRef.current = { workspaceId: "w2" as Deps["workspaceId"], epoch: 1 };
    deps = { ...deps, workspaceId: "w2" as Deps["workspaceId"] }; render();
    setBusy.mockClear(); setNotice.mockClear();
    if (success) operation.resolve({ touched: ["a.md"] }); else operation.reject(new Error("Denied"));
    await settle();
    expect(await result).toBe(false);
    expect(committed).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });

  test.each([true, false])("unmount discards old completion and starts no new refresh (success: %s)", async (success) => {
    const operation = deferred<Result>();
    const committed = jest.fn();
    const revert = jest.fn();
    const result = run(() => operation.promise, revert, committed);
    unmount(); unmount = () => {};
    setBusy.mockClear(); setNotice.mockClear();
    if (success) operation.resolve({ touched: ["a.md"] }); else operation.reject(new Error("Denied"));
    await settle();
    expect(await result).toBe(false);
    expect(committed).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });

  test("confirmation finishing after unmount cannot write notices or toasts", async () => {
    const confirmation = deferred<Confirmation>();
    refresh.mockReturnValue(confirmation.promise);
    await run(async () => ({ touched: ["a.md"], message: "Done.", undo: () => {} }));
    unmount(); unmount = () => {};
    setNotice.mockClear(); (deps.setToasts as jest.Mock).mockClear();
    confirmation.resolve({ servedFromCache: false, pages: {} }); await settle();
    expect(setNotice).not.toHaveBeenCalled();
    expect(deps.setToasts).not.toHaveBeenCalled();
  });
  test("a failed confirmation cannot roll back an already committed mutation", async () => {
    refresh.mockRejectedValue(new Error("Listing unavailable"));
    const revert = jest.fn();
    const committed = jest.fn();
    const result = await run(async () => ({ touched: ["a.md"] }), revert, committed);
    await settle();
    expect(result).toBe(true);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(revert).not.toHaveBeenCalled();
    expect(notice).toBe(STALE_LISTING_MESSAGE);
    expect(busy).toBe(false);
  });

  test("an older confirmation finishing after newer success cannot overwrite its notice", async () => {
    const firstConfirmation = deferred<Confirmation>();
    refresh.mockReturnValueOnce(firstConfirmation.promise);
    await run(async () => ({ touched: ["a.md"], message: "First." }));
    await run(async () => ({ touched: ["b.md"], message: "Second." })); await settle();
    expect(notice).toBe("Second.");
    firstConfirmation.reject(new Error("Old listing failed")); await settle();
    expect(notice).toBe("Second.");
    expect(busy).toBe(false);
  });
  test("an old undo callback cannot start work or revert drawings after a workspace switch", async () => {
    const oldRun = run;
    deps.workspaceGenerationRef.current = { workspaceId: "w2" as Deps["workspaceId"], epoch: 1 };
    deps = { ...deps, workspaceId: "w2" as Deps["workspaceId"] }; render();
    const work = jest.fn<() => Promise<Result>>().mockResolvedValue({ touched: ["a.md"] });
    const revert = jest.fn();
    expect(await oldRun(work, revert)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });

  test("a callback retained after unmount cannot issue a storage mutation", async () => {
    unmount(); unmount = () => {};
    const work = jest.fn<() => Promise<Result>>().mockResolvedValue({ touched: ["a.md"] });
    const revert = jest.fn();
    expect(await run(work, revert)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
