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
 * ## The card this pane must not grow
 *
 * The design this was drawn from has a "Take everything with you" card, with
 * Download everything and Move to my own bucket. **Neither exists.** There is
 * no export or hand-off path in the gateway or the control plane —
 * `storage-and-credentials.md` says so in as many words — and the exit is
 * non-negotiable #1. A control that looked live and did nothing, or a disabled
 * one implying it works later, would be worse than the absence: it is the one
 * promise a customer would test before trusting the product with their notes.
 *
 * What is true today is already said, in the lede: on a bucket somebody owns,
 * revoking the key at the provider is the exit, and no export is needed. The
 * missing piece is the managed-storage hand-off, and it is filed rather than
 * mocked up.
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

function storagePane(over: Partial<ConsoleStorage> = {}): HTMLElement {
  const base = demoData();
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

describe("the binding is a list of what this binding is", () => {
  test("each field is a row carrying its own label and value", () => {
    const body = storagePane({ provider: "r2", bucket: "seyi-workspace" });
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
    const body = storagePane({
      provider: "dropbox",
      bucket: undefined,
      endpoint: undefined,
      accessKey: undefined,
    });
    expect(find(body, "storage-field-bucket")).toBeNull();
    expect(find(body, "storage-field-access-key")).toBeNull();
    expect(find(body, "storage-field-provider")).not.toBeNull();
  });

  test("a value stays copyable, because an endpoint is there to be copied", () => {
    const body = storagePane({ endpoint: "https://example.r2.invalid" });
    const value = find(body, "storage-field-endpoint-value");
    expect(value).not.toBeNull();
    expect(value!.textContent).toBe("https://example.r2.invalid");
  });
});

describe("what the store can do is its own block", () => {
  test("the probe's findings are not inside the binding", () => {
    const body = storagePane({ connected: true, conditionalWrite: true });
    const capabilities = find(body, "storage-capabilities");
    expect(capabilities).not.toBeNull();
    expect(capabilities!.textContent).toContain("Conditional writes");

    const binding = find(body, "storage-binding");
    expect(binding!.contains(capabilities)).toBe(false);
  });

  test("a store that cannot do conditional writes says so rather than going quiet", () => {
    const body = storagePane({ connected: true, conditionalWrite: false });
    expect(find(body, "storage-capabilities")!.textContent).toContain(
      "Conditional writes unavailable",
    );
  });
});

describe("the exit is stated, and never mocked up", () => {
  /*
    The guard against the artboard. If somebody later draws the design's
    export card, this fails — and the right answer is to build the capability
    first, not to delete this.
  */
  test("no control offers an export that does not exist", () => {
    const body = storagePane({ connected: true });
    const labels = [...body.querySelectorAll<HTMLElement>("[role='button'], button")].map(
      (node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`.toLowerCase(),
    );
    for (const label of labels) {
      expect(label).not.toContain("download");
      expect(label).not.toContain("export");
      expect(label).not.toContain("hand over");
    }
  });

  test("the exit that is real is still stated in words", () => {
    expect(storagePane({ provider: "r2" }).textContent).toContain("no export needed");
  });
});
