/**
 * @jest-environment jsdom
 */

/**
 * A HELD EMAIL, ON THE GLASS.
 *
 * Tex's ask that is one email is drawn as a card: its fields, its body, and Send, Not now and the reply arrow. This
 * mounts `TexAskCard` on its own and proves what the person sees and what a press sends. Fake values only:
 * example.test addresses.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AnswerChoice, AskCard } from "../features/tex/chat/appChatGateway";
import { EDIT_HINT, TexAskCard, askLead } from "../features/tex/chat/TexAskCard";

const ROW = "r1";
const AT = new Date(2026, 10, 19, 9, 5).getTime();

function email(over: Partial<Extract<AskCard, { kind: "email" }>> = {}): AskCard {
  return {
    kind: "email",
    state: "wait",
    from: "me@example.test",
    to: "sam@example.test",
    cc: "",
    subject: "Q4 plan",
    thread: false,
    body: "Hi Sam,\n\nHere is the plan.",
    editable: true,
    ...over,
  };
}

function other(over: Partial<Extract<AskCard, { kind: "other" }>> = {}): AskCard {
  return { kind: "other", state: "wait", summary: "Add the dentist to Tuesday", detail: "Calendar: Tue 10:00", ...over };
}

type Decides = Array<[string, AnswerChoice, string | undefined]>;

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
});

function mount(card: AskCard) {
  const decides: Decides = [];
  let replies = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const draw = (next: AskCard) =>
    act(() =>
      root.render(
        createElement(TexAskCard, {
          rowId: ROW,
          card: next,
          onDecide: (rowId: string, choice: AnswerChoice, body?: string) => {
            decides.push([rowId, choice, body]);
          },
          onReply: () => {
            replies += 1;
          },
        }),
      ),
    );
  draw(card);
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    draw,
    decides,
    replies: () => replies,
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    type: (testId: string, value: string) => {
      const field = find(testId);
      if (field === null) throw new Error(`no field ${testId}`);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  };
}

describe("a waiting email", () => {
  test("shows its fields and its body as an editable field", () => {
    const tab = mount(email());
    expect(tab.text()).toContain("To");
    expect(tab.text()).toContain("sam@example.test");
    expect(tab.text()).toContain("Q4 plan");
    expect(tab.text()).toContain("Waiting for you · nothing sends until you say so");
    const body = tab.find("tex-ask-body-r1") as HTMLTextAreaElement | null;
    expect(body?.tagName).toBe("TEXTAREA");
    expect(body?.value).toBe("Hi Sam,\n\nHere is the plan.");
  });

  test("typing in the body and pressing Send sends the new words", () => {
    const tab = mount(email());
    tab.type("tex-ask-body-r1", "Hi Sam,\n\nChanged the plan.");
    tab.press("tex-ask-send-r1");
    expect(tab.decides).toEqual([[ROW, "send", "Hi Sam,\n\nChanged the plan."]]);
  });

  test("Send without any edit passes no body, so the held text goes as it was", () => {
    const tab = mount(email());
    tab.press("tex-ask-send-r1");
    expect(tab.decides).toEqual([[ROW, "send", undefined]]);
  });

  test("Not now holds it", () => {
    const tab = mount(email());
    tab.press("tex-ask-hold-r1");
    expect(tab.decides).toEqual([[ROW, "hold", undefined]]);
  });

  test("the reply arrow calls onReply", () => {
    const tab = mount(email());
    tab.press("tex-ask-reply-r1");
    expect(tab.replies()).toBe(1);
    expect(tab.decides).toEqual([]);
  });

  test("a reply in the existing thread says so under the buttons", () => {
    const tab = mount(email({ thread: true }));
    expect(tab.text()).toContain("A reply in the existing thread.");
  });

  test("the card holds no 👍 text anywhere", () => {
    const tab = mount(email());
    expect(tab.text()).not.toContain("👍");
  });
});

describe("the other states", () => {
  test("held: the head says Tex kept the draft, and there are no buttons", () => {
    const tab = mount(email({ state: "held" }));
    expect(tab.text()).toContain("Not sent. Tex kept the draft.");
    expect(tab.find("tex-ask-send-r1")).toBeNull();
    expect(tab.find("tex-ask-hold-r1")).toBeNull();
    // A kept draft is read as it is, and sent by replying to it (the mock: only a waiting card's text is editable).
    expect((tab.find("tex-ask-body-r1") as HTMLElement | null)?.tagName).not.toBe("TEXTAREA");
    expect(tab.find("tex-ask-reply-r1")).not.toBeNull();
  });

  test("sent: the head names the sender and the time, and there is no reply arrow", () => {
    const tab = mount(email({ state: "sent", at: AT }));
    expect(tab.find("tex-ask-state-r1")?.textContent).toBe("Sent from me@example.test · 9:05 AM");
    expect(tab.find("tex-ask-reply-r1")).toBeNull();
  });

  test("sending: the buttons are replaced by Sending…", () => {
    const tab = mount(email({ state: "sending" }));
    expect(tab.find("tex-ask-sending-r1")?.textContent).toBe("Sending…");
    expect(tab.find("tex-ask-send-r1")).toBeNull();
    expect(tab.find("tex-ask-hold-r1")).toBeNull();
  });

  test("gone: the head says No longer waiting, with no buttons", () => {
    const tab = mount(email({ state: "gone", editable: false }));
    expect(tab.find("tex-ask-state-r1")?.textContent).toBe("No longer waiting");
    expect(tab.find("tex-ask-send-r1")).toBeNull();
    expect(tab.find("tex-ask-hold-r1")).toBeNull();
  });

  test("a held email is not editable unless the gateway says it is", () => {
    const tab = mount(email({ state: "wait", editable: false }));
    expect((tab.find("tex-ask-body-r1") as HTMLElement | null)?.tagName).not.toBe("TEXTAREA");
  });
});

describe("a call that is not one email", () => {
  test("shows its summary as the title, the detail read-only, and Go ahead", () => {
    const tab = mount(other());
    expect(tab.text()).toContain("Add the dentist to Tuesday");
    expect((tab.find("tex-ask-body-r1") as HTMLElement | null)?.tagName).not.toBe("TEXTAREA");
    expect(tab.find("tex-ask-send-r1")?.textContent).toBe("Go ahead");
    tab.press("tex-ask-send-r1");
    expect(tab.decides).toEqual([[ROW, "send", undefined]]);
  });

  test("a vault key's first use offers no standing yes here: Go ahead answers it once", () => {
    const tab = mount(other({ always: true }));
    expect(tab.find("tex-ask-always-r1")).toBeNull();
  });
});

describe("Tex's lead over a card", () => {
  test("an email ask keeps its first line, as a sentence, and drops the copy and the 👍 line", () => {
    expect(askLead("Here's the email I'd send:\n\nFrom: a@example.test\nTo: b@example.test\n\nHi\n\nGive it a 👍 and I'll send it.")).toBe("Here's the email I'd send.");
  });
  test("a group ask's tagged yes line goes too", () => {
    expect(askLead("Here's the email I'd send from @sam's email:\n\nTo: b@example.test\n\n@sam, give it a 👍 and I'll send it. Only @sam can OK it.")).toBe("Here's the email I'd send from @sam's email.");
  });
  test("a one-paragraph ask keeps its words before the 👍", () => {
    expect(askLead("Before I pay, I need your OK to pay the venue. Give it a 👍 and I'll fill it in.")).toBe("Before I pay, I need your OK to pay the venue.");
  });
  test("words Tex wrote itself stay whole, and nothing left means no bubble", () => {
    expect(askLead("Here's the email. It goes as a reply in your thread.")).toBe("Here's the email. It goes as a reply in your thread.");
    expect(askLead("Give it a 👍 and I'll send it.")).toBe("");
  });
});

describe("the hint under the buttons", () => {
  test("is drawn as small text, not bare words in a box", () => {
    mount(email());
    const hint = Array.from(document.querySelectorAll<HTMLElement>("[dir]")).find((node) => node.textContent === EDIT_HINT);
    expect(hint).toBeDefined();
  });
});

describe("the editable body's height", () => {
  test("follows its words through an invisible copy, and renders and types without a render loop", () => {
    const errors: unknown[] = [];
    const was = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const t = mount(email({ body: "Hi Kameela,\n\nWe'd like to add 2 more guests.\n\nThanks!" }));
      expect(t.find(`tex-ask-body-${ROW}-mirror`)?.textContent).toBe("Hi Kameela,\n\nWe'd like to add 2 more guests.\n\nThanks!\n");
      t.type(`tex-ask-body-${ROW}`, "Hi Kameela,\n\nOne more line.");
      expect(t.find(`tex-ask-body-${ROW}-mirror`)?.textContent).toBe("Hi Kameela,\n\nOne more line.\n");
      expect(errors.filter((e) => String(e).includes("Maximum update depth"))).toEqual([]);
    } finally {
      console.error = was;
    }
  });
});
