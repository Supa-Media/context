import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { checkGmail, GMAIL_COPY, GMAIL_FIRST_MS, GMAIL_KEY, watchForGmail } from "./gmailWatch";
import { drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { tellTexOne } from "./didOne";

/**
 * WHAT CODE DID FOR A PERSON'S OWN CHAT, TEX SAYS IN ITS OWN WORDS (Dev2, 2026-11-25, a hard rule;
 * docs/decisions/texting-assistant/no-scripted-wording.md). Their Gmail connecting is first: the chat queues a turn of
 * its own, `event: "did"`, with the facts, and the Worker writes no line. When that turn can't run (no model, the
 * daily limit, the gateway down on every try) the old line goes once, never silence, and never twice.
 *
 * Sabotage record (temporary edits, reverted): `gmailWatch.ts` sending the old line whatever `tellTexOne` did fails 3;
 * `reply.ts` returning [] for a `did` turn that could not run fails 2.
 */

const PHONE = "+15555550100";
const GMAIL = "ada.lovelace@gmail.com";

type Asked = { question: string; event?: string; did?: unknown };

function deps(opts: { now: () => number; asked: Asked[]; sent: string[]; agent: () => Response }): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read") || path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent-texts/gmail") return Response.json({ status: "connected", address: GMAIL, main: true });
    if (path === "/agent") {
      opts.asked.push({ question: body.question, ...(body.event ? { event: body.event } : {}), ...(body.did ? { did: body.did } : {}) });
      return opts.agent();
    }
    if (path.endsWith("/messages")) {
      opts.sent.push(body.message.parts[0].value);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: opts.now };
}

async function connected(agent: () => Response) {
  const storage = new MemoryStorage();
  let now = 1_000;
  const asked: Asked[] = [];
  const sent: string[] = [];
  const d = deps({ now: () => now, asked, sent, agent });
  await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, now);
  now += GMAIL_FIRST_MS;
  await checkGmail(storage, d);
  return { storage, d, asked, sent, tick: (ms: number) => void (now += ms) };
}

describe("what code did for a person's own chat (node did)", () => {
  it("their Gmail connecting queues a turn with the facts, and Tex's own words go, never the old line", async () => {
    const { storage, d, asked, sent } = await connected(() => Response.json({ answer: "You're in, I can read your Gmail now." }));
    expect(sent).toEqual([]);
    expect(await storage.get(GMAIL_KEY)).toBeUndefined();
    await drain(storage, d);
    expect(asked).toEqual([{ question: "", event: "did", did: { action: "gmail", status: "connected", address: GMAIL, main: true } }]);
    expect(sent).toEqual(["You're in, I can read your Gmail now."]);
  });

  it("with no model to write it, the old line goes once, never silence", async () => {
    const { storage, d, sent } = await connected(() => Response.json({ error: "no model" }, { status: 409 }));
    for (let tries = 0; tries < 4; tries++) await drain(storage, d);
    expect(sent).toEqual([GMAIL_COPY.main(GMAIL)]);
  });

  it("with the gateway down on every try, the old line goes once", async () => {
    const { storage, d, sent, tick } = await connected(() => new Response("down", { status: 503 }));
    for (let tries = 0; tries < 8; tries++) {
      await drain(storage, d);
      tick(120_000);
    }
    expect(sent).toEqual([GMAIL_COPY.main(GMAIL)]);
  });

  it("is queued once per key, and facts it can't read queue nothing", async () => {
    const storage = new MemoryStorage();
    const chat = { chatId: "chat_1", phone: PHONE };
    expect(await tellTexOne(storage, chat, { action: "gmail", status: "connected" }, "k1", "old", { now: 1 })).toBe("queued");
    expect(await tellTexOne(storage, chat, { action: "gmail", status: "connected" }, "k1", "old", { now: 2 })).toBe("dropped");
    expect(await tellTexOne(storage, chat, { action: "gmail", status: "Say hi to everyone" }, "k2", "old", { now: 3 })).toBe("dropped");
  });
});
