/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { NameStep } from "../features/onboarding/steps/NameStep";
import { ConnectionsStep } from "../features/onboarding/redesign/ConnectionsStep";
import { ForkStep, type ForkOffer } from "../features/onboarding/redesign/ForkStep";
import { PaymentStep } from "../features/onboarding/redesign/PaymentStep";
import { PointAtBucket } from "../features/onboarding/steps/PointAtBucket";
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH } from "../features/onboarding/name";
import { nameStatus } from "../features/onboarding/name";
import type { OnboardingController } from "../features/onboarding/useOnboarding";

// React only treats `act` as authoritative when this is set, and warns loudly on
// every call when it is not. Setting it keeps the suite's output readable and
// makes an update outside `act` a signal rather than background noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The three screens with something to hide, rendered.
 *
 * These are assertions about **what is on the glass**, which no pure function
 * can make. Every bug below was a screen showing somebody something untrue
 * while the module underneath it was correct and green:
 *
 *  - the consequences panel rendered `status.normalized` as a live capture
 *    address for a name the field was rejecting, so typing "Seyi Olujide"
 *    produced `seyi olujide@context.lc` beside the error saying that is not a
 *    valid name;
 *  - a claim refused for *any* reason said "somebody claimed it while you were
 *    typing", including for `@postmaster`;
 *  - the last screen omitted its "there is nowhere to keep notes" warning for
 *    exactly the person whose bucket check had failed.
 *
 * React Native renders through `react-native-web` here — see `jest.config.js`
 * — so `textContent` is the real copy, in the real order.
 */

interface Rendered {
  /** The copy, in the order it appears on screen. */
  text: string;
  /** The markup, for the things that are not copy — a disabled button. */
  html: string;
}

function render(node: ReturnType<typeof createElement>): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  act(() => {
    root.render(node);
  });
  const rendered = {
    text: container.textContent ?? "",
    html: container.innerHTML,
  };
  act(() => root.unmount());
  container.remove();
  return rendered;
}

/** Mounted and left up, so a test can press things and read what changed. */
function renderLive(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    text: container.textContent ?? "",
    byId,
    press: (id: string) => {
      const target = byId(id);
      if (target === null) throw new Error(`nothing to press: ${id}`);
      act(() => {
        target.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function withConvex(node: ReturnType<typeof createElement>): ReturnType<typeof createElement> {
  const watch = {
    localQueryResult: () => null,
    onUpdate: () => () => {},
    journal: () => undefined,
  };
  const client = {
    action: async () => ({}),
    mutation: async () => ({}),
    watchQuery: () => watch,
  } as never;
  return createElement(ConvexProvider, { client }, node);
}

/** A controller with nothing happening, for a screen to read. */
function controller(overrides: Partial<OnboardingController>): OnboardingController {
  return {
    step: "name",
    shape: {},
    owned: 0,
    claimed: null,
    finished: false,
    forkOffer: null,
    pickManaged: () => {},
    pickOwn: () => {},
    startingFree: false,
    dryRun: null,
    finishDryRun: () => {},
    name: "",
    setName: () => {},
    nameStatus: { kind: "empty" },
    claiming: false,
    claimFailure: null,
    claim: async () => {},
    canClaim: false,
    connect: async () => ({ status: "unverified" }),
    connectState: { kind: "idle" },
    // No offer: the default for these screens is a deployment that cannot
    // provide managed storage.
    managed: null,
    skipStorage: () => {},
    continuePastStorage: () => {},
    ...overrides,
  };
}

describe("the name screen", () => {
  test("does not show a capture address for a name it is rejecting", () => {
    const status = nameStatus("Seyi Olujide", undefined);
    expect(status.kind).toBe("malformed");

    const { text } = render(
      createElement(NameStep, {
        controller: controller({ name: "Seyi Olujide", nameStatus: status }),
      }),
    );

    expect(text).not.toContain("seyi olujide@context.lc");
    expect(text).not.toContain("@seyi olujide");
    // The placeholder shape stays, so the panel does not blink out of existence.
    expect(text).toContain("yourname@context.lc");
  });

  test("shows it the moment the name is one somebody could have", () => {
    const { text } = render(
      createElement(NameStep, {
        controller: controller({
          name: "seyi",
          nameStatus: nameStatus("seyi", {
            available: true,
            normalized: "seyi",
          }),
        }),
      }),
    );

    expect(text).toContain("seyi@context.lc");
    expect(text).toContain("@seyi/1-projects/note.md");
  });

  test("puts a refused claim back on the field, over the field's own verdict", () => {
    // The state that makes this real: the live check says the name is free —
    // it is `available` right now — and then `createWorkspace` refuses it,
    // because it re-checks inside its own transaction. Keeping the live status
    // on screen leaves the field saying "@seyi is free. It's yours when you
    // continue" with a panel underneath saying the opposite. The refusal is the
    // newer answer, and it belongs where the fix is.
    const { text } = render(
      createElement(NameStep, {
        controller: controller({
          name: "seyi",
          nameStatus: nameStatus("seyi", {
            available: true,
            normalized: "seyi",
          }),
          claimFailure: {
            headline: "That name is reserved",
            next: "That name is reserved.",
            nameRejection: "reserved",
          },
        }),
      }),
    );

    expect(text).not.toContain("is free. It's yours when you continue");
    expect(text.toLowerCase()).toContain("reserved");
    // And not the one sentence that used to be shown for every refusal.
    expect(text).not.toContain("while you were typing");
    expect(text).not.toContain("That name just went");
  });

  test("still shows a failure that is not about the name at all", () => {
    // The panel is not deleted, only narrowed to the failures it is for.
    const { text } = render(
      createElement(NameStep, {
        controller: controller({
          name: "seyi",
          nameStatus: nameStatus("seyi", {
            available: true,
            normalized: "seyi",
          }),
          claimFailure: {
            headline: "That's a lot of contexts in one go",
            next: "Creating them is limited to a few an hour. Try again shortly.",
          },
        }),
      }),
    );

    expect(text).toContain("That's a lot of contexts in one go");
  });
});

describe("the tools screen", () => {
  const rows = (status: "connected" | "not-connected") =>
    [{ key: "claude-desktop" as const, name: "Claude", status, hasGuide: true }];

  test("offers one command that installs Context into every coding agent", () => {
    const { text } = render(
      createElement(ConnectionsStep, {
        clients: rows("not-connected"),
        onOpenGuide: () => {},
        onSkip: () => {},
      }),
    );
    expect(text).toContain("npx -y @supa-media/context install");
    // The endpoint stays, for the apps no command reaches.
    expect(text).toMatch(/endpoint/i);
  });

  test("does not imply a connected client sees everything", () => {
    // Every grant defaults to `team`, owners included. A first-run screen
    // promising otherwise describes a product we deliberately do not ship.
    const { text } = render(
      createElement(ConnectionsStep, { clients: rows("not-connected"), onOpenGuide: () => {}, onSkip: () => {} }),
    );
    expect(text).toMatch(/team is the default/i);
    expect(text).toMatch(/same URL for everyone/i);
  });

  test("offers a skip until a tool is connected, then a Continue — never Done", () => {
    // The bootstrap step follows this one. A button saying "Done" that opens
    // another step reads as broken.
    const waiting = render(
      createElement(ConnectionsStep, { clients: rows("not-connected"), onOpenGuide: () => {}, onSkip: () => {} }),
    );
    expect(waiting.text).toContain("Skip for now");
    const connected = render(
      createElement(ConnectionsStep, { clients: rows("connected"), onOpenGuide: () => {}, onSkip: () => {} }),
    );
    expect(connected.text).toContain("Continue");
    expect(connected.text).not.toMatch(/\bDone\b/);
  });
});

describe("the fork (A-04)", () => {
  const fork = (offer: ForkOffer, picks: string[] = []) =>
    renderLive(
      createElement(ForkStep, {
        offer,
        onPickManaged: () => picks.push("fresh"),
        onPickBYO: () => picks.push("own"),
      }),
    );

  test("two cards and one way on: “Take me to the console →”", () => {
    const view = fork({ kind: "free", cap: 1000 });
    expect(view.byId("welcome-fork-fresh")?.textContent).toContain("Start fresh");
    expect(view.byId("welcome-fork-own")?.textContent).toContain("I already have notes");
    expect(view.byId("welcome-fork-primary")?.textContent).toBe("Take me to the console →");
    // One primary on the screen: neither card carries a button of its own.
    expect(view.byId("welcome-fork-fresh")?.querySelector("button")).toBeNull();
    view.unmount();
  });

  test("the fresh card names the cap it enforces, and no figure nothing meters", () => {
    const view = fork({ kind: "free", cap: 1000 });
    expect(view.text).toContain("1,000 notes");
    expect(view.text).not.toMatch(/MB|GB|&nbsp;/);
    view.unmount();
  });

  test("the primary starts fresh; the other card goes to the bucket track", () => {
    const picks: string[] = [];
    const view = fork({ kind: "free", cap: 1000 }, picks);
    view.press("welcome-fork-primary");
    view.press("welcome-fork-own");
    expect(picks).toEqual(["fresh", "own"]);
    view.unmount();
  });

  test("where it can only be paid for, the button does not promise the console", () => {
    const view = fork({ kind: "paid", price: "$5 a month" });
    expect(view.text).toContain("$5 a month");
    expect(view.byId("welcome-fork-primary")?.textContent).toBe("Continue →");
    view.unmount();
  });

  test("where it cannot be offered at all, bringing your own is the only card and the only action", () => {
    const picks: string[] = [];
    const view = fork(null, picks);
    expect(view.byId("welcome-fork-fresh")).toBeNull();
    expect(view.byId("welcome-fork-primary")?.textContent).toBe("Point at my bucket →");
    view.press("welcome-fork-primary");
    expect(picks).toEqual(["own"]);
    view.unmount();
  });

  test("“What is the difference?” opens a sentence rather than another screen", () => {
    const view = fork({ kind: "free", cap: 1000 });
    expect(view.byId("welcome-fork-explained")).toBeNull();
    view.press("welcome-fork-difference");
    expect(view.byId("welcome-fork-explained")?.textContent).toMatch(/plain Markdown/);
    view.unmount();
  });
});

describe("the payment nudge", () => {
  test("promises nothing the product cannot do yet", () => {
    // Moving a managed bucket's notes into one of the customer's own is the
    // exit path still being finished — the reason the free tier ships dark in
    // production. The nudge may not promise it; it points at what works now.
    const { text } = render(
      createElement(PaymentStep, {
        used: 1000,
        cap: 1000,
        monthly: "$5 a month",
        ceiling: "50 GB",
        onLevelUp: () => {},
        onBringOwn: () => {},
      }),
    );
    expect(text).not.toMatch(/in one call|25\s*GB|&nbsp;/);
    expect(text).toContain("50 GB");
    expect(text).toMatch(/downloads as a \.zip/);
    expect(text).toMatch(/editing, moving and downloading/i);
  });
});

describe("the handle screen (A-03)", () => {
  test("says Available where the name was typed, and the real length limits", () => {
    const { text, html } = render(
      createElement(NameStep, {
        controller: controller({
          name: "seyi",
          nameStatus: nameStatus("seyi", { available: true, normalized: "seyi" }),
          canClaim: true,
        }),
      }),
    );
    expect(html).toContain('data-testid="welcome-name-available"');
    expect(text).toContain("Claim @seyi");
    // The canvas said "two to twenty"; the control plane says otherwise.
    expect(text).toContain(`${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters`);
  });

  test("a taken name gets its sentence, not the Available tick", () => {
    const { text, html } = render(
      createElement(NameStep, {
        controller: controller({
          name: "seyi",
          nameStatus: nameStatus("seyi", { available: false, normalized: "seyi" }),
        }),
      }),
    );
    expect(html).not.toContain('data-testid="welcome-name-available"');
    expect(text).toMatch(/Somebody already has @seyi/);
  });
});

describe("point at a bucket (B1-01)", () => {
  const mount = (onPickFree?: () => void) =>
    render(withConvex(createElement(PointAtBucket, { connect: async () => ({ status: "ok" }), onPickFree })));

  test("says what the probe writes, never that it writes nothing", () => {
    const { text } = mount();
    expect(text).toMatch(/one temporary test object, written\s+and removed/);
    expect(text).not.toMatch(/read-only/);
  });

  test("offers the free bucket only where it is offered", () => {
    expect(mount(() => {}).html).toContain('data-testid="point-at-bucket-free"');
    expect(mount().html).not.toContain('data-testid="point-at-bucket-free"');
  });

  test("the vault row is not a control that does nothing", () => {
    const { html } = mount();
    const vault = html.slice(html.indexOf('data-testid="point-at-vault"') - 200, html.indexOf('data-testid="point-at-vault"'));
    expect(vault).not.toMatch(/role="button"/);
  });
});

