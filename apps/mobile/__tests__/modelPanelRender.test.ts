/**
 * @jest-environment jsdom
 */

/**
 * The Model panel, on the glass.
 *
 * `modelProviders.test.ts` next door proves the rules. This proves the panel is
 * wired to them, which is a different failure and the one that ships: a
 * `canChangeModel` that is perfect is worth nothing if the card renders a
 * Connect button beside it anyway.
 *
 * Four claims, none of which a pure function can answer:
 *
 *  1. **A member sees what is connected and no control.** The backend refuses
 *     them too, but a button whose only outcome is a permission error is a
 *     screen teaching somebody they did something wrong.
 *  2. **An unanswered query draws no Connect button.** `useQuery` is
 *     `undefined` until it lands, and a card that treated that as "nothing
 *     connected" would offer to connect an account that already is.
 *  3. **The key is never on the glass.** Not after a successful connect, not
 *     in the row that says a key is there — the row carries the fingerprint,
 *     which is a hash and not a fragment of the value.
 *  4. **The panel does not claim a subscription cannot be used.** That sentence
 *     was in this feature's first mocks and it is false twice over; a test is
 *     what stops it coming back with the next copy edit.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *  1. `ProviderCard` drawing its Connect row on `connection === null` alone,
 *     dropping the `answered` guard.
 *     → **1 fails**: `an unanswered query offers nothing to connect`.
 *  2. `ModelPanelLive` passing `mayChange` as `true` rather than
 *     `canChangeModel(role)`.
 *     → **2 fail**: `a member sees what is connected and no control` and
 *     `a member is told who can change it`.
 *  3. The connected row preferring an `apiKey` off the row over the
 *     fingerprint — the shape somebody reaches for when a hash looks unhelpful
 *     beside a provider's own console, which shows the last four characters.
 *     → **1 fails**: `no key reaches the glass`.
 *
 *     Worth recording *why* it fails rather than only that it does: the
 *     fixture deliberately puts a key on the row even though `listProviders`
 *     never returns one — it builds its answer field by field precisely so it
 *     cannot. A fixture shaped like the real answer would have made this
 *     sabotage render `undefined`, and the check would have passed while the
 *     panel was reading a credential.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>(
    "convex/server",
  );
  return {
    useConvex: () => ({}),
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useAction: () => async () => {
      throw new Error("not used in this test");
    },
    useMutation: () => async () => {
      throw new Error("not used in this test");
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ModelPanel } from "../features/console/settings/panels/ModelPanel";
import type { ConsoleData } from "../features/console/types";

/**
 * A key in the fixture, so "no key reaches the glass" is a real search rather
 * than a search for something nothing could have rendered.
 *
 * `listProviders` does not return this field — it builds its answer field by
 * field precisely so it cannot — and that is the point: if the panel ever
 * reads a field off a row that carries one, this string appears.
 */
const KEY = "zarquon-plumbago-9471-not-a-real-key-and-never-was";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
});

function consoleData(role: string): ConsoleData {
  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@example.invalid", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
        role,
        kind: "personal",
        status: "ok",
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    loading: false,
    failure: null,
  } as never;
}

function mount(role: string): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ModelPanel, { data: consoleData(role), sectioned: true }),
    );
  });
  return container;
}

function has(container: HTMLElement, testID: string): boolean {
  return container.querySelector(`[data-testid="${testID}"]`) !== null;
}

function connected(extra: Record<string, unknown> = {}) {
  mockAnswers.set("functions/providers:listProviders", [
    { provider: "anthropic", fingerprint: "0011aabb", connectedAt: 1758153600000, ...extra },
  ]);
}

describe("who gets a control", () => {
  test("an owner is offered a way to connect each provider", () => {
    mockAnswers.set("functions/providers:listProviders", []);
    const screen = mount("owner");
    expect(has(screen, "model-connect-anthropic")).toBe(true);
    expect(has(screen, "model-connect-openai")).toBe(true);
  });

  test("a member sees what is connected and no control", () => {
    connected();
    const screen = mount("member");
    expect(screen.textContent).toContain("Anthropic");
    expect(has(screen, "model-connect-anthropic")).toBe(false);
    expect(has(screen, "model-disconnect-anthropic")).toBe(false);
  });

  test("a member is told who can change it", () => {
    connected();
    const screen = mount("member");
    expect(screen.textContent).toContain("Only an owner or an editor");
  });

  test("an owner with a connected account is offered a way to remove it", () => {
    connected();
    const screen = mount("owner");
    expect(has(screen, "model-disconnect-anthropic")).toBe(true);
    // ...and not a second Connect for the one already connected.
    expect(has(screen, "model-connect-anthropic")).toBe(false);
    expect(has(screen, "model-connect-openai")).toBe(true);
  });
});

describe("an absence is not an answer", () => {
  /**
   * `useQuery` is `undefined` until it lands. A card that read that as "nothing
   * connected" would offer to connect an account that already is — and the
   * person would paste a second key over their first one to find out.
   */
  test("an unanswered query offers nothing to connect", () => {
    const screen = mount("owner");
    expect(has(screen, "model-connect-anthropic")).toBe(false);
    expect(has(screen, "model-disconnect-anthropic")).toBe(false);
  });
});

describe("what reaches the glass", () => {
  test("no key reaches the glass", () => {
    /*
      The fixture carries a key on the row even though `listProviders` never
      returns one, so this is a search for something a careless read would
      actually surface rather than for something nothing could have rendered.
    */
    connected({ apiKey: KEY, encryptedApiKey: KEY });
    const screen = mount("owner");
    expect(screen.textContent).not.toContain(KEY);
    expect(screen.textContent).not.toContain(KEY.slice(0, 12));
    // The fingerprint is what stands in for it: a hash, never a fragment.
    expect(screen.textContent).toContain("0011aabb");
  });

  test("the panel says whose bill it is, because that is the whole arrangement", () => {
    mockAnswers.set("functions/providers:listProviders", []);
    const screen = mount("owner");
    expect(screen.textContent).toContain("billed to you");
  });

  /**
   * The false claim, kept out by a test.
   *
   * The first mocks for this feature carried "a Claude or ChatGPT subscription
   * cannot be used by a third-party app". OpenAI ships Sign in with ChatGPT for
   * exactly that, and Anthropic's June 15 notice says it is *pausing* the
   * change it announced — so Agent SDK and third-party usage still draw from a
   * subscription. Neither is what this screen connects, and neither is
   * impossible. A product that says a thing cannot be done, when it merely is
   * not built here yet, spends trust it will want back.
   */
  test("the panel does not claim a subscription cannot be used", () => {
    mockAnswers.set("functions/providers:listProviders", []);
    const text = mount("owner").textContent ?? "";
    for (const claim of ["cannot be used", "not supported", "does not support", "unsupported"]) {
      expect(text.toLowerCase()).not.toContain(claim);
    }
  });

  test("the panel says the key never lands on the device or in the bucket", () => {
    mockAnswers.set("functions/providers:listProviders", []);
    const text = mount("owner").textContent ?? "";
    expect(text).toContain("encrypted");
    expect(text).toContain("never onto this device");
  });
});
