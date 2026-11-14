import { describe, expect, it } from "vitest";
import {
  isPhotonChat,
  isPhotonGroup,
  parsePhotonChat,
  photonAttachmentUrl,
  photonBridgeToken,
  photonChatId,
  photonGroupGuid,
  photonGroupId,
  photonGuidFor,
  PHOTON_BRIDGE_HEADER,
  verifyPhotonAttachment,
  verifyPhotonBridge,
} from "./photon";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const SECRET = "an-agent-worker-secret-long-enough";

describe("Photon chat ids", () => {
  it("names a 1:1 chat by its line and the person, and reads it back", () => {
    expect(photonChatId(LINE, PHONE)).toBe(`photon:${LINE}:${PHONE}`);
    expect(parsePhotonChat(photonChatId(LINE, PHONE))).toEqual({ line: LINE, phone: PHONE });
    expect(isPhotonChat(photonChatId(LINE, PHONE))).toBe(true);
  });

  it("reads no 1:1 id that is malformed, and no group id as a 1:1 one", () => {
    expect(parsePhotonChat(`photon:${LINE}:not-a-phone`)).toBeNull();
    expect(parsePhotonChat(`photon:${LINE}:${PHONE}:extra`)).toBeNull();
    expect(parsePhotonChat(photonGroupId("any;+;ABC123"))).toBeNull();
    expect(isPhotonChat(photonGroupId("any;+;ABC123"))).toBe(false);
  });

  it("names a group by its Photon chat guid, and never reads a Sendblue or Whapi id as one", () => {
    const id = photonGroupId("any;+;ABC123");
    expect(id).toBe("photon-group:any;+;ABC123");
    expect(isPhotonGroup(id)).toBe(true);
    expect(photonGroupGuid(id)).toBe("any;+;ABC123");
    expect(photonGroupGuid("photon-group:")).toBeNull();
    expect(isPhotonGroup("sendblue:x")).toBe(false);
  });

  it("gives the Photon guid an outbound send answers in: any;-;<phone> for 1:1, the stored guid for a group", () => {
    expect(photonGuidFor(photonChatId(LINE, PHONE))).toBe(`any;-;${PHONE}`);
    expect(photonGuidFor(photonGroupId("any;+;ABC123"))).toBe("any;+;ABC123");
    expect(photonGuidFor("sendblue:whatever")).toBeNull();
  });
});

describe("the bridge's proof", () => {
  it("derives one token from the agent secret, under its own label", async () => {
    const token = await photonBridgeToken(SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await photonBridgeToken(SECRET)).toBe(token);
    expect(await photonBridgeToken(`${SECRET}-other`)).not.toBe(token);
    expect(await photonBridgeToken("short")).toBeNull();
  });

  it("accepts the token in the header, and refuses a missing, guessed or wrong one", async () => {
    const token = (await photonBridgeToken(SECRET)) as string;
    expect(await verifyPhotonBridge(SECRET, new Headers({ [PHOTON_BRIDGE_HEADER]: token }))).toBe(true);
    expect(await verifyPhotonBridge(SECRET, new Headers({ [PHOTON_BRIDGE_HEADER]: " " + token + " " }))).toBe(true);
    expect(await verifyPhotonBridge(SECRET, new Headers())).toBe(false);
    expect(await verifyPhotonBridge(SECRET, new Headers({ [PHOTON_BRIDGE_HEADER]: "1" }))).toBe(false);
    expect(await verifyPhotonBridge(SECRET, new Headers({ [PHOTON_BRIDGE_HEADER]: "0".repeat(64) }))).toBe(false);
    expect(await verifyPhotonBridge("short", new Headers({ [PHOTON_BRIDGE_HEADER]: token }))).toBe(false);
    expect(await verifyPhotonBridge(undefined, new Headers({ [PHOTON_BRIDGE_HEADER]: token }))).toBe(false);
  });
});

describe("attachment addresses", () => {
  it("signs an address under this Worker's https origin, and verifies only that guid", async () => {
    const url = await photonAttachmentUrl("https://agent.example/", SECRET, "guid-1");
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe("https://agent.example");
    expect(parsed.pathname).toBe("/photon/attachment/guid-1");
    const sig = parsed.searchParams.get("s");
    expect(await verifyPhotonAttachment(SECRET, "guid-1", sig)).toBe(true);
    expect(await verifyPhotonAttachment(SECRET, "guid-2", sig)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", null)).toBe(false);
    expect(await verifyPhotonAttachment(SECRET, "guid-1", "0".repeat(64))).toBe(false);
  });

  it("gives no address for a plain http origin, a short secret or no origin", async () => {
    expect(await photonAttachmentUrl("http://agent.example", SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl("not a url", SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl(undefined, SECRET, "g")).toBeNull();
    expect(await photonAttachmentUrl("https://agent.example", "short", "g")).toBeNull();
  });
});
