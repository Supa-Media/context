/**
 * @jest-environment jsdom
 */

/**
 * THE STORAGE PANE'S SHAPE, AND THE ONE CARD IT IS NOT ALLOWED TO DRAW.
 *
 * ## The binding is a list, not a form
 *
 * Provider, bucket, endpoint and access key were drawn by `FieldGrid` as four
 * labelled *wells* in a two-up grid — boxes with a mono value inside them,
 * which is the same shape this app draws a text input in. Nothing there is
 * editable. A reader looking at four input-shaped boxes on a screen with a
 * "Rotate key" button under them has been invited to type in one, and the
 * ones that do not apply to a backend are simply missing, which reads as four
 * fields where one failed to load rather than as a list of what this binding
 * is.
 *
 * So it is a list of rows: the label, the value, a rule between them. The
 * value stays `mono` and stays selectable, because an endpoint and a key are
 * there to be copied.
 *
 * ## What the store can do is its own block
 *
 * The capability lines — reachable, conditional writes, PARA, versioning, the
 * note count — were stacked under the fields inside the same card, so the
 * binding and the last probe's findings read as one list of eight facts. They
 * answer different questions: one is what you connected, the other is what
 * came back when something looked.
 *
 * ## The exit this pane may claim
 *
 * A whole-bucket handoff exists for managed storage, and a whole-workspace
 * download now exists too (`files/download.ts`: every note the person can open,
 * as a .zip). This file used to forbid a Download button because the archive
 * did not exist yet; it said to build the capability first, and it was built.
 * What stays forbidden is a control that does less than it says, so the
 * button is asserted to call that download, and to be absent where nothing
 * real is behind it (the landing page's demo).
 *
 * The lede still says the other exit: on a bucket somebody owns, revoking the
 * key at the provider ends our access.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";
import {
  storageCompany,
  storageLine,
  storageVerdict,
} from "../features/console/settings/panels/StorageHealth";

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

function storagePane(
  over: Partial<ConsoleStorage> = {},
  data: (base: ConsoleData) => ConsoleData = (base) => base,
): HTMLElement {
  const base = data(demoData());
  const storage = { ...(base.storage as ConsoleStorage), ...over };
  mount(() =>
    createElement(SettingsOverlay, {
      data: { ...base, storage },
      section: "storage",
      onSelect: () => {},
      onDismiss: () => {},
    }),
  );
  return document.body;
}

const find = (root: HTMLElement, testID: string) =>
  root.querySelector(`[data-testid='${testID}']`) as HTMLElement | null;

/** "Connection details", which the settings artboard keeps closed. */
function openDetails(body: HTMLElement): HTMLElement {
  act(() => {
    find(body, "storage-details-toggle")!.click();
  });
  return body;
}

describe("the binding is a list of what this binding is", () => {
  test("each field is a row carrying its own label and value", () => {
    const body = openDetails(storagePane({ provider: "r2", bucket: "seyi-workspace" }));
    const binding = find(body, "storage-binding");
    expect(binding).not.toBeNull();

    const bucket = find(body, "storage-field-bucket");
    expect(bucket).not.toBeNull();
    expect(bucket!.textContent).toContain("Bucket");
    expect(bucket!.textContent).toContain("seyi-workspace");
  });

  /*
    The rule the fields already followed and that this must not lose: a
    backend without a bucket has no bucket row, rather than an empty box that
    reads as a field somebody failed to fill in.
  */
  test("a backend without a field has no row for it", () => {
    const body = openDetails(
      storagePane({
        provider: "dropbox",
        bucket: undefined,
        endpoint: undefined,
        accessKey: undefined,
      }),
    );
    expect(find(body, "storage-field-bucket")).toBeNull();
    expect(find(body, "storage-field-access-key")).toBeNull();
    expect(find(body, "storage-field-provider")).not.toBeNull();
  });

  test("technical details wait behind a toggle, and stay copyable once open", () => {
    const body = storagePane({ endpoint: "https://example.r2.invalid" });
    expect(find(body, "storage-field-endpoint-value")).toBeNull();
    act(() => {
      find(body, "storage-details-toggle")!.click();
    });
    const value = find(body, "storage-field-endpoint-value");
    expect(value).not.toBeNull();
    expect(value!.textContent).toBe("https://example.r2.invalid");
  });
});

describe("what the store can do is its own block", () => {
  test("the probe's findings are not inside the binding", () => {
    const body = openDetails(storagePane({ connected: true, conditionalWrite: true }));
    const capabilities = find(body, "storage-capabilities");
    expect(capabilities).not.toBeNull();
    expect(capabilities!.textContent).toContain("can't overwrite each other");

    const binding = find(body, "storage-binding");
    expect(binding!.contains(capabilities)).toBe(false);
  });

  test("a store that cannot do conditional writes says so rather than going quiet", () => {
    const body = storagePane({ connected: true, conditionalWrite: false });
    expect(find(body, "storage-capabilities")!.textContent).toContain(
      "This provider can't stop two saves at once",
    );
  });

  test("the page leads with one word, and says Healthy only when both checks are green", () => {
    const body = storagePane({ connected: true, conditionalWrite: true });
    expect(find(body, "storage-verdict")!.textContent).toBe("Healthy");
    const word = (connected: boolean, conditionalWrite: boolean, failed = false) =>
      storageVerdict({ connected, conditionalWrite }, failed).title;
    expect(word(true, false)).toBe("Working, with one limit");
    expect(word(false, true)).toBe("Not checked yet");
    expect(word(true, true, true)).toBe("Not working");
  });

  test("the health card comes before the connection fields", () => {
    const body = openDetails(storagePane({ connected: true, conditionalWrite: true }));
    const health = find(body, "storage-capabilities")!;
    const binding = find(body, "storage-binding")!;
    expect(health.compareDocumentPosition(binding) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the exit is stated, and never mocked up", () => {
  /*
    The guard against the artboard. If somebody later draws the design's
    export card, this fails — and the right answer is to build the capability
    first, not to delete this.
  */
  test("Download everything is the real download, and absent where there is none", () => {
    const download = jest.fn();
    const live = storagePane({ connected: true }, (base) => ({
      ...base,
      demo: false,
      files: { ...base.files, download },
    }));
    const button = find(live, "storage-download-all");
    expect(button).not.toBeNull();
    act(() => button!.click());
    // The root folder: every note this person can open, as one archive.
    expect(download).toHaveBeenCalledWith("", "folder");
  });

  test("the landing page's demo offers no download, because nothing is behind it", () => {
    const body = storagePane({ connected: true });
    const labels = [...body.querySelectorAll<HTMLElement>("[role='button'], button")].map(
      (node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`.toLowerCase(),
    );
    for (const label of labels) {
      expect(label).not.toContain("download");
      expect(label).not.toContain("export");
    }
  });

  test("the exit that is real is still stated in words", () => {
    expect(storagePane({ provider: "r2" }).textContent).toContain(
      "Remove our key at Cloudflare and we lose access right away",
    );
  });
});

describe("the line under the verdict", () => {
  const binding = (over: Partial<ConsoleStorage>) =>
    ({ provider: "r2", connected: true, conditionalWrite: true, ...over }) as ConsoleStorage;

  test("names the company, the files and the check, each only when measured", () => {
    const now = Date.UTC(2026, 8, 30, 12);
    expect(storageLine(binding({ objectCount: "1,284", lastVerifiedAt: now - 5 * 60_000 }), now)).toBe(
      "Your own Cloudflare storage · 1,284 files · checked 5 minutes ago",
    );
    // Nothing counted and never verified: the kind alone, no "0 files", no 1970.
    expect(storageLine(binding({ lastVerifiedAt: 0 }), now)).toBe("Your own Cloudflare storage");
    // An S3-compatible endpoint could be anybody's; it is not guessed at.
    expect(storageLine(binding({ provider: "s3-compatible" }), now)).toBe("Your own storage");
    expect(storageLine(binding({ managed: true }), now)).toBe("Storage Context runs for you");
    expect(storageCompany({ provider: "dropbox" })).toBe("Dropbox");
  });

  test("Check again is an owner's; nobody else is offered it", () => {
    // The demo holds no storage actions, which is exactly a member's view.
    expect(find(storagePane({ connected: true }), "storage-reverify")).toBeNull();
  });
});
