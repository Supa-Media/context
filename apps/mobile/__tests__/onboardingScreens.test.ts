/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NameStep } from "../features/onboarding/steps/NameStep";
import { StructureStep } from "../features/onboarding/steps/StructureStep";
import { AgentsStep } from "../features/onboarding/steps/AgentsStep";
import { defaultSeedPrompt, seedPromptFor } from "../features/onboarding/agents";
import { DoneStep } from "../features/onboarding/steps/DoneStep";
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
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const rendered = { text: container.textContent ?? "", html: container.innerHTML };
  act(() => root.unmount());
  container.remove();
  return rendered;
}

/** A controller with nothing happening, for a screen to read. */
function controller(overrides: Partial<OnboardingController>): OnboardingController {
  return {
    step: "name",
    shape: { storage: "connected" },
    owned: 0,
    claimed: null,
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
    skipStorage: () => {},
    continuePastStorage: () => {},
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
    seedPrompt: "",
    finishAgents: () => {},
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
          nameStatus: nameStatus("seyi", { available: true, normalized: "seyi" }),
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
          nameStatus: nameStatus("seyi", { available: true, normalized: "seyi" }),
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
          nameStatus: nameStatus("seyi", { available: true, normalized: "seyi" }),
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

describe("the tools screen", () => {
  test("hands over a prompt naming the folders this context actually has", () => {
    // The failure this catches is silent and lands in somebody else's product:
    // a prompt telling their AI to file work under `1-projects/` when they
    // named their own folders one screen ago and have no such folder.
    const { text } = render(
      createElement(AgentsStep, {
        controller: controller({
          step: "agents",
          seedPrompt: seedPromptFor(["work", "reading"]),
        }),
        onContinue: () => {},
      }),
    );
    expect(text).toContain("work/");
    expect(text).toContain("reading/");
    expect(text).not.toContain("1-projects/");
  });

  test("does not imply a connected client sees everything", () => {
    // Every grant defaults to `team`, owners included. A first-run screen
    // promising otherwise describes a product we deliberately do not ship.
    const { text } = render(
      createElement(AgentsStep, {
        controller: controller({ step: "agents", seedPrompt: defaultSeedPrompt() }),
        onContinue: () => {},
      }),
    );
    expect(text).toMatch(/team is the default/i);
  });
});

describe("the last screen", () => {
  test("warns the person whose bucket check failed", () => {
    // "Carry on anyway" used to be recorded as a connected bucket, so this
    // warning was withheld from exactly the person who most needed it.
    const { text } = render(
      createElement(DoneStep, {
        controller: controller({ shape: { storage: "unverified" }, step: "done" }),
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
        controller: controller({ shape: { storage: "connected" }, step: "done" }),
        onOpenConsole: () => {},
      }),
    );

    expect(text).not.toMatch(/nowhere to keep notes/i);
  });
});
