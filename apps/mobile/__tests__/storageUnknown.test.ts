/**
 * @jest-environment jsdom
 */

/**
 * A BINDING THAT HAS NOT ANSWERED IS NOT A CONTEXT WITHOUT ONE.
 *
 * **Filmed on a phone, on an ordinary refresh of a note.** For about a tenth
 * of a second the console told the owner of a connected bucket that they had
 * none: a warn banner across Browse — "No bucket is connected to this context
 * yet, so there is nowhere to keep notes" — with a **Connect a bucket** button
 * under it, and "no bucket connected" in the chrome beside it. Then the answer
 * arrived and all of it vanished.
 *
 * Nothing was wrong with the claim's *condition*; the condition was
 * `storage === null && !data.loading`, and both halves were true. `loading` is
 * the **workspace list**, and the storage binding is a different subscription —
 * one that is only added to the query spec once a context is selected, so it is
 * necessarily a round trip behind the thing that was guarding it. In that
 * window "we have not asked yet" and "there is nothing there" were the same
 * value.
 *
 * So `ConsoleData.storage` has three values now, and the rule this suite
 * exists to keep is one sentence: **nothing may claim an absence without an
 * answer.** `undefined` is "ask again in a moment"; only `null` is "there is
 * no bucket".
 *
 * Every test here has its `null` control beside it. Without those, a console
 * that simply never mentioned storage would pass the whole file, and somebody
 * who really has no bucket would have no way to connect one.
 */

import { describe, expect, jest, test } from "@jest/globals";

/*
  The notch, as a number. `Screen.tsx` reads `useSafeAreaInsets`, which throws
  outside a `SafeAreaProvider` rather than answering zero — the same trade
  `browseShare.test.ts` and `appFrameRender.test.ts` make, for the same reason:
  the insets are the platform's business and a provider here would be a second
  thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePane } from "../features/console/panes/BrowsePane";
import { storagePillLabel } from "../features/console/storage/pill";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import { emptyEditor } from "../features/console/files/editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTED: ConsoleStorage = {
  connected: true,
  status: "connected",
  provider: "Cloudflare R2",
  bucket: "brain",
  conditionalWrite: true,
  updatedAt: 0,
};

/**
 * Just enough console for the pane, with the binding in a named state.
 *
 * `atRoot` gives it the context's own root listing, which is what the pane
 * needs to draw the **context root page** — the surface that carries
 * `storage · index · counts` on a phone (`files/contextFoot.ts`). Off by
 * default, because most of this file is about the banner and an empty
 * `listings` is the state a cold load is in.
 */
function dataWith(
  storage: ConsoleStorage | null | undefined,
  { atRoot = false }: { atRoot?: boolean } = {},
): ConsoleData {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: atRoot
      ? {
          "": {
            path: "",
            folderDefault: "private" as const,
            truncated: false,
            manifestUsable: true,
            entries: [],
          },
        }
      : {},
    expanded: new Set<string>(),
    toggleFolder: () => {},
    collapseAll: () => {},
    selectedPath: null,
    opening: null,
    select: () => true,
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    sync: undefined,
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "Seyi", handle: "@seyi" },
    contexts: [{ id: "w1", slug: "seyi", name: "Seyi", kind: "personal", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage,
    endpoint: "https://mcp.example",
    ingestionAddress: "seyi@example",
    ingestion: { settings: undefined },
    files,
    // Required on `ConsoleData`, and read by the context root page's foot for
    // how much of this context is indexed. `null` is "not answered yet", so no
    // figure is drawn — `indexProgressSurfaces` is where that is the subject
    // rather than a fixture detail.
    fastSearch: { status: null, loading: false },
    members: { rows: [] },
    // The state this bug lived in: the workspace list has landed, and the
    // binding for the selected context has not.
    loading: false,
    failure: null,
  } as unknown as ConsoleData;
}

function render(data: ConsoleData): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(BrowsePane, { data, onOpenSettings: () => {} })));
  const text = container.textContent ?? "";
  act(() => root.unmount());
  container.remove();
  return text;
}

const NO_BUCKET = "No bucket is connected to this context yet";

describe("Browse does not offer to connect a bucket it has not asked about", () => {
  test("a binding still in flight says nothing", () => {
    expect(render(dataWith(undefined))).not.toContain(NO_BUCKET);
  });

  test("and a context that really has none still says so", () => {
    // The control. A console that dropped the banner entirely would pass the
    // test above and leave somebody with no way to connect storage.
    expect(render(dataWith(null))).toContain(NO_BUCKET);
  });

  test("a connected bucket is never accused", () => {
    expect(render(dataWith(CONNECTED))).not.toContain(NO_BUCKET);
  });
});

describe("the pill's label answers for both absences and neither is a claim", () => {
  /*
    `storagePillLabel` returns `null` for "no bucket" and for "not asked yet",
    which is right for the status bar — it omits the segment rather than
    printing a claim — and is exactly why the two callers that *do* print
    "no bucket connected" have to check which one they were holding. That check
    is in `console/_layout.tsx`; this pins the function's half of the contract.
  */
  test("an unresolved binding has no label", () => {
    expect(storagePillLabel(undefined)).toBeNull();
  });

  test("and neither has a context with no bucket", () => {
    expect(storagePillLabel(null)).toBeNull();
  });

  test("a connected one does", () => {
    expect(storagePillLabel(CONNECTED)).toBe("R2 · brain");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The same rule, on the phone's own surface for it.
 *
 * The line `storage · index · counts` used to be the file tree's footer, and a
 * phone has no file tree — it is the foot of the context root page now, drawn
 * by `FolderView` from `contextFootLine`. That line is the **second** caller
 * that turns `storagePillLabel`'s `null` into the words "no bucket connected",
 * which is exactly the substitution this whole file exists to keep honest: it
 * has to know which absence it is holding, because one of them is a claim and
 * the other is a round trip.
 *
 * SABOTAGE: dropping the `storage === undefined` arm from `contextFootLine`, so
 * an unanswered binding reads as "no bucket connected", measured **zero**
 * failures across the whole suite (172 suites / 3,282 tests) — the guard was
 * written and nothing had ever asked it a question. These three are the answer;
 * with them the same mutant fails the first of them and only it.
 */
describe("the phone's context foot is held to the same rule", () => {
  test("a binding still in flight puts nothing about storage on the line", () => {
    const text = render(dataWith(undefined, { atRoot: true }));
    expect(text).toContain("Nothing read yet");
    expect(text).not.toContain("no bucket connected");
  });

  test("and a context that really has none says so there", () => {
    // The control, the same one every case in this file carries: a foot that
    // simply never mentioned storage would pass the test above, and the phone
    // has no other route to this fact at all.
    expect(render(dataWith(null, { atRoot: true }))).toContain("no bucket connected");
  });

  test("a connected one is named rather than described", () => {
    expect(render(dataWith(CONNECTED, { atRoot: true }))).toContain("R2 · brain");
  });
});
