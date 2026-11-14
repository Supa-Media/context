import { describe, expect, it } from "vitest";
import {
  decodeChatGuid,
  encodeChatGuid,
  isPhotonChat,
  isPhotonGroup,
  parsePhotonChat,
  ATTACHMENT_FOR_MS,
  photonAttachmentUrl,
  photonChatId,
  photonGroupGuid,
  photonGroupId,
  photonGuidFor,
  verifyPhotonAttachment,
} from "./photon";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const SECRET = "an-agent-worker-secret-long-enough";
const ORIGIN = "https://agent.example";
const GUID = "any;+;ABCDEF0123456789";

/** The gateway's own id patterns, copied from `apps/mcp/src/agent/log.js` (CHAT) and `apps/mcp/src/agent/textsDecide.js` (GROUP_ID). */
const GATEWAY_CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const GATEWAY_GROUP_ID = /^[A-Za-z0-9._:@+=-]{1,256}$/;

describe("Photon chat ids", () => {
  it("names a 1:1 chat by its line and the person, and reads it back", () => {
    expect(photonChatId(LINE, PHONE)).toBe(`photon:${LINE}:${PHONE}`);
    expect(parsePhotonChat(photonChatId(LINE, PHONE))).toEqual({ line: LINE, phone: PHONE });
    expect(isPhotonChat(photonChatId(LINE, PHONE))).toBe(true);
  });

  it("reads no 1:1 id that is malformed, and no group id as a 1:1 one", () => {
    expect(parsePhotonChat(`photon:${LINE}:not-a-phone`)).toBeNull();
    expect(parsePhotonChat(`photon:${LINE}:${PHONE}:extra`)).toBeNull();
    expect(parsePhotonChat(photonGroupId(GUID))).toBeNull();
    expect(isPhotonChat(photonGroupId(GUID))).toBe(false);
  });

  it("encodes a group's Photon guid, and reads it back exactly", () => {
    const id = photonGroupId(GUID);
    expect(id.startsWith("photon-group:")).toBe(true);
    expect(isPhotonGroup(id)).toBe(true);
    expect(photonGroupGuid(id)).toBe(GUID);
    expect(photonGroupGuid("photon-group:")).toBeNull();
    expect(photonGroupGuid("photon-group:not*valid")).toBeNull();
    expect(isPhotonGroup("sendblue:x")).toBe(false);
  });

  it("round-trips any guid through base64url, with only URL-safe characters", () => {
    for (const guid of [GUID, "any;+;a/b+c=d", "any;+;üñí", "x"]) {
      const encoded = encodeChatGuid(guid);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeChatGuid(encoded)).toBe(guid);
    }
    expect(decodeChatGuid("A")).toBeNull(); // length 1 mod 4 is no base64
    expect(decodeChatGuid("")).toBe(null);
  });

  it("gives the Photon guid an outbound send answers in: any;-;<phone> for 1:1, the group's own guid for a group", () => {
    expect(photonGuidFor(photonChatId(LINE, PHONE))).toBe(`any;-;${PHONE}`);
    expect(photonGuidFor(photonGroupId(GUID))).toBe(GUID);
    expect(photonGuidFor("sendblue:whatever")).toBeNull();
  });

  it("keeps every group id inside the gateway's chat and group id patterns, at the longest guid allowed", () => {
    const longest = `any;+;${"A".repeat(72)}`;
    for (const guid of [GUID, longest]) {
      const id = photonGroupId(guid);
      expect(GATEWAY_CHAT.test(id)).toBe(true);
      expect(GATEWAY_GROUP_ID.test(id)).toBe(true);
    }
    expect(photonGroupId(longest).length).toBeLessThanOrEqual(128);
  });
});

describe("attachment addresses", () => {
  it("signs an address under the stored origin, and verifies only that guid", async () => {
    const url = await photonAttachmentUrl(`${ORIGIN}/`, SECRET, "guid-1");
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe("/photon/attachment/guid-1");
    const sig = parsed.searchParams.get("s");
    const e = parsed.searchParams.get("e");
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig, e)).toBe(true);
    expect(await verifyPhotonAttachment(SECRET, "guid-2", sig, e)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", null, e)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", "0".repeat(64), e)).toBe(false);
    expect(await verifyPhotonAttachment("another-secret-long-enough-x", "guid-1", sig, e)).toBe(false);
  });

  it("an address stops opening once it expires, and its expiry cannot be pushed out", async () => {
    const now = Date.UTC(2026, 10, 14);
    const parsed = new URL((await photonAttachmentUrl(ORIGIN, SECRET, "guid-1", now)) as string);
    const sig = parsed.searchParams.get("s");
    const e = parsed.searchParams.get("e") as string;
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig, e, now + ATTACHMENT_FOR_MS - 1000)).toBe(true);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig, e, now + ATTACHMENT_FOR_MS + 1000)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig, String(Number(e) + 86_400), now)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig, null, now)).toBe(false);
  });

  it("gives no address for a plain http origin, a missing origin, a bad origin or a short secret", async () => {
    expect(await photonAttachmentUrl("http://agent.example", SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl("not a url", SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl(undefined, SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl("", SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl(ORIGIN, "short", "g")).toBeNull();
  });
});
