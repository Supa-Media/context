import { describe, expect, it } from "vitest";
import { noteSendStatus, PHOTON_MATCH_WAIT_MS, type SendStatus } from "./sendblueStatus";
import { noteHandle } from "./replyQuote";
import { sendReportOf } from "./providerTiming";
import { MemoryStorage } from "./memoryStorage.testing";
import { noteLinkBubble } from "./photonLinkBubbles";
import { photonSendStatusOf } from "./photonSendStatus";

const NOW = Date.UTC(2026, 10, 17, 3);
const status = (name: "photon" | "sendblue"): SendStatus => ({
  handle: "guid-1",
  status: "SENT",
  downgraded: false,
  object: { kind: "person", phone: "+15550000002" },
  chat: "photon:+15550000001:+15550000002",
  report: sendReportOf(name, "guid-1", "sent", { providerAt: new Date(NOW).toISOString() }),
});

describe("a Photon send report finds its send when Apple's echo beats the send's answer", () => {
  it("waits for the handle the send notes a moment later, and logs against that send", async () => {
    const storage = new MemoryStorage();
    let waits = 0;
    // The send's own write lands during the second wait, as it does when the echo arrives first.
    const wait = async () => {
      waits += 1;
      if (waits === 2) await noteHandle(storage as never, "guid-1", "ev-1");
    };
    expect(await noteSendStatus(storage as never, status("photon"), NOW, undefined, wait)).toBe("logged");
    expect(waits).toBe(2);
  });

  it("gives up after the wait when no send names the handle, and Sendblue's callbacks never wait", async () => {
    const storage = new MemoryStorage();
    let waited = 0;
    const wait = async (ms: number) => void (waited += ms);
    expect(await noteSendStatus(storage as never, status("photon"), NOW, undefined, wait)).toBe("unmatched");
    expect(waited).toBe(PHOTON_MATCH_WAIT_MS);
    waited = 0;
    expect(await noteSendStatus(storage as never, status("sendblue"), NOW, undefined, wait)).toBe("unmatched");
    expect(waited).toBe(0);
  });
});

describe("a Photon link bubble's reports are its words' send", () => {
  it("logs the link bubble's echo against the words' send, waiting for the bubble to be noted", async () => {
    const storage = new MemoryStorage();
    await noteHandle(storage as never, "words-1", "ev-words");
    let waits = 0;
    const wait = async () => {
      waits += 1;
      if (waits === 1) noteLinkBubble("link-1", "words-1");
    };
    const echo = { ...status("photon"), handle: "link-1", report: sendReportOf("photon", "link-1", "sent") };
    expect(await noteSendStatus(storage as never, echo, NOW, undefined, wait)).toBe("logged");
  });

  it("a link bubble that failed marks nothing and resends nothing: the words went", async () => {
    const storage = new MemoryStorage();
    await noteHandle(storage as never, "words-2", "ev-words-2");
    noteLinkBubble("link-2", "words-2");
    let resent = 0;
    const failed = { ...status("photon"), handle: "link-2", status: "FAILED", report: sendReportOf("photon", "link-2", "failed") };
    expect(await noteSendStatus(storage as never, failed, NOW, async () => (resent++, "x"), async () => {})).toBe("logged");
    expect(resent).toBe(0);
    expect(await storage.get("sbfailed")).toBeUndefined();
  });
});

describe("the bridge's delivery check, as a send status", () => {
  const LINE = "+15550000001";
  const body = (state: string, extra: Record<string, unknown> = {}) => ({
    seq: null, eventId: `photon:message.status:g:${state}`, type: "message.status", line: LINE,
    chat: { guid: "any;-;+15550000002", kind: "dm" }, fromMe: true, at: new Date(NOW).toISOString(),
    status: { targetGuid: "g", state, ...extra },
  });

  it("a failed send is FAILED with Apple's code, so the send step marks it and a threaded text goes again plain", () => {
    expect(photonSendStatusOf(body("failed", { code: 22 }))).toMatchObject({ handle: "g", status: "FAILED", object: { kind: "person", phone: "+15550000002" }, report: { status: "failed", error: { code: "22" } } });
  });

  it("a send not delivered yet is shown on the send step and never marked as failed", async () => {
    const parsed = photonSendStatusOf(body("undelivered"));
    expect(parsed).toMatchObject({ status: "UNDELIVERED", report: { status: "other", error: { code: "not_delivered" } } });
    const storage = new MemoryStorage();
    await noteHandle(storage as never, "g", "ev-g");
    expect(await noteSendStatus(storage as never, parsed as SendStatus, NOW, undefined, async () => {})).toBe("logged");
  });

  it("a status of any other state is no send status", () => {
    expect(photonSendStatusOf(body("lost"))).toBeNull();
  });
});

describe("a failed Photon send that was not threaded is marked as never went", () => {
  it("marks the send's event once", async () => {
    const storage = new MemoryStorage();
    await noteHandle(storage as never, "g2", "ev-g2");
    const failed = { ...status("photon"), handle: "g2", status: "FAILED", report: sendReportOf("photon", "g2", "failed") };
    expect(await noteSendStatus(storage as never, failed, NOW, undefined, async () => {})).toBe("marked");
    expect(await noteSendStatus(storage as never, failed, NOW, undefined, async () => {})).toBe("logged");
  });
});
