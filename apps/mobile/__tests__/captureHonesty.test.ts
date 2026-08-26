/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IngestionCard } from "../features/console/ingestion/IngestionCard";
import { DoneStep } from "../features/onboarding/steps/DoneStep";
import {
  UNAVAILABLE_INGESTION,
  describeSenderPolicy,
  emptyDraft,
  receivesMail,
  type IngestionSettings,
  type IngestionState,
} from "../features/console/ingestion/settings";
import { emptyCustomFolders } from "../features/onboarding/structure";
import type { OnboardingController } from "../features/onboarding/useOnboarding";

/**
 * No surface may claim that mail currently lands anywhere.
 *
 * ## The bug this pins
 *
 * There is no email receiver deployed. `context.lc` has no MX route to one, so
 * a message sent to a capture address is refused at the edge with
 * `550 5.1.1 Address does not exist`. The owner of this product mailed the
 * address the console told him to use and got exactly that back.
 *
 * What made it believable was that the console did not merely *show* an
 * address. It showed one with a Copy button, under "Forward any email here and
 * it lands in `0-inbox/`", beside an allow-list whose warnings all pointed the
 * *safe* way — "nothing is accepted until an owner sets a target folder",
 * "everything else is dropped". Careful, conservative, fail-closed copy about
 * a pipeline that has never run once. A section that hedges in the safe
 * direction reads as more trustworthy than one that does not, which is what
 * makes this class of bug worth a test rather than a comment.
 *
 * ## What is asserted, and why it is phrased as a ban
 *
 * A test that pinned the *new* sentences would pass forever while somebody
 * added a sixth one beside them. So this bans a **vocabulary**: the finite set
 * of ways a screen can assert that mail is being handled right now. Any new
 * surface, or any new sentence on an existing one, is caught by the same
 * patterns without anybody remembering to extend the test.
 *
 * `react-native-web` renders these components to real DOM (see
 * `jest.config.js`), so `textContent` below is the copy a person actually
 * reads, in the order they read it.
 */

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Rendered {
  text: string;
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

/**
 * Every way a surface can assert that mail is being handled *now*.
 *
 * Three families, because there were three different false promises on screen
 * and a fix that only caught one of them would have left the other two:
 *
 *  - **delivery** — "it lands in 0-inbox/", "forward anything here and it
 *    lands in your context";
 *  - **acceptance** — "any sender is accepted", "nothing sent to this address
 *    is accepted until…", "mail is accepted from 1 address";
 *  - **rejection** — "everything else is dropped", "mail to this address is
 *    dropped". These were the most convincing of the lot: a product that tells
 *    you it is *throwing mail away* is obviously running.
 *
 * Future and conditional forms are deliberately not banned ("will land",
 * "may send", "is allowed to post"). The rule is that a screen must not assert
 * a thing that is happening; describing a rule an owner has configured, or
 * something that will happen later, is honest and useful.
 */
const PRESENT_TENSE_CLAIMS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "mail lands somewhere", pattern: /\b(it|they)\s+lands?\b/i },
  { what: "mail lands somewhere", pattern: /\blands?\s+in\s+(your|the|0-inbox|\d)/i },
  { what: "forwarding works", pattern: /\bforward(ed)?\s+(any|anything|to it)\b/i },
  { what: "senders are accepted", pattern: /\b(is|are)\s+accepted\b/i },
  { what: "senders are accepted", pattern: /\bmail\s+is\s+accepted\b/i },
  { what: "mail is dropped", pattern: /\b(is|are)\s+dropped\b/i },
  { what: "senders get through", pattern: /\bgets?\s+through\b/i },
  { what: "the folder is created for you", pattern: /\bis\s+created\s+if\b/i },
];

/** Every banned claim the copy makes, named, so a failure says which sentence. */
function claimsFound(text: string): string[] {
  return PRESENT_TENSE_CLAIMS.filter(({ pattern }) => pattern.test(text)).map(
    ({ what, pattern }) => `${what} (${pattern})`,
  );
}

function settings(overrides: Partial<IngestionSettings> = {}): IngestionSettings {
  return {
    address: "seyi@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: ["seyi@publicworship.life"],
    allowedDomains: [],
    allowAnySender: false,
    ...overrides,
  };
}

function card(state: IngestionState): Rendered {
  return render(
    createElement(IngestionCard, {
      state,
      fallbackAddress: "seyi@context.lc",
      folders: ["0-inbox", "1-projects"],
    }),
  );
}

/** A controller with nothing happening, for the last onboarding screen to read. */
function controller(overrides: Partial<OnboardingController>): OnboardingController {
  return {
    step: "done",
    shape: { storage: "connected" },
    contextCount: 1,
    claimed: { workspaceId: "w1" as OnboardingController["claimed"] & string, slug: "seyi" },
    captureReceivesMail: false,
    name: "seyi",
    setName: () => {},
    nameStatus: { kind: "empty" },
    claiming: false,
    claimFailure: null,
    claim: async () => {},
    canClaim: false,
    connect: async () => ({ status: "connected" }),
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
    ...overrides,
  } as OnboardingController;
}

/* -------------------------------------------------------------------------- */

describe("no surface claims mail currently lands anywhere", () => {
  /**
   * The five states the ingestion card can be in, all of them reachable today,
   * and none of them entitled to a delivery claim while no receiver exists.
   */
  const states: ReadonlyArray<{ name: string; state: IngestionState }> = [
    {
      name: "a deployment with no ingestion module at all",
      state: UNAVAILABLE_INGESTION,
    },
    {
      name: "the settings query still in flight",
      state: { settings: null, loading: true, available: true },
    },
    {
      name: "a context with no policy row — the fail-closed floor",
      state: { settings: null, loading: false, available: true },
    },
    {
      name: "a configured policy, read-only",
      state: { settings: settings(), loading: false, available: true },
    },
    {
      name: "a configured policy an owner can edit",
      state: {
        settings: settings(),
        loading: false,
        available: true,
        save: async () => {},
      },
    },
    {
      name: "an open drop-box",
      state: {
        settings: settings({ allowAnySender: true, allowedSenders: [] }),
        loading: false,
        available: true,
        save: async () => {},
      },
    },
    {
      name: "a control plane too old to carry the field",
      // `receiving` absent. Absence is not a yes — the same rule the storage
      // pane applies to facts the capability probe never persisted.
      state: { settings: settings(), loading: false, available: true },
    },
  ];

  for (const { name, state } of states) {
    test(`the ingestion card makes no delivery claim: ${name}`, () => {
      expect(claimsFound(card(state).text)).toEqual([]);
    });
  }

  test("the last screen of the first run makes no delivery claim", () => {
    const { text } = render(
      createElement(DoneStep, { controller: controller({}), onOpenConsole: () => {} }),
    );
    expect(claimsFound(text)).toEqual([]);
  });

  /**
   * The policy summaries are rendered by the card, but they are also read
   * straight out of the pure module by anything that wants a one-line
   * description — so they are pinned at the source too. All three used to
   * assert a running pipeline; none may.
   */
  test("the one-line policy summaries describe the list, not the pipeline", () => {
    const summaries = [
      describeSenderPolicy(emptyDraft()),
      describeSenderPolicy({ ...emptyDraft(), allowAnySender: true }),
      describeSenderPolicy({
        ...emptyDraft(),
        allowedSenders: ["seyi@publicworship.life"],
        allowedDomains: ["globalecho.org"],
      }),
    ];
    for (const summary of summaries) {
      expect(claimsFound(summary.text)).toEqual([]);
    }
  });
});

describe("the address is still shown, and still says what it is", () => {
  test("the console shows the address even with nothing receiving", () => {
    expect(card(UNAVAILABLE_INGESTION).text).toContain("seyi@context.lc");
  });

  test("the first run shows the address even with nothing receiving", () => {
    const { text } = render(
      createElement(DoneStep, { controller: controller({}), onOpenConsole: () => {} }),
    );
    expect(text).toContain("seyi@context.lc");
  });

  test("both surfaces say, in one sentence, that mail sent today bounces", () => {
    // One sentence, not a stack of hedges. Somebody who reads only this must
    // come away knowing not to try it yet, and why.
    for (const text of [
      card(UNAVAILABLE_INGESTION).text,
      render(createElement(DoneStep, { controller: controller({}), onOpenConsole: () => {} }))
        .text,
    ]) {
      expect(text).toMatch(/nothing is receiving mail at it yet/i);
      expect(text).toMatch(/bounces/i);
    }
  });
});

describe("the Copy affordance does not invite someone to use a dead address", () => {
  /**
   * A visible address is information; a Copy button is an instruction. The
   * owner followed the instruction. It is withheld — not disabled with a
   * tooltip — on the same rule this codebase already applies to `save` and
   * `StorageActions`: a control that is never offered cannot mislead.
   */
  test("the console offers no copy button while nothing is receiving", () => {
    expect(card(UNAVAILABLE_INGESTION).html).not.toMatch(/Copy your ingestion address/i);
  });

  test("the first run offers no copy button while nothing is receiving", () => {
    const { html } = render(
      createElement(DoneStep, { controller: controller({}), onOpenConsole: () => {} }),
    );
    expect(html).not.toMatch(/Copy your capture address/i);
    // The MCP endpoint is a live thing and keeps its copy button — this must
    // not turn into "the last screen has no copy buttons".
    expect(html).toMatch(/Copy your MCP endpoint/i);
  });
});

describe("the gate is the control plane's answer, not a client-side guess", () => {
  /**
   * `receivesMail` is the single place allowed to conclude "mail lands here",
   * and it says yes only when the backend positively said so. Every other
   * state is a no, because none of them are a yes.
   */
  test("only a positive answer from the control plane is a yes", () => {
    const live: IngestionState = {
      settings: settings({ receiving: true }),
      loading: false,
      available: true,
    };
    expect(receivesMail(live)).toBe(true);

    expect(receivesMail({ settings: settings({ receiving: false }), loading: false, available: true })).toBe(false);
    // Field absent — an older control plane. Silence is not consent.
    expect(receivesMail({ settings: settings(), loading: false, available: true })).toBe(false);
    // No row, still loading, no module.
    expect(receivesMail({ settings: null, loading: true, available: true })).toBe(false);
    expect(receivesMail({ settings: null, loading: false, available: true })).toBe(false);
    expect(receivesMail(UNAVAILABLE_INGESTION)).toBe(false);
  });

  /**
   * And when it *is* a yes, the delivery copy and the Copy button come back on
   * their own. This is the assertion that makes the receiver's landing a
   * one-line change rather than a hunt: nothing below needs editing then.
   */
  test("a receiver on the other end restores the delivery copy and the copy button", () => {
    const rendered = card({
      settings: settings({ receiving: true }),
      loading: false,
      available: true,
    });
    expect(rendered.text).toMatch(/Forward any email here and it lands in/);
    expect(rendered.html).toMatch(/Copy your ingestion address/i);
    expect(rendered.text).not.toMatch(/nothing is receiving mail at it yet/i);

    const done = render(
      createElement(DoneStep, {
        controller: controller({ captureReceivesMail: true }),
        onOpenConsole: () => {},
      }),
    );
    expect(done.text).toMatch(/it lands in your context/);
    expect(done.html).toMatch(/Copy your capture address/i);
  });
});
