import { describe, expect, test } from "@jest/globals";
import { APP_CHAT, isOneToOne, ledgerChatOf, onlyOfChat, withAppChat } from "@context/lab/app/engine/appChat";
import type { LedgerEntry } from "@context/lab/app/fromApp/texPageTypes";

describe("the app chat in the Lab's You", () => {
  test("is listed right after the 1:1, and only when there is one", () => {
    expect(withAppChat([{ key: "me", name: "Just you and Tex" }, { key: "g1", name: "Band" }]).map((c) => c.key)).toEqual(["me", APP_CHAT, "g1"]);
    expect(withAppChat([{ key: "g1", name: "Band" }]).map((c) => c.key)).toEqual(["g1"]);
  });

  test("reads the 1:1's history and keeps only the app's texts", () => {
    expect(ledgerChatOf(APP_CHAT)).toBe("me");
    expect(ledgerChatOf("g1")).toBe("g1");
    expect(isOneToOne(APP_CHAT)).toBe(true);
    expect(isOneToOne("g1")).toBe(false);
    const entries = [
      { id: "1", kind: "text", via: "app" },
      { id: "2", kind: "text" },
      { id: "3", kind: "reply" },
    ] as unknown as LedgerEntry[];
    expect(onlyOfChat(APP_CHAT, entries).map((e) => e.id)).toEqual(["1", "3"]);
    expect(onlyOfChat("me", entries)).toHaveLength(3);
  });
});
