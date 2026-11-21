/**
 * THE TEX CHAT STARTS FROM WHAT IT LAST SHOWED (Dev2, 2026-11-21 roast: the
 * panel "takes a while to load"). A chat drawn again in the same scope starts
 * from its last rows instead of an empty log; another scope starts empty; a
 * text still sending is not carried over.
 *
 * Sabotage (run once, then restored): `startingState` returning `EMPTY` fails
 * the first test.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EMPTY, forgetRememberedChats, rememberLines, startingState } from "../features/tex/chat/appChatView";
import type { ChatLine } from "../features/tex/chat/appChatGateway";

afterEach(() => forgetRememberedChats());

const SENT = { id: "r1", who: "tex", text: "hi", at: 1, kind: "text" } as ChatLine;
const SENDING = { localId: "l1", who: "me", text: "draft", at: 2, pending: true } as unknown as ChatLine;

describe("a chat drawn again", () => {
  test("starts listed, from the rows it last showed in that scope", () => {
    rememberLines("ws1\nroute", [SENT]);
    expect(startingState("ws1\nroute")).toMatchObject({ phase: "listed", lines: [SENT] });
  });

  test("another workspace starts empty", () => {
    rememberLines("ws1\nroute", [SENT]);
    expect(startingState("ws2\nroute")).toBe(EMPTY);
  });

  test("a text still sending is not carried over", () => {
    rememberLines("ws1\nroute", [SENT, SENDING]);
    expect(startingState("ws1\nroute").lines).toEqual([SENT]);
  });
});
