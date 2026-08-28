/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IngestionCard } from "../features/console/ingestion/IngestionCard";
import { DoneStep } from "../features/onboarding/steps/DoneStep";
import {
  NO_INGESTION_ADDRESS,
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

/**
 * Every way the allow-list copy can imply it is a boundary.
 *
 * ## The bug this pins
 *
 * The receiver used to refuse any message whose sender's domain it could not
 * verify, and the console described the list as "the security control", with a
 * summary ending "Nobody else." Both were fair while a gate existed. The gate
 * refused two real deliveries — an ordinary Gmail forward, and then a message
 * whose `Authentication-Results` *Cloudflare itself* had folded — so it was
 * removed, and mail is captured and labelled instead. See the block at the top
 * of `infra/email-worker/src/auth.ts`.
 *
 * That leaves the list doing something narrower than it said. It decides
 * whether a message is captured, and a sender who knows one address on it can
 * put that address in `From:` and pass. It still keeps the ordinary internet
 * out, which is worth having and worth configuring. It is not an assurance
 * about who wrote a note, and no screen may read like one.
 *
 * ## Why a vocabulary ban rather than pinned sentences
 *
 * Same reason as `PRESENT_TENSE_CLAIMS` above: pinning the new sentences would
 * pass forever while somebody added a reassuring sixth one beside them. These
 * are the specific words that turn a filter into a promise, and they are chosen
 * so that no honest sentence trips them — "it does not prove who sent it"
 * contains none of them.
 */
const FALSE_ASSURANCES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "the list is a closed set", pattern: /\bnobody else\b/i },
  { what: "the list is a closed set", pattern: /\bno one else\b/i },
  { what: "the list is a security boundary", pattern: /\bsecurity control\b/i },
  { what: "senders are verified", pattern: /\bverified sender/i },
  { what: "we check who sent it", pattern: /\bwe\s+(check|verify|confirm)\b/i },
  {
    what: "the address cannot be forged",
    pattern: /\bcan(not|'t| not)\s+be\s+(spoofed|forged|faked)\b/i,
  },
  { what: "something is guaranteed", pattern: /\bguarantee/i },
];

/** Every banned assurance the copy makes, named, so a failure says which. */
function assurancesFound(text: string): string[] {
  return FALSE_ASSURANCES.filter(({ pattern }) => pattern.test(text)).map(
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
   * Every state the ingestion card can be in, all of them reachable today, and
   * none of them entitled to a delivery claim while no receiver exists.
   *
   * `available: true` used to spell what is now `availability: "available"`,
   * and the list used to open with "a deployment with no ingestion module at
   * all". That state is gone rather than renamed: the flag behind it was
   * `anyApi`, a proxy that mints a reference for any property name, so the
   * probe could never answer false and the state was never reachable (issue
   * #16). What took its slot is a state that genuinely is reachable and is a
   * far worse place to make a delivery claim — a **shared** context, which has
   * no capture address at all.
   */
  const states: ReadonlyArray<{ name: string; state: IngestionState }> = [
    {
      name: "a shared context, which has no capture address at all",
      state: NO_INGESTION_ADDRESS,
    },
    {
      name: "the settings query still in flight",
      state: { settings: null, loading: true, availability: "available" },
    },
    {
      name: "a context with no policy row — the fail-closed floor",
      state: { settings: null, loading: false, availability: "available", save: async () => {} },
    },
    {
      name: "a personal context whose rules are somebody else's to read",
      state: { settings: null, loading: false, availability: "available" },
    },
    {
      name: "a configured policy, read-only",
      state: { settings: settings(), loading: false, availability: "available" },
    },
    {
      name: "a configured policy an owner can edit",
      state: {
        settings: settings(),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
    {
      name: "an open drop-box",
      state: {
        settings: settings({ allowAnySender: true, allowedSenders: [] }),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
    {
      name: "a control plane too old to carry the field",
      // `receiving` absent. Absence is not a yes — the same rule the storage
      // pane applies to facts the capability probe never persisted.
      state: { settings: settings(), loading: false, availability: "available" },
    },
    {
      name: "a live receiver, but a context that is not allowed to use it",
      // The composition, rendered: `receiving: true` from a deployment whose
      // worker really is up, on a context that has no address. A card that
      // asked only the deployment's question would announce delivery here.
      state: {
        settings: settings({ receiving: true }),
        loading: false,
        availability: "no-address",
      },
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

describe("no surface describes the allow-list as a boundary", () => {
  /**
   * Every state that draws the list, including the one where the list is real
   * and configured — which is the state an owner will actually be looking at
   * when they decide how much to trust a capture.
   */
  const drawn: ReadonlyArray<{ name: string; state: IngestionState }> = [
    {
      name: "a configured policy an owner can edit",
      state: {
        settings: settings(),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
    {
      name: "a configured policy, read-only",
      state: { settings: settings(), loading: false, availability: "available" },
    },
    {
      name: "a configured policy behind a live receiver",
      state: {
        settings: settings({ receiving: true }),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
    {
      name: "an open drop-box",
      state: {
        settings: settings({ allowAnySender: true, allowedSenders: [] }),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
    {
      name: "a list nobody has added to yet",
      state: {
        settings: settings({ allowedSenders: [], allowedDomains: [] }),
        loading: false,
        availability: "available",
        save: async () => {},
      },
    },
  ];

  for (const { name, state } of drawn) {
    test(`the ingestion card promises nothing the list cannot keep: ${name}`, () => {
      expect(assurancesFound(card(state).text)).toEqual([]);
    });
  }

  test("the one-line policy summaries promise nothing either", () => {
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
      expect(assurancesFound(summary.text)).toEqual([]);
    }
  });

  /**
   * And the other half, which the ban alone cannot get: silence is not honesty
   * either. An owner reading the card must be told, in words, that an email can
   * claim any address — otherwise the list reads as an assurance simply because
   * nothing said it was not one.
   *
   * Sabotage: delete the second clause of the `hint` and this fails while every
   * ban above still passes.
   */
  test("the card says out loud that a From: line is a claim", () => {
    const rendered = card({
      settings: settings(),
      loading: false,
      availability: "available",
      save: async () => {},
    }).text;
    expect(rendered).toMatch(/can claim to be from any address/i);
    expect(rendered).toMatch(/filters/i);
    expect(rendered).toMatch(/does not prove who sent it/i);
  });

  /**
   * The summary is read straight out of the pure module by anything wanting a
   * one-line description, so it carries the caveat itself rather than relying
   * on sitting next to the hint.
   */
  test("the configured-list summary carries the caveat on its own", () => {
    const summary = describeSenderPolicy({
      ...emptyDraft(),
      allowedSenders: ["seyi@publicworship.life"],
    });
    expect(summary.text).toMatch(/does not prove who sent it/i);
    expect(summary.text).toMatch(/From:/);
    // Still `ok`. Accurate, not alarming: a permanent warning on the correct
    // configuration teaches an owner to ignore warnings.
    expect(summary.tone).toBe("ok");
  });
});

/**
 * A personal context with a policy, and nothing receiving at the other end.
 *
 * This is the state the "the address is still shown" assertions below are
 * about, and it used to be spelled `UNAVAILABLE_INGESTION`. That constant now
 * means something else — a *shared* context, which has no capture address and
 * so has no address to show — so pointing these tests at it would have quietly
 * inverted what they check. The property they pin is unchanged: a context that
 * has an address still sees it, with no receiver behind it.
 */
const DARK: IngestionState = {
  settings: settings(),
  loading: false,
  availability: "available",
};

describe("the address is still shown, and still says what it is", () => {
  test("the console shows the address even with nothing receiving", () => {
    expect(card(DARK).text).toContain("seyi@context.lc");
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
      card(DARK).text,
      render(createElement(DoneStep, { controller: controller({}), onOpenConsole: () => {} }))
        .text,
    ]) {
      expect(text).toMatch(/nothing is receiving mail at it yet/i);
      expect(text).toMatch(/bounces/i);
    }
  });

  /**
   * And the other half: a context with no address is shown no address, rather
   * than the honest-but-useless "reserved for you" sentence about a mailbox it
   * will never have. This is the assertion that keeps the two absences from
   * being collapsed into one screen.
   */
  test("a shared context is shown no address at all, not a dark one", () => {
    const shared = card(NO_INGESTION_ADDRESS);
    expect(shared.text).not.toContain("seyi@context.lc");
    expect(shared.text).not.toMatch(/nothing is receiving mail at it yet/i);
    expect(shared.text).toMatch(/does not receive email/i);
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
    expect(card(DARK).html).not.toMatch(/Copy your ingestion address/i);
  });

  test("the console offers no copy button to a context with no address", () => {
    expect(card(NO_INGESTION_ADDRESS).html).not.toMatch(/Copy your ingestion address/i);
  });

  test("the first run offers no copy button while nothing is receiving", () => {
    // The shape is a run that skipped storage, which is the one that still
    // shows the endpoint on this screen: the tools step, which otherwise owns
    // it, only exists on a run whose bucket connected. Asserting a live copy
    // button alongside the withheld one is the point — this must not turn into
    // "the last screen has no copy buttons".
    const { html } = render(
      createElement(DoneStep, {
        controller: controller({ shape: { storage: "skipped" } }),
        onOpenConsole: () => {},
      }),
    );
    expect(html).not.toMatch(/Copy your capture address/i);
    expect(html).toMatch(/Copy your MCP endpoint/i);
  });

  test("a run that reached the tools step is not shown the endpoint twice", () => {
    // It is on the previous screen, which is about it. The same field on two
    // consecutive screens reads as an oversight.
    const { html } = render(
      createElement(DoneStep, {
        controller: controller({ shape: { storage: "connected" } }),
        onOpenConsole: () => {},
      }),
    );
    expect(html).not.toMatch(/Copy your MCP endpoint/i);
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
      availability: "available",
    };
    expect(receivesMail(live)).toBe(true);

    expect(
      receivesMail({
        settings: settings({ receiving: false }),
        loading: false,
        availability: "available",
      }),
    ).toBe(false);
    // Field absent — an older control plane. Silence is not consent.
    expect(receivesMail({ settings: settings(), loading: false, availability: "available" })).toBe(
      false,
    );
    // No row, and still loading.
    expect(receivesMail({ settings: null, loading: true, availability: "available" })).toBe(false);
    expect(receivesMail({ settings: null, loading: false, availability: "available" })).toBe(false);
    expect(receivesMail(NO_INGESTION_ADDRESS)).toBe(false);
  });

  /**
   * **Two questions, and delivery needs a yes to both.**
   *
   * They were found by two different bugs and they are about different things:
   * `receiving` is a fact about the *deployment* — is a receiver up at all —
   * and `availability` is a fact about the *context* — may this one receive
   * mail, which only a personal context may. A live receiver does not give a
   * shared context an inbox.
   *
   * So the interesting case is the one neither original change had to think
   * about: the day the Email Worker ships, `receiving` becomes `true` for every
   * context on the deployment at once, shared ones included. If `receivesMail`
   * asked only the deployment's question, that is the day every team in the
   * product starts being told mail lands in a context that would refuse it.
   */
  test("a live receiver does not give a shared context an inbox", () => {
    expect(
      receivesMail({
        settings: settings({ receiving: true }),
        loading: false,
        availability: "no-address",
      }),
    ).toBe(false);
  });

  test("a context that may receive still needs something on the other end", () => {
    expect(
      receivesMail({
        settings: settings({ receiving: false }),
        loading: false,
        availability: "available",
      }),
    ).toBe(false);
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
      availability: "available",
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
    expect(done.text).toMatch(/it lands in your brain/);
    expect(done.html).toMatch(/Copy your capture address/i);
  });
});
