/**
 * @jest-environment jsdom
 */

/**
 * Which route trash and restore take in the file actions (`useFileActions.ts`).
 *
 * The gateway when the workspace's object serves its tree (`objectServes`,
 * written by `useLiveTree` from the object's socket); the Convex action when it
 * does not, or when the gateway says `not_object`, or cannot answer. A refusal
 * from the gateway is surfaced and never sent on to Convex.
 *
 * Sabotage: drop the `?? (await trashEntryAction(args))` fallback in
 * `useFileActions.ts` and the "not_object" case fails; swap the served check in
 * `useObjectMoves` for `true` and the "not served" case fails the fetch check.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const convexCalls: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    return (args: never) => {
      convexCalls.push({ name, args });
      return actions[name]!(args);
    };
  };
  return {
    useAction: record,
    useMutation: record,
    useQuery: () => undefined,
    useQueries: () => ({}),
    useConvex: () => ({ query: async () => null }),
  };
});

const mockGrant = jest.fn(async (_args: unknown, _refresh?: unknown) => ({ accessToken: "tok-1", expiresAt: Date.now() + 600_000, scopes: [] }));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockGrant }));

import { useFileActions, type FileActionsValues } from "../features/console/files/fileBrowser/useFileActions";
import { setObjectServes } from "../features/console/files/fileBrowser/objectServes";

const WS = "w1";
const TRASH_URL = "https://mcp.context.lc/files/trash";
const RESTORE_URL = "https://mcp.context.lc/files/restore";
const NOTE = "1-projects/offsite-plan.md";
const TRASH = `.context/trash/stamp/${NOTE}`;
const fn = (name: string) => `functions/files:${name}`;

const moved = jest.fn();
let values: FileActionsValues | null = null;
let fetchMock: jest.Mock<(url: string, init?: unknown) => Promise<unknown>>;
let fetchReplies: { status: number; body: unknown }[];

function Probe() {
  values = useFileActions({
    options: { workspaceId: WS, slug: null } as never,
    folderIcons: { moved } as never,
  });
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  convexCalls.length = 0;
  moved.mockClear();
  mockGrant.mockClear();
  fetchReplies = [];
  fetchMock = jest.fn(async () => {
    const next = fetchReplies.shift()!;
    return { status: next.status, json: async () => next.body } as unknown;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  actions[fn("trashEntry")] = async (args: never) => ({ kind: "moved", from: (args as { path: string }).path, to: TRASH, paths: [NOTE] });
  actions[fn("restoreTrashEntry")] = async (args: never) => ({ kind: "moved", from: (args as { from: string }).from, to: (args as { to: string }).to, paths: [NOTE] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setObjectServes(WS, false);
});

const named = (name: string) => convexCalls.filter((call) => call.name === fn(name)).map((call) => call.args);

describe("trash", () => {
  test("a workspace its object serves goes to the gateway, not Convex", async () => {
    setObjectServes(WS, true);
    fetchReplies = [{ status: 200, body: { kind: "moved", from: NOTE, to: TRASH, paths: [NOTE], etag: "e2" } }];
    const result = await values!.trashEntry({ workspaceId: WS as never, path: NOTE, expectedEtag: "e1" } as never);

    expect(result).toMatchObject({ kind: "moved", to: TRASH });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(TRASH_URL);
    expect(named("trashEntry")).toEqual([]);
    expect(moved).toHaveBeenCalledWith(NOTE, TRASH);
  });

  test("a workspace its object does not serve never calls fetch and uses Convex", async () => {
    const result = await values!.trashEntry({ workspaceId: WS as never, path: NOTE } as never);

    expect(result).toMatchObject({ kind: "moved", to: TRASH });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGrant).not.toHaveBeenCalled();
    expect(named("trashEntry")).toHaveLength(1);
    expect(moved).toHaveBeenCalledWith(NOTE, TRASH);
  });

  test("409 not_object falls back to the Convex action", async () => {
    setObjectServes(WS, true);
    fetchReplies = [{ status: 409, body: { error: "not_object" } }];
    await values!.trashEntry({ workspaceId: WS as never, path: NOTE } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(named("trashEntry")).toHaveLength(1);
  });

  test("503 mirror_pending surfaces as SYNCING and is not sent to Convex", async () => {
    setObjectServes(WS, true);
    fetchReplies = [{ status: 503, body: { error: "mirror_pending" } }];
    let thrown: unknown = null;
    try {
      await values!.trashEntry({ workspaceId: WS as never, path: NOTE } as never);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ConvexError<{ code: string }>).data.code).toBe("SYNCING");
    expect(named("trashEntry")).toEqual([]);
    expect(moved).not.toHaveBeenCalled();
  });

  test("a gateway refusal is thrown as the file action's error and never sent to Convex", async () => {
    setObjectServes(WS, true);
    fetchReplies = [{ status: 404, body: { error: "not_found" } }];
    let thrown: unknown = null;
    try {
      await values!.trashEntry({ workspaceId: WS as never, path: NOTE } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string }>).data.code).toBe("FILE_NOT_FOUND");
    expect(named("trashEntry")).toEqual([]);
    expect(moved).not.toHaveBeenCalled();
  });
});

describe("restore", () => {
  test("a served workspace restores through the gateway", async () => {
    setObjectServes(WS, true);
    fetchReplies = [{ status: 200, body: { kind: "moved", from: TRASH, to: NOTE, paths: [NOTE] } }];
    await values!.restoreTrashEntry({ workspaceId: WS as never, from: TRASH, to: NOTE } as never);

    expect(fetchMock.mock.calls[0]![0]).toBe(RESTORE_URL);
    expect(named("restoreTrashEntry")).toEqual([]);
    expect(moved).toHaveBeenCalledWith(TRASH, NOTE);
  });

  test("a network failure falls back to Convex", async () => {
    setObjectServes(WS, true);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await values!.restoreTrashEntry({ workspaceId: WS as never, from: TRASH, to: NOTE } as never);

    expect(named("restoreTrashEntry")).toEqual([{ workspaceId: WS, from: TRASH, to: NOTE }]);
    expect(moved).toHaveBeenCalledWith(TRASH, NOTE);
  });
});
