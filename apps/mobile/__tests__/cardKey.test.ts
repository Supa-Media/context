import { describe, expect, test } from "@jest/globals";
import { cardKeyGroup, cardKeyIsFor, cardKeyRecord, newDeviceId } from "../features/cards/cardKey";

const MINTED = { clientId: "context_cards", accessToken: "cat_x", refreshToken: "crt_y", expiresAt: 1_000 };

describe("the card key the app leaves for the Messages extension", () => {
  test("is the shape CardGrant.swift decodes, with the gateway's own token endpoint", () => {
    const record = JSON.parse(cardKeyRecord(MINTED, "https://mcp.example.org/mcp", "ws1")!);
    expect(record).toEqual({
      api: "https://mcp.example.org",
      token: "https://mcp.example.org/oauth/token",
      clientId: "context_cards",
      accessToken: "cat_x",
      expiresAt: 1_000,
      refreshToken: "crt_y",
      workspaceId: "ws1",
    });
  });

  test("is never written for a gateway that is not https", () => {
    expect(cardKeyRecord(MINTED, "http://mcp.example.org/mcp", "ws1")).toBeNull();
    expect(cardKeyRecord(MINTED, "not a url", "ws1")).toBeNull();
  });

  test("another account's key on the same phone is not this one's", () => {
    const record = cardKeyRecord(MINTED, "https://mcp.example.org/mcp", "ws1");
    expect(cardKeyIsFor(record, "ws1")).toBe(true);
    expect(cardKeyIsFor(record, "ws2")).toBe(false);
    expect(cardKeyIsFor("{broken", "ws1")).toBe(false);
    expect(cardKeyIsFor(null, "ws1")).toBe(false);
  });

  test("lives in the app's own group, and each phone has an id the mint accepts", () => {
    expect(cardKeyGroup("lc.context.mobile")).toBe("group.lc.context.mobile");
    expect(cardKeyGroup(null)).toBeNull();
    expect(newDeviceId(() => "0b6c1c0e-1111-4222-8333-944445555666")).toBe("0b6c1c0e-1111-4222-8333-944445555666");
    expect(newDeviceId(() => "")).toMatch(/^[a-zA-Z0-9-]{8,64}$/);
  });
});
