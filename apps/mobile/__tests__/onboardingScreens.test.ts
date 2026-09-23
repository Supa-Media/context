/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { NameStep } from "../features/onboarding/steps/NameStep";
import { StructureStep } from "../features/onboarding/steps/StructureStep";
import { VaultImportStep } from "../features/onboarding/steps/VaultImportStep";
import { ConnectionsStep } from "../features/onboarding/redesign/ConnectionsStep";
import { ForkStep, type ForkOffer } from "../features/onboarding/redesign/ForkStep";
import { PaymentStep } from "../features/onboarding/redesign/PaymentStep";
import { DoneStep } from "../features/onboarding/steps/DoneStep";
import { PointAtBucket } from "../features/onboarding/steps/PointAtBucket";
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH } from "../features/onboarding/name";
import { nameStatus } from "../features/onboarding/name";
import { emptyCustomFolders, validateCustomFolders } from "../features/onboarding/structure";
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
    shape: { storage: "connected" },
    owned: 0,
    claimed: null,
    forkOffer: null,
    pickManaged: () => {},
    pickOwn: () => {},
    startingFree: false,
    dryRun: null,
    finishDryRun: () => {},
    finishLive: () => {},
    // What the control plane answers today: no email receiver is deployed.
    // `captureHonesty.test.ts` owns the assertions about what that does to the
    // capture address on the last screen.
    captureReceivesMail: false,
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
    // provide managed storage, which is every deployment until an account
    // exists to put the buckets in.
    managed: null,
    skipStorage: () => {},
    continuePastStorage: () => {},
    skipVaultImport: () => {},
    finishVaultImport: () => {},
    structureStep: { kind: "ask" },
    template: "para",
    setTemplate: () => {},
    folders: emptyCustomFolders(),
    setFolders: () => {},
    folderErrors: {},
    applying: false,
    structureFailure: null,
    canApply: true,
    applyStructure: async () => {},
    skipStructure: () => {},
    finishAgents: () => {},
    bootstrapPrompt: "",
    finishBootstrap: () => {},
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

describe("the layout screen", () => {
  test("never says the deployment cannot lay folders down", () => {
    // That caveat was rendered from a probe that could only ever answer "no",
    // so it was one line away from being on screen for everybody. It is gone,
    // along with the probe.
    const { text } = render(createElement(StructureStep, { controller: controller({}) }));
    expect(text).not.toMatch(/cannot lay folders down/i);
  });

  test("holds the button for a custom layout with nothing named in it", () => {
    const rendered = render(
      createElement(StructureStep, {
        controller: controller({ template: "custom", canApply: false }),
      }),
    );
    expect(rendered.html).toContain("disabled");
    expect(rendered.text).toMatch(/at least one folder/i);
  });

  test("offers the button once a folder is named", () => {
    const folders = [{ name: "clients", description: "one per engagement" }];
    const rendered = render(
      createElement(StructureStep, {
        controller: controller({
          template: "custom",
          folders,
          folderErrors: validateCustomFolders(folders),
          canApply: true,
        }),
      }),
    );
    expect(rendered.text).toMatch(/1 folder\b/);
  });
});

describe("the Obsidian vault screen", () => {
  test("offers a folder import for a new customer-owned or managed bucket", () => {
    const { text } = render(
      withConvex(
        createElement(VaultImportStep, {
          controller: controller({
            step: "vault",
            claimed: { workspaceId: "w1" as never, slug: "seyi" },
          }),
        }),
      ),
    );

    expect(text).toContain("Have an Obsidian vault or existing Markdown notes?");
    expect(text).toContain("Choose a vault or notes folder");
    expect(text).toContain("No, start fresh");
    expect(text).toContain("Existing files stay unchanged.");
  });

  test("still offers an import when connected storage already contains files", () => {
    const { text } = render(
      withConvex(
        createElement(VaultImportStep, {
          controller: controller({
            step: "vault",
            claimed: { workspaceId: "w1" as never, slug: "seyi" },
            structureStep: { kind: "existing" },
          }),
        }),
      ),
    );

    expect(text).toContain("Have an Obsidian vault or existing Markdown notes?");
    expect(text).toContain("How should these notes be added?");
    expect(text).toContain("Merge without replacing");
    expect(text).toContain("Keep it in its own folder");
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

describe("the fork", () => {
  const fork = (offer: ForkOffer) =>
    render(
      createElement(ForkStep, { offer, onPickManaged: () => {}, onPickBYO: () => {}, onOpenInvitations: () => {} }),
    );

  test("the free card names the cap it enforces, and no figure nothing meters", () => {
    // Bytes are not metered on the free tier, so a byte figure would be a
    // limit nothing enforces — and `&nbsp;` in a React Native string renders
    // as those six characters.
    const { text } = fork({ kind: "free", cap: 1000 });
    expect(text).toContain("1,000 notes");
    expect(text).not.toMatch(/MB|GB|&nbsp;/);
    expect(text).toMatch(/reading, editing and exporting/i);
  });

  test("where the deployment offers no free tier, the card is the paid one or none at all", () => {
    expect(fork({ kind: "paid", price: "$5 a month" }).text).toContain("$5 a month");
    const none = fork(null);
    expect(none.text).not.toMatch(/Start free|managed storage/i);
    expect(none.text).toContain("I have a bucket");
  });

  test("the invitation escape hatch is a link a screen reader can find", () => {
    const { html } = fork(null);
    expect(html).toMatch(/role="link"[^>]*>Open it here|Open it here[^<]*<\/[a-z]+>/);
    expect(html).toMatch(/aria-label="Open an invitation"/);
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

describe("the last screen", () => {
  test("warns the person whose bucket check failed", () => {
    // "Carry on anyway" used to be recorded as a connected bucket, so this
    // warning was withheld from exactly the person who most needed it.
    const { text } = render(
      createElement(DoneStep, {
        controller: controller({
          shape: { storage: "unverified" },
          step: "done",
        }),
        onOpenConsole: () => {},
      }),
    );

    expect(text).toMatch(/could not confirm your bucket/i);
    expect(text).toMatch(/never looked inside it/i);
  });

  test("warns the person who skipped, in different words", () => {
    const { text } = render(
      createElement(DoneStep, {
        controller: controller({ shape: { storage: "skipped" }, step: "done" }),
        onOpenConsole: () => {},
      }),
    );

    expect(text).toMatch(/no bucket is connected/i);
  });

  test("says nothing about the bucket when the bucket is fine", () => {
    const { text } = render(
      createElement(DoneStep, {
        controller: controller({
          shape: { storage: "connected" },
          step: "done",
        }),
        onOpenConsole: () => {},
      }),
    );

    expect(text).not.toMatch(/nowhere to keep notes/i);
  });
});

/*
  The canvas screens that replaced the first run's original ones: A-03 (the
  handle), B1-01 (point at a bucket) and A-09 (done). Each keeps a claim the
  design would have let slip, and these pin that claim.
*/
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

describe("the last screen (A-09)", () => {
  test("says You're set up only where storage answers", () => {
    const done = render(
      createElement(DoneStep, { controller: controller({ shape: { storage: "connected" }, step: "done" }), onOpenConsole: () => {} }),
    );
    expect(done.text).toContain("You're set up.");
    const skipped = render(
      createElement(DoneStep, { controller: controller({ shape: { storage: "skipped" }, step: "done" }), onOpenConsole: () => {} }),
    );
    expect(skipped.text).not.toContain("You're set up.");
    expect(skipped.text).toMatch(/storage isn't yet/);
  });

  test("states the exit, and draws no Download button with nothing behind it", () => {
    const { text, html } = render(
      createElement(DoneStep, { controller: controller({ step: "done" }), onOpenConsole: () => {} }),
    );
    expect(text).toMatch(/Take everything with you/);
    expect(text).toMatch(/downloads as a \.zip/);
    expect(html).not.toMatch(/>Download</);
  });
});
