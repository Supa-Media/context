/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import { newDrawing, parseDrawing, serializeDrawing } from "@context/drawings";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Two people drawing on one canvas are not in conflict.
 *
 * Both save the drawing, and the slower save is refused because the faster one
 * moved the version. Dev2 (2026-10-30): "whenever I'm doing excalidraw with
 * someone else on the page any edit causes an issue". A text note's shared
 * saving merges; a drawing now merges too, by element, and writes again —
 * still conditional, against the version it merged into.
 *
 * Sabotage-checked, as temporary edits reverted:
 *
 *   answering the refusal with `saveFailed` for drawings too (the old way)   3
 *   retrying against the refused etag instead of the merged-into one         3
 *   merging the refused text instead of the newest draft                     1
 *
 * The harness is `conflictResolution.test.ts`'s: the real `useFileBrowser`
 * against mocked Convex actions.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useQueries: () => ({}),
    useConvex: () => ({ query: async () => null }),
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const PATH = "projects/tex/new-tex-arch.excalidraw.md";
const TEXT_PATH = "projects/tex/plan.md";

const shape = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 7,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  isDeleted: false,
  ...over,
});
const drawing = (...elements: ReturnType<typeof shape>[]) => serializeDrawing(newDrawing(), elements)!;
const shapesIn = (text: string) => (parseDrawing(text, PATH).elements ?? []).map((e) => e.id).sort();

const BASE = drawing(shape("a"));
const MINE = drawing(shape("a"), shape("mine"));
const THEIRS = drawing(shape("a"), shape("theirs"));

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [PATH, TEXT_PATH].map((path) => ({
    kind: "file" as const,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  })),
  truncated: false,
  manifestUsable: true,
};

function noteAt(path: string, text: string, etag: string): OpenNote {
  return { path, text, etag, visibility: "private", inherited: "private", exception: false, readOnly: false };
}

const name = (fn: string) => `functions/files:${fn}`;

let writes: { path: string; text: string; expectedEtag?: string }[] = [];
let inBucket: OpenNote;
let browser: FileBrowser;
/** Awaited once, before the next `readNote` answers: a read held open. */
let duringRead: (() => Promise<void>) | null = null;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  duringRead = null;
  inBucket = noteAt(PATH, BASE, "e1");
  actions[name("listFiles")] = async () => ROOT_LISTING;
  actions[name("readNote")] = async () => {
    const answer = inBucket;
    const hook = duringRead;
    duringRead = null;
    if (hook) await hook();
    return answer;
  };
  actions[name("writeNote")] = async (args: never) => {
    const write = args as unknown as { path: string; text: string; expectedEtag?: string };
    writes.push({ path: write.path, text: write.text, expectedEtag: write.expectedEtag });
    if (write.expectedEtag !== inBucket.etag) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: inBucket.etag,
      });
    }
    inBucket = noteAt(write.path, write.text, `${inBucket.etag}+`);
    return { path: write.path, etag: inBucket.etag, conflictCheck: "conditional" };
  };
  unmount = mount();
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

async function drawAndLoseTheRace(mine: string, whileReading: (() => Promise<void>) | null = null) {
  browser.select(PATH);
  await settle();
  browser.setDraft(mine);
  await settle();
  // The other person's save lands first.
  inBucket = noteAt(PATH, THEIRS, "e2");
  duringRead = whileReading;
  browser.save();
  await settle();
}

describe("two people saving one drawing", () => {
  test("the refused save is merged and written again, with no conflict page", async () => {
    await drawAndLoseTheRace(MINE);

    expect(browser.editor.status).not.toBe("conflict");
    expect(browser.conflict).toBeNull();
    expect(writes).toHaveLength(2);
    expect(shapesIn(inBucket.text)).toEqual(["a", "mine", "theirs"]);
  });

  test("the retry is conditional on the version it merged into", async () => {
    await drawAndLoseTheRace(MINE);

    expect(writes[0]!.expectedEtag).toBe("e1");
    expect(writes[1]!.expectedEtag).toBe("e2");
    expect(browser.editor.etag).toBe(inBucket.etag);
    expect(browser.editor.draft).toBe(inBucket.text);
  });

  test("strokes made while the read was out survive the merge", async () => {
    const later = drawing(shape("a"), shape("mine"), shape("later"));
    // The read of their version is held open while another stroke lands.
    let answer: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await drawAndLoseTheRace(MINE, () => gate);
    browser.setDraft(later);
    await settle();
    answer();
    await settle();

    expect(shapesIn(inBucket.text)).toEqual(["a", "later", "mine", "theirs"]);
  });

  test("a bucket version that is no longer a drawing still asks the person", async () => {
    browser.select(PATH);
    await settle();
    browser.setDraft(MINE);
    await settle();
    inBucket = noteAt(PATH, "# Not a drawing any more\n", "e2");
    browser.save();
    await settle();

    expect(browser.editor.status).toBe("conflict");
    expect(writes).toHaveLength(1);
  });

  test("a text note's conflict is still the person's decision", async () => {
    inBucket = noteAt(TEXT_PATH, "One.\n", "t1");
    browser.select(TEXT_PATH);
    await settle();
    browser.setDraft("One, mine.\n");
    await settle();
    inBucket = noteAt(TEXT_PATH, "One, theirs.\n", "t2");
    browser.save();
    await settle();

    expect(browser.editor.status).toBe("conflict");
    expect(writes).toHaveLength(1);
  });
});
