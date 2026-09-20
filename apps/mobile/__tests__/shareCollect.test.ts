/**
 * @jest-environment jsdom
 */

/**
 * THE FORM, ON THE PAGE A STRANGER OPENS.
 *
 * `collectForm.test.ts` proves the logic; this proves the *page* — because the
 * bug class here is the one #755 already shipped once: a control that is
 * correct in a module and never reaches a screen.
 *
 * Three claims, and each is a way the page could be wrong while every unit
 * test passed:
 *
 *  1. **A read link shows the block; a collect link shows a form.** The
 *     difference is `note.collecting`, which the server decides. A page that
 *     drew a Send button from the note's own text would publish a write
 *     endpoint the owner never minted.
 *  2. **Nothing is drawn where the answer cannot be sent.** With no site key
 *     there is no challenge token and the server refuses every submission, so
 *     the fields are not drawn at all — rather than taking two minutes of
 *     somebody's typing and refusing at the end.
 *  3. **The page says an answer is final before it is sent**, because a
 *     stranger cannot read the responses file and there is no way back.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/** The action this page may call, and a record of whether it was. */
const mockSent: unknown[] = [];
/** What the next send does: land, or refuse with this code. */
let mockRefuseWith: { code: string; message: string } | null = null;
jest.mock("convex/react", () => ({
  useAction: () => async (args: unknown) => {
    if (mockRefuseWith !== null) {
      const error = new Error("refused") as Error & { data: unknown };
      error.data = mockRefuseWith;
      throw error;
    }
    mockSent.push(args);
    return { ok: true };
  },
}));

/*
  THE CHALLENGE IS STUBBED, AND ITS OWN FILE IS TESTED SEPARATELY.

  `HumanCheck.web.tsx` talks to Cloudflare; what is under test here is the
  form around it. The stub is a *getter* rather than a constant so one file can
  cover both states — and the "no check available" state is the one the real
  module is in with no site key, which `humanCheck.test.ts` pins on the real
  thing rather than on this.
*/
let mockCheckAvailable = true;
let mockTokenFromCheck: string | null = "widget-token";
jest.mock("../features/share/HumanCheck", () => ({
  get HUMAN_CHECK_AVAILABLE() {
    return mockCheckAvailable;
  },
  HumanCheck: ({ onToken }: { onToken: (token: string | null) => void }) => {
    onToken(mockTokenFromCheck);
    return null;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ShareForm } from "../features/share/ShareForm";
import { NoteBody } from "../features/share/NoteBody";
import { fenceAsForm, formInFence } from "../features/share/collectForm";
import { parseNote } from "../features/share/markdown";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});
beforeEach(() => {
  mockSent.length = 0;
  mockRefuseWith = null;
  mockCheckAvailable = true;
  mockTokenFromCheck = "widget-token";
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1024,
    configurable: true,
  });
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

const FENCE = [
  "id: intake",
  "responses: 1-projects/intake-responses.md",
  "layout: table",
  "submit: member",
  "votes: off",
  "fields:",
  "  - { name: who, type: line, max: 120, required: true }",
  "  - { name: brief, type: text, max: 2000 }",
].join("\n");

const NOTE = ["# Intake", "", "```form", FENCE, "```", ""].join("\n");

const ADDRESS = { kind: "token" as const, token: "f".repeat(64) };

/**
 * The `renderCode` hook, built from the same function `ShareScreen` builds it
 * from.
 *
 * `fenceAsForm` is imported rather than restated. This file had a hand-written
 * copy of that decision for about an hour, which is the #755 shape: sabotaging
 * the copy failed this test while the screen would have gone on drawing forms
 * on read links.
 */
function renderCodeFor(collecting: boolean) {
  return (block: { text: string; language?: string }) => {
    const form = fenceAsForm(block, { collecting });
    return form === null ? null : createElement(ShareForm, { form, address: ADDRESS });
  };
}

describe("a form fence on a shared note", () => {
  test("a READ link draws the block, not a form", () => {
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(NOTE).blocks,
        renderCode: renderCodeFor(false),
      }),
    );
    // The source, as any other code block. No control to press.
    expect(body.textContent).toContain("responses: 1-projects/intake-responses.md");
    expect(body.querySelector('[data-testid="share-form-send"]')).toBeNull();
    expect(body.textContent).not.toContain("Your answer is final");
  });

  test("a COLLECT link draws the form, with the author's own field names", () => {
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(NOTE).blocks,
        renderCode: renderCodeFor(true),
      }),
    );
    // The block's source is gone — replaced, not drawn alongside.
    expect(body.textContent).not.toContain("responses: 1-projects/intake-responses.md");
    expect(body.textContent).toContain("Who");
    expect(body.textContent).toContain("Brief");
  });

  /**
   * The one that matters most, and the reason the check is read before the
   * fields are drawn rather than after.
   *
   * With no site key there is no way to produce a token and the server refuses
   * every submission — which is the production state of a self-hosted
   * deployment that never set one. Drawing the fields anyway would take two
   * minutes of somebody's typing and refuse it at the end.
   */
  test("with no human check available, no fields are drawn at all", () => {
    mockCheckAvailable = false;
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(NOTE).blocks,
        renderCode: renderCodeFor(true),
      }),
    );
    expect(body.querySelector('[data-testid="share-form-send"]')).toBeNull();
    expect(body.textContent).not.toContain("Who");
    expect(mockSent).toEqual([]);
  });

  test("an editors-only form is not drawn through a link, because it would be refused", () => {
    const staff = NOTE.replace("submit: member", "submit: editor");
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(staff).blocks,
        renderCode: renderCodeFor(true),
      }),
    );
    // Falls through to the ordinary code block: the reader sees what is on the
    // note and no button that is going to fail.
    expect(body.textContent).toContain("submit: editor");
    expect(body.querySelector('[data-testid="share-form-send"]')).toBeNull();
  });

  test("a fence that does not parse falls through rather than half-drawing", () => {
    const broken = ["# Intake", "", "```form", "id: oops", "fields:", "  - { name: x }", "```"].join(
      "\n",
    );
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(broken).blocks,
        renderCode: renderCodeFor(true),
      }),
    );
    expect(body.textContent).toContain("id: oops");
    expect(body.querySelector('[data-testid="share-form-send"]')).toBeNull();
  });

  test("an ordinary code block is untouched by the hook", () => {
    const withCode = ["```js", "const x = 1;", "```"].join("\n");
    const body = mount(
      createElement(NoteBody, {
        blocks: parseNote(withCode).blocks,
        renderCode: renderCodeFor(true),
      }),
    );
    expect(body.textContent).toContain("const x = 1;");
  });

  test("and a note with no hook at all renders exactly as it always did", () => {
    const body = mount(createElement(NoteBody, { blocks: parseNote(NOTE).blocks }));
    expect(body.textContent).toContain("responses: 1-projects/intake-responses.md");
  });
});

/* -------------------------------- sending -------------------------------- */

/**
 * Press, and let the send settle.
 *
 * `act` in its synchronous form returns before a promise the handler started
 * has resolved, so an assertion about what the server answered would run
 * against the screen as it was mid-flight. The async form flushes the
 * microtask queue, which is what the person actually waits for.
 */
async function press(container: HTMLElement, testID: string): Promise<void> {
  const element = container.querySelector(`[data-testid="${testID}"]`);
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(container: HTMLElement, testID: string, value: string): void {
  const input = container.querySelector(`[data-testid="${testID}"]`) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function form() {
  return createElement(ShareForm, {
    form: formInFence(FENCE)!,
    address: ADDRESS,
  });
}

describe("sending an answer", () => {
  test("the page says the answer is final before there is a button to press", async () => {
    const body = mount(form());
    // Above the button, not after the send. A stranger cannot read the
    // responses file and cannot come back, so this is the one thing they have
    // to know while they can still decide not to.
    expect(body.textContent).toContain("Your answer is final");
    expect(body.querySelector('[data-testid="share-form-send"]')).not.toBeNull();
  });

  test("a required field left empty is refused without a round trip", async () => {
    const body = mount(form());
    await press(body, "share-form-send");
    expect(mockSent).toEqual([]);
    expect(body.textContent).toContain("who");
  });

  test("a filled-in answer goes with the link, the form's id, and the challenge", async () => {
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    expect(mockSent.length).toBe(1);
    expect(mockSent[0]).toEqual({
      token: ADDRESS.token,
      formId: "intake",
      values: [
        { field: "who", value: "Jordan" },
        { field: "brief", value: "" },
      ],
      challenge: "widget-token",
    });
  });

  test("...and nothing names a path, because the link decides where it lands", async () => {
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    const keys = Object.keys(mockSent[0] as Record<string, unknown>).sort();
    expect(keys).toEqual(["challenge", "formId", "token", "values"]);
  });

  test("once sent, the form is gone and says so — there is no second press", async () => {
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    expect(body.querySelector('[data-testid="share-form-sent"]')).not.toBeNull();
    expect(body.querySelector('[data-testid="share-form-send"]')).toBeNull();
    expect(body.textContent).toContain("cannot be changed or taken back");
  });

  test("a refusal about the LINK says one thing, whatever the server's words were", async () => {
    mockRefuseWith = { code: "LINK_NOT_COLLECTING", message: "revoked at 4pm" };
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    expect(body.textContent).not.toContain("revoked");
    expect(body.textContent).toContain("not taking answers");
    // Still fillable: the answer is still in the box, so nothing was lost.
    expect(body.querySelector('[data-testid="share-form-send"]')).not.toBeNull();
  });

  test("a refusal about this submission is shown as the server worded it", async () => {
    mockRefuseWith = { code: "COLLECT_CAP_REACHED", message: "no room" };
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    expect(body.textContent).toContain("all the answers it was set up for");
  });

  test("with no challenge token, nothing is sent and the person is told why", async () => {
    mockTokenFromCheck = null;
    const body = mount(form());
    type(body, "share-form-field-who", "Jordan");
    await press(body, "share-form-send");
    expect(mockSent).toEqual([]);
    expect(body.textContent).toContain("Complete the check");
  });
});
