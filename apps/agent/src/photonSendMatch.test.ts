import { describe, expect, it } from "vitest";
import { noteSendStatus, PHOTON_MATCH_WAIT_MS, type SendStatus } from "./sendblueStatus";
import { noteHandle } from "./replyQuote";
import { sendReportOf } from "./providerTiming";
import { MemoryStorage } from "./memoryStorage.testing";

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
