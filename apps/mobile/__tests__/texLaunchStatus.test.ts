/**
 * @jest-environment jsdom
 */

/**
 * tex.lc's `/waitlist`, actually rendered (Tex launch, 2026-10-20). The page
 * reads where somebody stands from the server with the receipt this browser
 * holds, so the rules are about what the server's answer turns into:
 *
 *  1. **No receipt reads nothing** and says it cannot find a place here.
 *  2. **Waiting** shows the masked contact and the optional question; a
 *     saved answer goes to `answer` with the receipt, never an email.
 *  3. **Let in with a line** shows that line, a Messages link to it and the
 *     console; let in without one says the line is coming.
 *  4. **The receipt never reaches the page**, a link or a URL.
 *
 * Numbers here are fake (555 range) and exist only in this file.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `sms:` link pointing at a fixed number                          1
 *   the answer saved with the receipt left out                      1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

let mockStatus: unknown = undefined;
const mockQueryArgs: unknown[] = [];
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (_reference: never, args: unknown) => {
      mockQueryArgs.push(args);
      return args === "skip" ? undefined : mockStatus;
    },
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      mockCalls.push({ name: getFunctionName(reference), args });
      return { saved: true };
    },
  };
});
jest.mock("../features/chaos/Tex", () => ({ Tex: () => null }));
jest.mock("../features/tex/launch/TexJoin.web", () => ({ TexJoin: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexStatus, readableLine, texVCard } from "../features/tex/launch/TexStatus.web";

const RECEIPT = "ab".repeat(32);
const LINE = "+15555550142";
let unmount: (() => void) | null = null;

beforeEach(() => {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:card";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

afterEach(() => {
  unmount?.();
  unmount = null;
  localStorage.clear();
  mockStatus = undefined;
  mockQueryArgs.length = 0;
  mockCalls.length = 0;
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(TexStatus)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("the status page", () => {
  test("no receipt reads nothing and points at sign-in", () => {
    const page = mount();
    expect(mockQueryArgs.every((args) => args === "skip")).toBe(true);
    expect(page.textContent).toContain("We can't find your spot from this browser.");
    expect(page.querySelector('a[href="/login"]')).not.toBeNull();
  });

  test("waiting shows the masked number and saves an answer with the receipt", async () => {
    localStorage.setItem("context.waitlistReceipt", RECEIPT);
    mockStatus = { state: "waiting", contact: { kind: "phone", ending: "0142" }, useFor: null, texLine: null };
    const page = mount();
    expect(mockQueryArgs).toContainEqual({ receipt: RECEIPT });
    expect(page.textContent).toContain("You're on the list.");
    expect(page.textContent).toContain("•••• 0142");
    expect(page.textContent).toContain("What would you use Tex for?");
    const field = page.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "school pickups");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mockCalls).toEqual([
      { name: "functions/waitlistStatus:answer", args: { receipt: RECEIPT, useFor: "school pickups" } },
    ]);
  });

  test("let in with a line shows that line, a Messages link and the console", () => {
    localStorage.setItem("context.waitlistReceipt", RECEIPT);
    mockStatus = { state: "admitted", contact: { kind: "phone", ending: "0142" }, useFor: null, texLine: LINE };
    const page = mount();
    expect(page.textContent).toContain("You're in.");
    expect(page.textContent).toContain("+1 (555) 555-0142");
    expect(page.querySelector(`a[href="sms:${LINE}"]`)?.textContent).toContain("Open Messages");
    expect(page.querySelector('a[href="/console"]')?.textContent).toContain("Open console");
    expect(page.innerHTML).not.toContain(RECEIPT);
  });

  test("let in without a line says the line is coming, and still opens the console", () => {
    localStorage.setItem("context.waitlistReceipt", RECEIPT);
    mockStatus = { state: "admitted", contact: { kind: "phone", ending: "0142" }, useFor: null, texLine: null };
    const page = mount();
    expect(page.textContent).toContain("We're getting your Tex line ready.");
    expect(page.querySelector('a[href^="sms:"]')).toBeNull();
    expect(page.querySelector('a[href="/console"]')).not.toBeNull();
  });

  test("a receipt the server does not know is the not-found page", () => {
    localStorage.setItem("context.waitlistReceipt", RECEIPT);
    mockStatus = null;
    const page = mount();
    expect(page.textContent).toContain("We can't find your spot from this browser.");
  });
});

describe("the line, written down", () => {
  test("a North American number reads the usual way, others stay E.164", () => {
    expect(readableLine("+15555550142")).toBe("+1 (555) 555-0142");
    expect(readableLine("+447700900123")).toBe("+447700900123");
  });

  test("the contact card carries the line and nothing else personal", () => {
    const card = texVCard(LINE);
    expect(card).toContain(`TEL;TYPE=CELL:${LINE}`);
    expect(card.startsWith("BEGIN:VCARD\r\n")).toBe(true);
    expect(card).toContain("FN:Tex");
  });
});
