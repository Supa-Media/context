/**
 * @jest-environment jsdom
 */

/**
 * `files.addBuiltInFolder`, mounted against a recorded Convex action.
 *
 * What it must do: ask the server for the role, refresh the root so the new
 * folder is drawn, and hand back the path. What it must not do: swallow the
 * server's refusal (the sheet shows it), or call the server at all from a
 * console that cannot edit.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowserOptions } from "../features/console/files/fileBrowser/types";
import { useBuiltInFolders, type BuiltInFoldersValues } from "../features/console/files/fileBrowser/useBuiltInFolders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      const answer = answers[name];
      if (answer === undefined) throw new Error(`unanswered call to ${name}`);
      return answer(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

const bound: Record<string, (args: never) => Promise<unknown>> = {};
const answers: Record<string, (args: unknown) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];
const ADD = "functions/builtInFolders:add";

let api: BuiltInFoldersValues;

function mount(options: { workspaceId: string | null; canEdit: boolean }, refresh: (folders: readonly string[]) => Promise<unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    api = useBuiltInFolders({ options: options as unknown as FileBrowserOptions, refresh: refresh as never });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
});

describe("files.addBuiltInFolder", () => {
  test("asks the server for the role, refreshes the root, and resolves with the path", async () => {
    answers[ADD] = async () => ({ path: "4-clients", readme: "# Clients" });
    const refreshed: (readonly string[])[] = [];
    const unmount = mount({ workspaceId: "w1", canEdit: true }, async (folders) => void refreshed.push(folders));
    let path = "";
    await act(async () => {
      path = await api.addBuiltInFolder("clients");
    });
    unmount();
    expect(calls).toEqual([{ name: ADD, args: { workspaceId: "w1", role: "clients" } }]);
    expect(path).toBe("4-clients");
    // A top-level folder lands in the root, which is the one listing that has to be read again.
    expect(refreshed).toEqual([[""]]);
  });

  test("a refusal from the server reaches the caller, and the root is not refreshed", async () => {
    answers[ADD] = async () => {
      throw new ConvexError({ code: "DESTINATION_EXISTS", message: "A folder called Clients is already here." });
    };
    const refreshed: (readonly string[])[] = [];
    const unmount = mount({ workspaceId: "w1", canEdit: true }, async (folders) => void refreshed.push(folders));
    let failure: unknown = null;
    await act(async () => {
      try {
        await api.addBuiltInFolder("clients");
      } catch (error) {
        failure = error;
      }
    });
    unmount();
    expect(failure).toBeInstanceOf(ConvexError);
    expect(refreshed).toEqual([]);
  });

  test("a console that cannot edit never calls the server", async () => {
    answers[ADD] = async () => ({ path: "4-clients", readme: "" });
    const unmount = mount({ workspaceId: "w1", canEdit: false }, async () => {});
    let failure: unknown = null;
    await act(async () => {
      try {
        await api.addBuiltInFolder("clients");
      } catch (error) {
        failure = error;
      }
    });
    unmount();
    expect(calls).toEqual([]);
    expect(failure).toBeInstanceOf(Error);
  });
});
