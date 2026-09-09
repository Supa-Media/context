/**
 * @jest-environment jsdom
 */

/**
 * The Privacy section, actually rendered.
 *
 * `privacyMap.test.ts` holds the rows, the words and the control's decision as
 * pure functions. What a pure test cannot see is the panel wiring them up
 * wrong — drawing a button the capability says nobody may have, firing the
 * publish on the first press, or listing a folder the server never sent. Two
 * defects shipped past a fully green suite in the round before this one, both
 * of them in exactly that gap.
 *
 * So this mounts the real component and asserts the three things that would be
 * a breach rather than a blemish:
 *
 *  1. **A console that cannot set visibility has no control at all** — absent,
 *     not disabled. The landing page's demo browser makes every mutating
 *     method a no-op, so a drawn button there is one that looks like it worked
 *     and changed nothing.
 *  2. **Publishing a folder takes two presses**, and the first one writes
 *     nothing. Making one private again takes one, which is the asymmetry the
 *     product already applies to a note's lock.
 *  3. **The panel says only what its listing says.** A member's listing is
 *     short by construction, and the panel neither fills the gap nor counts
 *     it — it says the view is filtered and stops.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import type { ConsoleContext, ConsoleData } from "../features/console/types";
import type { FileEntry, FolderListing, Visibility } from "../features/console/files/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, resolved before mounting — an `act` inside an `act` never flushes. */
function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

function folder(path: string, visibility: Visibility): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

function note(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

function listing(path: string, folderDefault: Visibility, entries: FileEntry[]): FolderListing {
  return { path, folderDefault, entries, truncated: false, manifestUsable: true };
}

/** An owner's brain: one shared folder, one private one, one exception inside. */
const OWNER_LISTINGS: Record<string, FolderListing> = {
  "": listing("", "private", [
    folder("1-projects", "team"),
    folder("2-areas", "private"),
    note("index.md"),
    note("privacy.md", { readOnly: true }),
  ]),
  "1-projects": listing("1-projects", "team", [
    note("1-projects/pay-review.md", { inherited: "team", exception: true }),
    note("1-projects/kickoff.md", { visibility: "team", inherited: "team" }),
  ]),
};

interface Options {
  role: string;
  kind: "personal" | "shared";
  listings?: Record<string, FolderListing>;
  canSetVisibility?: boolean;
  onSetVisibility?: (path: string, kind: "file" | "folder", visibility: Visibility) => void;
}

/**
 * The panel, mounted over a console whose capabilities and listings this test
 * chooses. Everything else — the demo's members, storage, ingestion — comes
 * from the landing page's data, which the pane needs and this is not about.
 */
function panel(options: Options): HTMLElement {
  const base = demoData();
  const context: ConsoleContext = {
    id: "ctx",
    slug: "ctx",
    displayName: "ctx",
    role: options.role,
    kind: options.kind,
    status: "ok",
  };
  const data: ConsoleData = {
    ...base,
    contexts: [context],
    selectedContextId: "ctx",
    files: {
      ...base.files,
      contextId: "ctx",
      listings: options.listings ?? OWNER_LISTINGS,
      canSetVisibility: options.canSetVisibility ?? false,
      setVisibility: options.onSetVisibility ?? (() => {}),
    },
  };
  mount(() =>
    createElement(SettingsPane, { data, section: "privacy", onClose: () => {} }),
  );
  return document.body;
}

function press(host: HTMLElement, testID: string): void {
  const target = host.querySelector(`[data-testid="${testID}"]`);
  if (target === null) throw new Error(`no control ${testID}`);
  act(() => {
    (target as HTMLElement).click();
  });
}

describe("the section is reachable and is headed by its own row", () => {
  test("settings opens it, and it is not somebody else's panel", () => {
    const base = demoData();
    mount(() =>
      createElement(SettingsOverlay, {
        data: base,
        section: "privacy",
        onSelect: () => {},
        onDismiss: () => {},
      }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Privacy");
    expect(text).toContain("folder by folder");
    // One section at a time: the neighbouring panels stay shut.
    expect(text).not.toContain("Your bucket, your credentials");
  });
});

describe("what a reader is told", () => {
  test("the two words, and that neither of them is public", () => {
    const text = panel({ role: "owner", kind: "personal" }).textContent ?? "";
    expect(text).toContain("Private");
    expect(text).toContain("Team");
    expect(text).toContain("nothing here is indexed");
    // The one exception is named, because a panel that said "private or team"
    // and nothing else would be true and misleading at the same time.
    expect(text).toContain("One note at a time");
  });

  test("every folder the listing carried, with its own default", () => {
    const text = panel({ role: "owner", kind: "personal" }).textContent ?? "";
    expect(text).toContain("1-projects");
    expect(text).toContain("2-areas");
    // And what happens to something nobody has ruled on.
    expect(text).toContain("Anything with no rule of its own");
  });

  test("a workspace is told what private means there, which is not what it means in a brain", () => {
    const shared = panel({ role: "owner", kind: "shared" }).textContent ?? "";
    expect(shared).toContain("Owners only");
    const brain = panel({ role: "owner", kind: "personal" }).textContent ?? "";
    expect(brain).toContain("Yours alone");
  });

  test("opening a folder lists the notes its rules name by hand", () => {
    const host = panel({ role: "owner", kind: "personal" });
    expect(host.textContent ?? "").not.toContain("pay-review.md");
    press(host, "privacy-folder-1-projects");
    const text = host.textContent ?? "";
    expect(text).toContain("pay-review.md");
    expect(text).toContain("Held back from a team folder");
    // Every other note follows the folder, so it is not listed — the rule the
    // tree's markers already follow.
    expect(text).not.toContain("kickoff.md");
  });
});

describe("the control, and who is offered one", () => {
  test("a console that cannot set visibility draws none", () => {
    // The demo's browser makes every mutating method a no-op, so a button
    // here would look like it worked and change nothing. Absent, not
    // disabled — the same rule as Share and the tree's markers.
    const host = panel({ role: "member", kind: "personal" });
    expect(host.querySelector('[data-testid="privacy-set-1-projects"]')).toBeNull();
    expect(host.textContent ?? "").not.toContain("Share with team");
  });

  test("an editor is not offered one either — writing is not deciding who reads", () => {
    // `canSetVisibility` is owner-and-can-edit. An editor may write every note
    // in this context and still may not change its access map; the server
    // refuses them with `minimum: "owner"`.
    const host = panel({ role: "editor", kind: "shared" });
    expect(host.querySelector('[data-testid="privacy-set-1-projects"]')).toBeNull();
  });

  test("publishing a folder takes two presses, and the first writes nothing", () => {
    const wrote: string[] = [];
    const host = panel({
      role: "owner",
      kind: "personal",
      canSetVisibility: true,
      onSetVisibility: (path, kind, visibility) => wrote.push(`${kind} ${path} ${visibility}`),
    });
    press(host, "privacy-set-2-areas");
    expect(wrote).toEqual([]);
    // And it says what it is about to do, by name, in between.
    expect(host.textContent ?? "").toContain("Press again to share 2-areas");
    press(host, "privacy-set-2-areas");
    expect(wrote).toEqual(["folder 2-areas team"]);
  });

  test("closing one back takes one press, because that is the cheap direction", () => {
    const wrote: string[] = [];
    const host = panel({
      role: "owner",
      kind: "personal",
      canSetVisibility: true,
      onSetVisibility: (path, kind, visibility) => wrote.push(`${kind} ${path} ${visibility}`),
    });
    press(host, "privacy-set-1-projects");
    expect(wrote).toEqual(["folder 1-projects private"]);
  });

  test("arming one folder does not arm its neighbour", () => {
    const wrote: string[] = [];
    const host = panel({
      role: "owner",
      kind: "personal",
      canSetVisibility: true,
      listings: {
        "": listing("", "private", [folder("a", "private"), folder("b", "private")]),
      },
      onSetVisibility: (path, kind, visibility) => wrote.push(`${kind} ${path} ${visibility}`),
    });
    press(host, "privacy-set-a");
    press(host, "privacy-set-b");
    expect(wrote).toEqual([]);
  });

  test("the root's default is a fact and carries no control", () => {
    const host = panel({ role: "owner", kind: "personal", canSetVisibility: true });
    expect(host.querySelector('[data-testid="privacy-set-"]')).toBeNull();
  });
});

describe("a filtered view says so and does not fill in the gap", () => {
  test("a member sees their own listing, and is told it is theirs", () => {
    const host = panel({
      role: "member",
      kind: "shared",
      listings: { "": listing("", "private", [folder("1-projects", "team")]) },
    });
    const text = host.textContent ?? "";
    expect(text).toContain("1-projects");
    // The private folders of this context are simply not in the listing, and
    // nothing here counts them, names them, or leaves a placeholder for them.
    expect(text).not.toContain("2-areas");
    expect(text).toContain("Folders held back from you are not listed here");
  });

  test("an owner is never told their own view is filtered", () => {
    const text = panel({ role: "owner", kind: "personal" }).textContent ?? "";
    expect(text).not.toContain("Folders held back from you");
  });

  test("a manifest that will not parse is reported, not drawn as all-private rules", () => {
    const broken: FolderListing = {
      path: "",
      folderDefault: "private",
      entries: [folder("1-projects", "private")],
      truncated: false,
      manifestUsable: false,
    };
    const host = panel({ role: "owner", kind: "personal", listings: { "": broken } });
    expect(host.querySelector('[data-testid="privacy-manifest-broken"]')).not.toBeNull();
    // The rows are not drawn over a file nothing could read.
    expect(host.querySelector('[data-testid="privacy-folder-1-projects"]')).toBeNull();
  });

  test("a pane rendered over a stub browser draws what it has and does not crash", () => {
    /*
      Not hypothetical: the whole-scroll pane renders every block, and several
      suites mount it over a `ConsoleData` whose `files` is `{ listings: {} }`
      cast past the type — `dropboxScreens.test.ts` among them, whose own
      fixture comment records the last section to break this way. Nine checks
      in a suite that is not about privacy went red on the first version of
      this panel, which called a method that stub does not carry.
    */
    const base = demoData();
    const data = {
      ...base,
      contexts: [
        {
          id: "ctx",
          slug: "ctx",
          displayName: "ctx",
          role: "owner",
          kind: "personal",
          status: "ok",
        },
      ],
      selectedContextId: "ctx",
      files: { listings: { "": listing("", "private", [folder("1-projects", "team")]) } },
    } as unknown as ConsoleData;
    mount(() =>
      createElement(SettingsPane, { data, section: "privacy", onClose: () => {} }),
    );
    expect(document.body.textContent ?? "").toContain("1-projects");
  });

  test("nothing anywhere prints a count of folders or notes", () => {
    // A total over a filtered listing is the subtraction the note census is
    // owner-only to prevent. There is no number in this panel at all.
    const text = panel({ role: "member", kind: "shared" }).textContent ?? "";
    expect(text).not.toMatch(/\d+\s+(folders?|notes?|files?)/i);
  });
});
