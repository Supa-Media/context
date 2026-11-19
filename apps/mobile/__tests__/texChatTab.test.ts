/**
 * @jest-environment jsdom
 */

/**
 * THE TEX TAB, ON THE GLASS.
 *
 * `appChatGateway.test.ts` proves the wire and `useAppChat` the polling; this
 * mounts the tab with a fake `AppChatView` and proves what a person can see and
 * press: the header and empty line, text rows, pictures and the overlay, an
 * unsent and an edited row, a reply quote, tapbacks, the approval buttons and
 * their pill, the composer's Enter and Shift+Enter, reply, edit and unsend, and
 * the rail's Tex button under the calendar. The data layer is replaced, so
 * nothing here reaches a route or a grant.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// The hook is replaced: the tab is drawn from the view it is given.
jest.mock("../features/tex/chat/useAppChat", () => ({
  useAppChat: () => {
    throw new Error("the Tex tab is drawn from the view it is given, in these tests");
  },
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppChatRow, ChatLine, PendingLine } from "../features/tex/chat/appChatGateway";
import type { AppChatView } from "../features/tex/chat/useAppChat";
import { TEX_EMPTY, TEX_TAB_SUB, TEX_WORKING, TexChatView } from "../features/tex/chat/TexChatTab";
import { AsideStrip } from "../features/console/aside/AsideStrip";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { texChatTarget } from "../features/console/layout/slots";

const AT = Date.UTC(2026, 10, 19, 9, 0);

function row(over: Partial<AppChatRow> & { id: string }): AppChatRow {
  return { who: "tex", text: "", at: AT, kind: "text", ...over };
}

type Calls = unknown[][];

function fakeView(over: Partial<AppChatView> = {}): AppChatView & { calls: Calls } {
  const calls: Calls = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  return {
    available: true,
    phase: "listed",
    lines: [],
    busy: false,
    sending: false,
    error: null,
    answers: {},
    send: record("send") as AppChatView["send"],
    retry: record("retry") as AppChatView["retry"],
    answer: record("answer") as AppChatView["answer"],
    react: record("react") as AppChatView["react"],
    edit: record("edit") as AppChatView["edit"],
    unsend: record("unsend") as AppChatView["unsend"],
    pictureUrl: (id: string) => (id === "pic-loading" ? null : `blob:${id}`),
    ...over,
    calls,
  };
}

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
});

function mount(view: AppChatView & { calls: Calls }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const draw = (next: AppChatView & { calls: Calls }) => act(() => root.render(createElement(TexChatView, { view: next })));
  draw(view);
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    draw,
    calls: view.calls,
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    hover: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      // react-native-web listens for pointerenter where the browser has it, and mouseenter where it does not.
      act(() => {
        node.dispatchEvent(new Event("pointerenter"));
        node.dispatchEvent(new Event("mouseenter"));
      });
    },
    type: (testId: string, text: string) => {
      const field = find(testId);
      if (field === null) throw new Error(`no field ${testId}`);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    key: (testId: string, key: string, shiftKey = false) => {
      const field = find(testId);
      if (field === null) throw new Error(`no field ${testId}`);
      act(() => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keypress", { key, shiftKey, bubbles: true }));
      });
    },
  };
}

describe("the header and the empty chat", () => {
  test("Tex's name and its one line under it", () => {
    const tab = mount(fakeView());
    expect(tab.text()).toContain("Tex");
    expect(tab.text()).toContain(TEX_TAB_SUB);
    expect(TEX_TAB_SUB).toBe("Its own chat. Tex remembers your texts too.");
  });

  test("an empty chat says what to do in the middle of it", () => {
    const tab = mount(fakeView());
    expect(tab.find("tex-empty")?.textContent).toBe(TEX_EMPTY);
  });

  test("a chat that cannot be reached says so instead of inviting a message", () => {
    const tab = mount(fakeView({ available: false }));
    expect(tab.text()).toContain("Tex is not reachable from this console.");
    expect(tab.find("tex-input")?.getAttribute("readonly") ?? tab.find("tex-input")?.getAttribute("disabled")).not.toBeNull();
  });
});

describe("the log", () => {
  test("text rows from both sides, in order", () => {
    const tab = mount(
      fakeView({
        lines: [
          row({ id: "m1", who: "me", text: "Hello Tex" }),
          row({ id: "t1", who: "tex", text: "Hi, what can I do?" }),
        ],
      }),
    );
    expect(tab.find("tex-row-m1")?.textContent).toContain("Hello Tex");
    expect(tab.find("tex-row-t1")?.textContent).toContain("Hi, what can I do?");
    expect(tab.text().indexOf("Hello Tex")).toBeLessThan(tab.text().indexOf("Hi, what can I do?"));
  });

  test("a link is tappable and anything else is words, never HTML", () => {
    const tab = mount(fakeView({ lines: [row({ id: "t1", text: 'see <img src=x onerror=alert(1)> and https://example.com/a.' })] }));
    expect(tab.find("tex-row-t1")?.querySelector("img")).toBeNull();
    expect(tab.find("tex-row-t1")?.textContent).toContain("<img src=x onerror=alert(1)>");
    const links = tab.find("tex-row-t1")?.querySelectorAll('[role="link"]') ?? [];
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toBe("https://example.com/a");
  });

  test("the typing mark shows while Tex is working on it", () => {
    const tab = mount(fakeView({ busy: true }));
    expect(tab.find("tex-typing")).not.toBeNull();
    expect(tab.text()).toContain(TEX_WORKING);
    expect(TEX_WORKING).toBe("Tex is working on it");
  });

  test("a view that is not busy shows no typing mark", () => {
    const tab = mount(fakeView({ busy: false }));
    expect(tab.find("tex-typing")).toBeNull();
  });

  test("the error sentence sits above the box", () => {
    const tab = mount(fakeView({ error: "I could not reach Tex. Try again in a moment." }));
    expect(tab.find("tex-error")?.textContent).toBe("I could not reach Tex. Try again in a moment.");
  });
});

describe("pictures", () => {
  test("a picture shows once its address is known, and a grey box until then", () => {
    const tab = mount(
      fakeView({
        lines: [
          row({ id: "m1", who: "me", text: "", pics: ["pic-ready"] }),
          row({ id: "m2", who: "me", text: "", pics: ["pic-loading"] }),
        ],
      }),
    );
    expect(tab.find("tex-pic-pic-ready")?.tagName).not.toBe("");
    expect(tab.find("tex-pic-pic-loading")?.getAttribute("aria-label")).toBe("Picture loading");
  });

  test("a picture-only row has no text bubble", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "", pics: ["pic-a"] })] }));
    expect(tab.find("tex-row-m1")?.querySelector('[data-testid="tex-pic-pic-a"]')).not.toBeNull();
    // Only its time is under it: no words, so no bubble.
    expect(tab.find("tex-row-m1")?.textContent).toBe(new Date(AT).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  });

  test("a picture opens full size, and Escape or a click closes it", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "", pics: ["pic-a"] })] }));
    tab.press("tex-pic-pic-a");
    expect(tab.find("tex-overlay")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tab.find("tex-overlay")).toBeNull();
    tab.press("tex-pic-pic-a");
    tab.press("tex-overlay");
    expect(tab.find("tex-overlay")).toBeNull();
  });
});

describe("rows the person changed", () => {
  test("an unsent row says so and shows no words", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "", unsent: true })] }));
    expect(tab.find("tex-unsent-m1")?.textContent).toBe("You unsent a message");
    expect(tab.find("tex-row-m1")?.textContent).not.toContain("Edited");
  });

  test("an edited row is marked Edited", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "fixed", edited: true })] }));
    expect(tab.find("tex-edited-m1")?.textContent).toBe("Edited");
  });

  test("a reply shows the words it answers, or a message when they are not known", () => {
    const tab = mount(
      fakeView({
        lines: [
          row({ id: "t1", text: "the first" }),
          row({ id: "m1", who: "me", text: "yes", replyTo: { id: "t1", text: "the first answer" } }),
          row({ id: "m2", who: "me", text: "ok", replyTo: { id: "gone" } }),
        ],
      }),
    );
    expect(tab.find("tex-quote-t1")?.textContent).toBe("the first answer");
    expect(tab.find("tex-quote-gone")?.textContent).toBe("a message");
  });

  test("reactions show as small badges on the bubble", () => {
    const tab = mount(
      fakeView({
        lines: [row({ id: "t1", text: "hi", reactions: [{ who: "me", emoji: "❤️" }, { who: "tex", emoji: "😂" }] })],
      }),
    );
    const badges = tab.find("tex-reactions");
    expect(badges?.textContent).toContain("❤️");
    expect(badges?.textContent).toContain("😂");
  });

  test("a pending line shows as sending, and a failed one can be sent again", () => {
    const pending: PendingLine = { pending: true, localId: "local-1", who: "me", text: "retry me", at: AT, state: "failed" };
    const tab = mount(fakeView({ lines: [pending] as ChatLine[] }));
    expect(tab.text()).toContain("Not sent.");
    tab.press("tex-retry-local-1");
    expect(tab.calls).toEqual([["retry", "local-1"]]);
  });
});

describe("approvals", () => {
  const ask = row({ id: "a1", text: "Send the invoice to Sam?", ask: { id: "ap_1", open: true } });

  test("an open ask has Approve and Decline under its bubble", () => {
    const tab = mount(fakeView({ lines: [ask] }));
    expect(tab.text()).toContain("Approve");
    expect(tab.text()).toContain("Decline");
  });

  test("Approve sends approve and Decline sends deny for that row", () => {
    const tab = mount(fakeView({ lines: [ask] }));
    tab.press("tex-approve-a1");
    tab.press("tex-deny-a1");
    expect(tab.calls).toEqual([
      ["answer", "a1", "approve"],
      ["answer", "a1", "deny"],
    ]);
  });

  test("after an answer the buttons go and a pill says what happened", () => {
    const tab = mount(fakeView({ lines: [ask], answers: { a1: "approve" } }));
    expect(tab.find("tex-approve-a1")).toBeNull();
    expect(tab.find("tex-answer-a1")?.textContent).toBe("Approved");
    tab.draw(fakeView({ lines: [ask], answers: { a1: "deny" } }));
    expect(tab.find("tex-answer-a1")?.textContent).toBe("Declined");
  });

  test("only the open ask has buttons, not an older text", () => {
    const old = row({ id: "a0", text: "An old question", ask: { id: "ap_0", open: false } });
    const tab = mount(fakeView({ lines: [old, ask] }));
    expect(tab.find("tex-approve-a0")).toBeNull();
    expect(tab.find("tex-approve-a1")).not.toBeNull();
  });
});

describe("tapbacks and the row's actions", () => {
  test("hovering a row shows the six tapbacks and Reply, and Edit and Unsend on the person's editable rows", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "mine", editable: true })] }));
    expect(tab.find("tex-bar-m1")).toBeNull();
    tab.hover("tex-row-m1");
    expect(tab.find("tex-bar-m1")).not.toBeNull();
    for (const emoji of ["❤️", "👍", "👎", "😂", "‼️", "❓"]) {
      expect(tab.find(`tex-tapback-m1-${emoji}`)).not.toBeNull();
    }
    expect(tab.find("tex-reply-m1")).not.toBeNull();
    expect(tab.find("tex-edit-m1")).not.toBeNull();
    expect(tab.find("tex-unsend-m1")).not.toBeNull();
  });

  test("Tex's own rows offer no Edit or Unsend", () => {
    const tab = mount(fakeView({ lines: [row({ id: "t1", text: "theirs" })] }));
    tab.hover("tex-row-t1");
    expect(tab.find("tex-reply-t1")).not.toBeNull();
    expect(tab.find("tex-edit-t1")).toBeNull();
    expect(tab.find("tex-unsend-t1")).toBeNull();
  });

  test("a tapback is sent for that row and emoji", () => {
    const tab = mount(fakeView({ lines: [row({ id: "t1", text: "hi" })] }));
    tab.hover("tex-row-t1");
    tab.press("tex-tapback-t1-👍");
    expect(tab.calls).toEqual([["react", "t1", "👍"]]);
  });

  test("Unsend takes the row back", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "oops", editable: true })] }));
    tab.hover("tex-row-m1");
    tab.press("tex-unsend-m1");
    expect(tab.calls).toEqual([["unsend", "m1"]]);
  });

  test("Reply puts a bar above the box, and sending passes replyTo", () => {
    const tab = mount(fakeView({ lines: [row({ id: "t1", text: "What next?" })] }));
    tab.hover("tex-row-t1");
    tab.press("tex-reply-t1");
    expect(tab.find("tex-reply-bar")?.textContent).toContain("Replying to Tex");
    expect(tab.find("tex-reply-bar")?.textContent).toContain("What next?");
    tab.type("tex-input", "Ship it");
    tab.press("tex-send");
    expect(tab.calls).toEqual([["send", "Ship it", { pictures: [], replyTo: "t1" }]]);
    expect(tab.find("tex-reply-bar")).toBeNull();
  });

  test("Reply to yourself says so, and cancelling the bar sends without a reply", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "my own words" })] }));
    tab.hover("tex-row-m1");
    tab.press("tex-reply-m1");
    expect(tab.find("tex-reply-bar")?.textContent).toContain("Replying to yourself");
    tab.press("tex-reply-cancel");
    expect(tab.find("tex-reply-bar")).toBeNull();
  });

  test("Edit puts the words in the box, and Save calls edit for that row", () => {
    const tab = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "helo", editable: true })] }));
    tab.hover("tex-row-m1");
    tab.press("tex-edit-m1");
    expect(tab.find("tex-edit-bar")?.textContent).toContain("Editing message");
    expect((tab.find("tex-input") as HTMLTextAreaElement | null)?.value).toBe("helo");
    tab.type("tex-input", "hello");
    tab.press("tex-send");
    expect(tab.calls).toEqual([["edit", "m1", "hello"]]);
    expect(tab.find("tex-edit-bar")).toBeNull();
  });
});

describe("the box", () => {
  test("Enter sends, and Shift+Enter does not", () => {
    const tab = mount(fakeView());
    tab.type("tex-input", "first");
    tab.key("tex-input", "Enter", true);
    expect(tab.calls).toEqual([]);
    tab.key("tex-input", "Enter", false);
    expect(tab.calls).toEqual([["send", "first", { pictures: [], replyTo: null }]]);
  });

  test("Send does nothing with no words and no pictures", () => {
    const tab = mount(fakeView());
    tab.type("tex-input", "   ");
    tab.press("tex-send");
    expect(tab.calls).toEqual([]);
  });

  test("the placeholder asks in the words the owner chose", () => {
    const tab = mount(fakeView());
    expect(tab.find("tex-input")?.getAttribute("placeholder")).toBe("Ask Tex, or tell it what to do");
  });

  test("the picture button is labelled for a screen reader", () => {
    const tab = mount(fakeView());
    expect(tab.find("tex-picture")?.getAttribute("aria-label")).toBe("Add pictures");
    expect(tab.find("tex-send")?.getAttribute("aria-label")).toBe("Send");
  });
});

describe("the rail and the panel", () => {
  test("the rail shows Tex's button under the calendar, labelled Tex", () => {
    const { container } = { container: document.createElement("div") };
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() =>
      root.render(
        createElement(AsideStrip, {
          tabs: ["meetings", "tex"],
          showing: "meetings",
          recording: false,
          onUnfold: () => {},
        }),
      ),
    );
    const buttons = Array.from(container.querySelectorAll('[data-testid^="aside-strip-"]'))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => !id?.includes("figure"));
    expect(buttons).toEqual(["aside-strip-meetings", "aside-strip-tex"]);
    expect(container.querySelector('[data-testid="aside-strip-tex"]')?.getAttribute("aria-label")).toBe("Tex");
    expect(container.querySelector('[data-testid="aside-strip-tex-figure"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  test("the panel lists Tex after Meetings, and the owner's console passes the chat its workspace", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() =>
      root.render(
        createElement(AsidePanel, {
          started: null,
          onOpenNote: null,
          tex: { workspaceId: "ws_1", endpoint: "https://gateway.example" },
        }),
      ),
    );
    const labels = () => Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    expect(labels()).toEqual(["Meetings", "Tex"]);
    act(() => root.unmount());
    container.remove();
  });

  test("with no Tex chat for this console there is no Tex tab", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => root.render(createElement(AsidePanel, { started: null, onOpenNote: null })));
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    // Meetings alone draws no tab strip (2026-11-19), so there is no tab at all.
    expect(labels).toEqual([]);
    expect(container.querySelector('[data-testid="aside-meetings"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});

describe("the Tex tab in every workspace (Dev2, 2026-11-19)", () => {
  const contexts = [
    { id: "ws_shared", kind: "shared", role: "owner" },
    { id: "ws_mine", kind: "personal", role: "owner" },
  ] as never;

  test("a shared workspace open still gets the person's own chat, on their personal workspace", () => {
    expect(texChatTarget({ demo: false, contexts, endpoint: "https://gateway.example" })).toEqual({
      workspaceId: "ws_mine",
      endpoint: "https://gateway.example",
    });
  });

  test("no chat on the demo, or for someone with no personal workspace of their own", () => {
    expect(texChatTarget({ demo: true, contexts, endpoint: "https://gateway.example" })).toBeNull();
    const notMine = [{ id: "ws_x", kind: "personal", role: "member" }] as never;
    expect(texChatTarget({ demo: false, contexts: notMine, endpoint: "https://gateway.example" })).toBeNull();
  });
});
