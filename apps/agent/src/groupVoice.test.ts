/**
 * A group's voice message is heard before the chat decides whether it is for Tex (`groupVoice.ts`, 2026-11-05 bug
 * hunt: "Tex, find us a dinner spot" said aloud was ignored, typed it was answered).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `acceptGroup` without the `heard` check → "a voice message that says Tex's name is queued for Tex".
 *  2. `onlyVoice` true for a message with words → "a message with words is never sent to be heard".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptGroup } from "./groupInbox";
import { HEAR_URL, heardInGroup, onlyVoice } from "./groupVoice";
import { MemoryStorage } from "./memoryStorage.testing";
import type { GroupMessage } from "./sendblueGroups";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const VOICE = { url: "https://cdn.sendblue.example/files/Audio%20Message.caf", mimeType: "", filename: "Audio Message.caf", size: null };
const PICTURE = { url: "https://cdn.sendblue.example/files/IMG_0001.png", mimeType: "", filename: "IMG_0001.png", size: null };
// A CAF file's first bytes ("caff"): enough for the download to read as audio.
const CAF = new Uint8Array([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 1, 2, 3, 4]);

const message = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  kind: "group-message",
  eventId: `sendblue:${extra.messageId ?? "x"}`,
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants: [ADA, BO, LINE],
  messageId: extra.messageId ?? "x",
  text,
  ...extra,
});

function world(said: string | null, { status = 200, slow = false }: { status?: number; slow?: boolean } = {}) {
  const heard: Record<string, unknown>[] = [];
  const downloads: string[] = [];
  const fetch = (async (url: string) => {
    downloads.push(url);
    return new Response(CAF, { status: 200 });
  }) as unknown as Fetch;
  const gateway = {
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe(HEAR_URL);
      heard.push(JSON.parse(String(init?.body)));
      if (slow) await new Promise(() => {});
      return Response.json({ text: said }, { status });
    },
  };
  return { fetch, gateway, heard, downloads, log: () => {} };
}

describe("a group's voice message", () => {
  it("is heard, and gated on what it says", async () => {
    const w = world("Hey Tex, find us a dinner spot for Friday.");
    const voice = await heardInGroup(message("", { attachments: [VOICE] }), w);
    expect(voice.heard).toBe("Hey Tex, find us a dinner spot for Friday.");
    expect(w.heard[0]).toMatchObject({ mimeType: "audio/x-caf", audioBase64: expect.any(String), caller: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // The chat's hash, never a number.
    expect(JSON.stringify(w.heard[0])).not.toContain(ADA.slice(1));
  });

  it("a voice message that says Tex's name is queued for Tex, as the same words typed are", async () => {
    const storage = new MemoryStorage();
    expect(await acceptGroup(storage, message("Tex, find us a dinner spot for Friday", { messageId: "t1" }), 0)).toBe("queued");
    const said = await heardInGroup(message("", { messageId: "v1", attachments: [VOICE] }), world("Okay so Tex, can you find us a dinner spot for Friday?"));
    expect(await acceptGroup(new MemoryStorage(), said, 1)).toBe("queued");
    // Without its words, as before: never for Tex.
    expect(await acceptGroup(new MemoryStorage(), message("", { messageId: "v2", attachments: [VOICE] }), 1)).not.toBe("queued");
  });

  it("a voice message about something else is not for Tex", async () => {
    const said = await heardInGroup(message("", { messageId: "v3", attachments: [VOICE] }), world("running ten minutes late, save me a seat"));
    expect(await acceptGroup(new MemoryStorage(), said, 1)).not.toBe("queued");
  });

  it("a message with words, a picture, an SMS or a reaction is never sent to be heard", async () => {
    expect(onlyVoice(message("Tex look", { attachments: [VOICE] }))).toBe(false);
    expect(onlyVoice(message("", { attachments: [PICTURE] }))).toBe(false);
    expect(onlyVoice(message("", { attachments: [VOICE], sms: true }))).toBe(false);
    expect(onlyVoice(message("", { attachments: [VOICE, VOICE] }))).toBe(false);
    expect(onlyVoice(message("", { attachments: [VOICE] }))).toBe(true);
    const w = world("Tex, hi");
    await heardInGroup(message("", { attachments: [PICTURE] }), w);
    expect(w.downloads).toEqual([]);
    expect(w.heard).toEqual([]);
  });

  it("nothing heard, a failure, or no binding leaves the message as it came", async () => {
    const voice = message("", { attachments: [VOICE] });
    expect((await heardInGroup(voice, world(null))).heard).toBeUndefined();
    expect((await heardInGroup(voice, world("Tex, hi", { status: 500 }))).heard).toBeUndefined();
    const { gateway: _g, ...unbound } = world("Tex, hi");
    expect(await heardInGroup(voice, unbound)).toBe(voice);
  });
});
