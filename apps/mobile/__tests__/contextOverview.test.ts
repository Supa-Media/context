/**
 * @jest-environment jsdom
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ContextOverview } from "../features/overview/ContextOverview";
import {
  CONTEXT_OVERVIEW_FACTS,
  CONTEXT_OVERVIEW_FOOT,
} from "../features/overview/copy";

// React only treats `act` as authoritative when this is set, and warns loudly
// on every call when it is not.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The six lines a stranger reads before they accept an invitation.
 *
 * This is the one screen in the product written for somebody who has never
 * heard of Context, which makes it the one screen where a sentence that
 * over-promises is never corrected by anything else they have seen. Two of the
 * six are product invariants rather than copy, and both fail in the same
 * direction — a reader believing they have been given something they have not:
 *
 *  - **`team` never means public.** There is no anonymous tier and there is not
 *    going to be one, so the sharing line must not leave room for one.
 *  - **A shared context has no ingestion address.** Mail lands in a personal
 *    context and nowhere else — `resolvePersonalContextForIngestion` decides
 *    that structurally, and a shared context's refusal is byte-identical to an
 *    unclaimed name's. A line advertising shared buckets, sitting beside five
 *    things that work today, is exactly where somebody infers a team capture
 *    address; the same product already shipped a capture address people
 *    forwarded mail to before anything was receiving it, so this is not a
 *    hypothetical failure mode.
 *
 * The rest are assertions that the component actually renders its copy — a
 * pure module full of correct sentences that no screen shows is the shape of
 * false green this project keeps producing.
 */

function render(): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ContextOverview, {}));
  });
  const text = container.textContent ?? "";
  act(() => root.unmount());
  container.remove();
  return text;
}

const SHARED = CONTEXT_OVERVIEW_FACTS.find(
  (fact) => fact.title === "Shared context buckets",
);

describe("the overview is six lines, in the order somebody needs them", () => {
  test("there are exactly six, and the first is the pitch", () => {
    expect(CONTEXT_OVERVIEW_FACTS).toHaveLength(6);
    expect(CONTEXT_OVERVIEW_FACTS[0]!.title).toBe("One context, every client");
  });

  test("the first line names the clients rather than describing them", () => {
    const body = CONTEXT_OVERVIEW_FACTS[0]!.body;
    for (const client of ["ChatGPT", "Claude", "Codex", "Notion AI"]) {
      expect(body).toContain(client);
    }
  });

  test("every line reaches the screen", () => {
    const text = render();
    for (const fact of CONTEXT_OVERVIEW_FACTS) {
      expect(text).toContain(fact.title);
      expect(text).toContain(fact.body);
    }
  });
});

describe("the shared-buckets line does not promise a team capture address", () => {
  test("it exists and is marked as not built yet", () => {
    // Unqualified, beside five things that work today, it reads as a sixth.
    expect(SHARED).toBeDefined();
    expect(SHARED!.status).toBe("coming soon");
  });

  test("the coming-soon marker is on the glass, not only in the data", () => {
    expect(render()).toContain("coming soon");
  });

  test("it says outright that a shared context has no address", () => {
    // Silence is not enough here. A reader who knows their own context has a
    // capture address will assume a shared one does too, and the refusal in
    // the control plane is byte-identical to an unclaimed name's — so they
    // would find out by forwarding mail into a void.
    expect(SHARED!.body).toMatch(/shared context has none/i);
  });

  test("no line anywhere offers an address on a context that cannot receive mail", () => {
    // The guard against a future edit, not against today's copy: an ingestion
    // address or an instruction to forward, on a screen about shared buckets,
    // is the claim this file exists to keep out.
    for (const fact of CONTEXT_OVERVIEW_FACTS) {
      const line = `${fact.title} ${fact.body}`;
      expect(line).not.toMatch(/@context\.lc/i);
      expect(line).not.toMatch(/\bforward\b/i);
      expect(line).not.toMatch(/\binbox\b/i);
    }
    const text = render();
    expect(text).not.toMatch(/@context\.lc/i);
    expect(text).not.toMatch(/\bforward\b/i);
  });
});

describe("sharing is with named people, and there is no public tier", () => {
  const sharing = CONTEXT_OVERVIEW_FACTS.find((fact) => fact.title === "Named people only");

  test("the line names who can see a context", () => {
    expect(sharing).toBeDefined();
    expect(sharing!.body).toMatch(/named people/i);
  });

  test("and rules out an anonymous one rather than leaving it open", () => {
    // `team` means named people the owner granted access to. A reader who has
    // met "team" in any other product will assume a public link exists unless
    // told it does not.
    expect(sharing!.body).toMatch(/no anonymous tier/i);
    expect(render()).toMatch(/never the public internet/i);
  });
});

describe("the trust sentence is the onboarding flow's, word for word", () => {
  test("it renders under the six lines", () => {
    expect(render()).toContain(CONTEXT_OVERVIEW_FOOT);
  });

  test("and it is the same sentence `WelcomeScreen` shows, not a paraphrase", () => {
    // Somebody who accepts an invitation today and runs onboarding next week
    // should meet one promise twice. Two paraphrases are two promises they
    // have to check against each other, and the moment they differ, one of
    // them is the wrong one.
    const welcome = readFileSync(
      join(__dirname, "..", "features", "onboarding", "WelcomeScreen.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(welcome).toContain(CONTEXT_OVERVIEW_FOOT);
  });
});
