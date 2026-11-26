import { describe, expect, it } from "vitest";
import { sha256Hex } from "./groupChat";
import { MemoryStorage } from "./memoryStorage.testing";
import { LOOK_AGAIN_MS, keepSticker, stickerId, stickersAsk } from "./stickers";
import { lookAtStickers, OFF_FOR_MS } from "./stickerLook";
import { photonAttachmentUrl } from "./photon";

const NOW = 1_800_000_000_000;
const PLACE = { line: "+15555550199", groupId: "photon-group:abc" };
const SECRET = "test-only-secret-that-is-long-enough-0123456789";
// A tiny PNG's first bytes, as the picture fetched off the line: sniffed as image/png, read as it is.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

function world(answer: (body: Record<string, unknown>) => unknown, status = 200) {
  const asked: Record<string, unknown>[] = [];
  const fetched: string[] = [];
  const deps = {
    texts: {
      fetch: async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://gateway/texts/sticker-look");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        asked.push(body);
        return Response.json(answer(body), { status });
      },
    },
    fetch: async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(PNG, { status: 200 });
    },
    pictureUrl: (guid: string) => photonAttachmentUrl("https://agent.example", SECRET, guid, NOW),
    now: () => NOW,
  };
  return { asked, fetched, deps };
}

async function kept(...guids: string[]) {
  const storage = new MemoryStorage();
  for (const [i, guid] of guids.entries()) await keepSticker(storage, { how: "Reacted", words: "nice", emoji: "with a sticker", sticker: guid }, NOW - 1_000 + i);
  return storage;
}

describe("a kept sticker is looked at once, and Decide reads its words", () => {
  it("asks the gateway with the sticker's picture and the chat's ledger key, and keeps the words beside it", async () => {
    const storage = await kept("at_0_PARTY-CAT");
    const { asked, fetched, deps } = world(() => ({ when: ["looked"], words: "cat throwing confetti; fits celebrating good news" }));
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("looked");
    expect(fetched[0]).toMatch(/^https:\/\/agent\.example\/photon\/attachment\/at_0_PARTY-CAT\?e=\d+&s=/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ chat: await sha256Hex(`${PLACE.line}:${PLACE.groupId}`), sticker: stickerId("at_0_PARTY-CAT"), mediaType: "image/png" });
    expect(typeof asked[0]!.data).toBe("string");
    expect(await stickersAsk(storage)).toEqual({ stickers: [stickerId("at_0_PARTY-CAT")], stickerWords: { [stickerId("at_0_PARTY-CAT")]: "cat throwing confetti; fits celebrating good news" } });
    // Looked at once: the next message asks nothing.
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("none");
    expect(asked).toHaveLength(1);
  });

  it("the node off: nothing is kept, and no picture is fetched again for a while", async () => {
    const storage = await kept("at_0_PARTY-CAT");
    const { asked, fetched, deps } = world(() => ({ when: ["skip"], why: "off" }));
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("off");
    expect(await stickersAsk(storage)).toEqual({ stickers: [stickerId("at_0_PARTY-CAT")] });
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("none");
    expect(fetched).toHaveLength(1);
    // Once wired, the sticker is looked at with no wait of its own: "off" never counted as a try.
    const later = { ...deps, now: () => NOW + OFF_FOR_MS };
    expect(await lookAtStickers(storage, PLACE, later)).toBe("off");
    expect(asked).toHaveLength(2);
  });

  it("a look that gave no words is tried again only after LOOK_AGAIN_MS", async () => {
    const storage = await kept("at_0_SIDE-EYE");
    const { asked, deps } = world(() => ({ when: ["skip"], why: "no meaning given" }));
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("looked");
    expect(await lookAtStickers(storage, PLACE, { ...deps, now: () => NOW + LOOK_AGAIN_MS - 1 })).toBe("none");
    expect(await lookAtStickers(storage, PLACE, { ...deps, now: () => NOW + LOOK_AGAIN_MS })).toBe("looked");
    expect(asked).toHaveLength(2);
  });

  it("a look the gateway's own step failed is no try: the next message asks again", async () => {
    // Battle of the Bots, 2026-11-25: every look threw in the gateway before a model saw the picture, and each sticker
    // then waited LOOK_AGAIN_MS, so the fixed look could not run until hours after the fix went live.
    const storage = await kept("at_0_ROBOT");
    let broken = true;
    const { asked, deps } = world(() => (broken ? { when: ["skip"], why: "failed" } : { when: ["looked"], words: "robot waving; fits a friendly hello" }));
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("failed");
    broken = false;
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("looked");
    expect(asked).toHaveLength(2);
    expect((await stickersAsk(storage)).stickerWords).toEqual({ [stickerId("at_0_ROBOT")]: "robot waving; fits a friendly hello" });
  });

  it("every sticker a chat drops at once gets its words on the next message, newest first", async () => {
    const guids = Array.from({ length: 15 }, (_, i) => `g${i + 1}`);
    const storage = await kept(...guids);
    const { asked, deps } = world((body) => ({ when: ["looked"], words: `words for ${String(body.sticker)}` }));
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("looked");
    // Asked five at a time, the newest five first; within a batch the answers come back in any order.
    const ids = asked.map((body) => String(body.sticker));
    expect([...ids].sort()).toEqual(guids.map(stickerId).sort());
    expect(ids.slice(0, 5).sort()).toEqual(guids.slice(-5).map(stickerId).sort());
    const ask = await stickersAsk(storage);
    expect(Object.keys(ask.stickerWords ?? {})).toHaveLength(15);
    expect(await lookAtStickers(storage, PLACE, deps)).toBe("none");
  });

  it("newest first, and a sticker used again keeps its words", async () => {
    const storage = await kept("g1", "g2", "g3", "g4");
    const { asked, deps } = world((body) => ({ when: ["looked"], words: `words for ${String(body.sticker)}` }));
    await lookAtStickers(storage, PLACE, deps);
    expect(asked.map((body) => String(body.sticker)).sort()).toEqual(["g4", "g3", "g2", "g1"].map(stickerId).sort());
    await keepSticker(storage, { how: "Reacted", words: "nice", emoji: "with a sticker", sticker: "g4" }, NOW + 5);
    expect((await stickersAsk(storage)).stickerWords?.[stickerId("g4")]).toBe(`words for ${stickerId("g4")}`);
  });

  it("no gateway binding, or no address for the picture (an older Worker): nothing is asked and nothing breaks", async () => {
    const storage = await kept("at_0_PARTY-CAT");
    const { asked, deps } = world(() => ({ when: ["looked"], words: "x; fits y" }));
    expect(await lookAtStickers(storage, PLACE, { ...deps, texts: undefined })).toBe("no_gateway");
    expect(await lookAtStickers(storage, PLACE, { ...deps, pictureUrl: async () => null })).toBe("failed");
    expect(await lookAtStickers(storage, PLACE, { ...deps, pictureUrl: async () => { throw new Error("no such method"); } })).toBe("failed");
    expect(asked).toHaveLength(0);
  });
});
