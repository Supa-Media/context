/**
 * @jest-environment jsdom
 */

/**
 * A BOT'S WEBHOOK IS TYPED ONCE, SEALED, AND NEVER SHOWN AGAIN.
 *
 * The owner, 2026-11-25, chose to keep a bot's webhook like an app connection:
 * sealed on the account server. The panel sends the address, an optional
 * header and a signing key it made, shows that key once to copy into the bot,
 * and afterwards shows only the host, the header's last four characters, who
 * set it and how the last call went.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BotHookView, lastCallLine, type HookRow } from "../features/console/files/folderPage/areas/PanelBotHook";
import { one, all, press, type } from "./projectPage/fixtures";

const unmounts: Array<() => void> = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
});

async function show(props: Parameters<typeof BotHookView>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(createElement(BotHookView, props)));
}

const ROW: HookRow = { bot: "finance", host: "bot.example.com", headerEnds: "1234", setByName: "seyi", lastCallAt: 1, lastCallOk: true, lastCallStatus: 200, canReplace: true };

describe("a bot's webhook in the area panel", () => {
  test("saving sends the address, header and a fresh signing key, then shows the key once", async () => {
    const save = jest.fn(async (_address: string, _header: string, _key: string) => {});
    await show({ bot: "Finance", row: null, canEdit: true, save, test: async () => ({ ok: true, status: 200 }) });
    await type(one("area-panel-hook-address"), "https://bot.example.com/context");
    await type(one("area-panel-hook-header"), "Authorization: Bearer abc");
    await press(one("area-panel-hook-save"));
    expect(save).toHaveBeenCalledTimes(1);
    const [address, header, key] = save.mock.calls[0]!;
    expect(address).toBe("https://bot.example.com/context");
    expect(header).toBe("Authorization: Bearer abc");
    expect(key).toMatch(/^ctxbot_[0-9a-f]{64}$/);
    expect(one("area-panel-hook-key").textContent).toContain(key);
    // The typed address is cleared from the screen once it is sealed.
    expect((one("area-panel-hook-address") as HTMLInputElement).value).toBe("");
  });

  test("once saved it shows the host and the header's end, never the address, and sends a test", async () => {
    const test_ = jest.fn(async () => ({ ok: false, status: 503 }));
    await show({ bot: "Finance", row: ROW, canEdit: true, save: async () => {}, test: test_ });
    expect(one("area-panel-hook-saved").textContent).toBe("Webhook bot.example.com · header ends 1234 · set by @seyi");
    expect(all("area-panel-hook-address")).toHaveLength(0);
    await press(one("area-panel-hook-test"));
    expect(test_).toHaveBeenCalled();
    expect(one("area-panel-hook-last").textContent).toBe("Finance answered 503.");
  });

  test("someone who did not set it cannot replace it, and a reader sees no buttons", async () => {
    await show({ bot: "Finance", row: { ...ROW, canReplace: false }, canEdit: true, save: async () => {}, test: async () => ({ ok: true, status: 200 }) });
    expect(all("area-panel-hook-replace")).toHaveLength(0);
    unmounts.pop()!();
    await show({ bot: "Finance", row: ROW, canEdit: false, save: async () => {}, test: async () => ({ ok: true, status: 200 }) });
    expect(all("area-panel-hook-test")).toHaveLength(0);
  });

  test("the last call in a few words", () => {
    expect(lastCallLine({ ...ROW, lastCallAt: null })).toBe("Not called yet.");
    expect(lastCallLine(ROW)).toBe("Last call answered (200).");
    expect(lastCallLine({ ...ROW, lastCallOk: false, lastCallStatus: 0 })).toBe("Last call didn't reach it.");
  });
});
