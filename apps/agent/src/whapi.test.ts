import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REPLY_TEXT, ServiceError, type Fetch } from "./clients";
import {
  groupJidOf,
  isWhapiChat,
  markWhapiRead,
  parseWhapiChat,
  personOfJid,
  phoneOfJid,
  reactWhapi,
  readWhapiGroupMembers,
  readWhapiMessage,
  sendWhapiContact,
  sendWhapiMedia,
  sendWhapiText,
  startWhapiTyping,
  toOfPhone,
  verifyWhapiSecret,
  whapiChatId,
  whapiGroupId,
  whapiKeys,
  WHAPI_SECRET_HEADER,
} from "./whapi";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const GROUP = "120363012345678901@g.us";
const MSG = "3EB0C767-D26A6F3B1A2C";
const KEYS = { token: "tok-123", line: LINE };
const SENT = { sent: true, message: { id: "3EB0C767-AAAAAAAAAAAA" } };

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };

/** A fake Whapi: every call is recorded; `reply` decides what comes back (a thrown Error is a network failure). */
function fakeWhapi(reply: (url: string, method: string, body: Record<string, unknown> | null) => Reply | Error = () => ({ status: 200, body: SENT })) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(init.method);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method, headers: new Headers(init.headers), body });
    const answer = reply(url, method, body);
    if (answer instanceof Error) throw answer;
    return new Response(answer.raw ?? (answer.body === undefined ? null : JSON.stringify(answer.body)), { status: answer.status });
  });
  return { fetcher: fetcher as unknown as Fetch, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("whapi keys and chat ids", () => {
  it("needs a token and an E.164 line, trimmed", () => {
    expect(whapiKeys(" tok-123 ", " +15555550199 ")).toEqual(KEYS);
    expect(whapiKeys("", LINE)).toBeNull();
    expect(whapiKeys("   ", LINE)).toBeNull();
    expect(whapiKeys(undefined, LINE)).toBeNull();
    expect(whapiKeys("tok", undefined)).toBeNull();
    expect(whapiKeys("tok", "15555550199")).toBeNull();
    expect(whapiKeys("tok", "+0555")).toBeNull();
  });

  it("round-trips a 1:1 chat id and refuses anything else", () => {
    expect(whapiChatId(LINE, PHONE)).toBe(`whapi:${LINE}:${PHONE}`);
    expect(parseWhapiChat(whapiChatId(LINE, PHONE))).toEqual({ line: LINE, phone: PHONE });
    expect(isWhapiChat(whapiChatId(LINE, PHONE))).toBe(true);
    expect(parseWhapiChat(`whapi:${GROUP}`)).toBeNull();
    expect(parseWhapiChat(`whapi:${LINE}`)).toBeNull();
    expect(parseWhapiChat(`whapi:${LINE}:${PHONE}:extra`)).toBeNull();
    expect(parseWhapiChat(`whapi:${LINE}:someone@example.com`)).toBeNull();
    expect(parseWhapiChat(`whapi:${LINE}:15555550100`)).toBeNull();
    expect(parseWhapiChat(`sendblue:${LINE}:${PHONE}`)).toBeNull();
    expect(isWhapiChat(`whapi:${GROUP}`)).toBe(false);
  });

  it("round-trips a group id, and only a group jid is one", () => {
    expect(whapiGroupId(GROUP)).toBe(`whapi:${GROUP}`);
    expect(groupJidOf(whapiGroupId(GROUP))).toBe(GROUP);
    expect(groupJidOf(whapiChatId(LINE, PHONE))).toBeNull();
    expect(groupJidOf("whapi:not-a-jid")).toBeNull();
    expect(groupJidOf(`sendblue:${GROUP}`)).toBeNull();
  });
});

describe("whapi ids as people", () => {
  it("reads a phone jid as its phone, in every form WhatsApp writes one", () => {
    expect(phoneOfJid("15555550100@s.whatsapp.net")).toBe(PHONE);
    expect(phoneOfJid("15555550100@c.us")).toBe(PHONE);
    expect(phoneOfJid("15555550100")).toBe(PHONE);
  });

  it("never reads a @lid, a group or a malformed id as a phone", () => {
    expect(phoneOfJid("15555550100@lid")).toBeNull();
    expect(phoneOfJid(GROUP)).toBeNull();
    expect(phoneOfJid("15555550100@broadcast")).toBeNull();
    expect(phoneOfJid("1555abc")).toBeNull();
    expect(phoneOfJid("")).toBeNull();
  });

  it("names a @lid as lid:<digits>, never as the phone its digits look like", () => {
    expect(personOfJid("15555550100@lid")).toBe("lid:15555550100");
    expect(personOfJid("15555550100@lid")).not.toBe(PHONE);
    expect(personOfJid("15555550100@s.whatsapp.net")).toBe(PHONE);
    expect(personOfJid(GROUP)).toBe("?");
    expect(personOfJid("garbage")).toBe("?");
  });

  it("addresses a phone by its digits", () => {
    expect(toOfPhone(PHONE)).toBe("15555550100");
    expect(toOfPhone(GROUP)).toBe(GROUP);
  });
});

describe("whapi webhook secret", () => {
  const secret = "0123456789abcdef-secret";
  const headers = (value?: string) => {
    const h = new Headers();
    if (value !== undefined) h.set(WHAPI_SECRET_HEADER, value);
    return h;
  };

  it("accepts the exact header and refuses wrong, missing or short secrets", async () => {
    expect(await verifyWhapiSecret(secret, headers(secret))).toBe(true);
    expect(await verifyWhapiSecret(secret, headers(` ${secret} `))).toBe(true);
    expect(await verifyWhapiSecret(secret, headers(`${secret}x`))).toBe(false);
    expect(await verifyWhapiSecret(secret, headers("wrong-but-long-enough"))).toBe(false);
    expect(await verifyWhapiSecret(secret, headers())).toBe(false);
    expect(await verifyWhapiSecret(secret, headers(""))).toBe(false);
    const short = "0123456789abcde";
    expect(await verifyWhapiSecret(short, headers(short))).toBe(false);
    expect(await verifyWhapiSecret("", headers(""))).toBe(false);
  });
});

describe("sendWhapiText", () => {
  it("posts the text to the phone's digits with the bearer token and returns the sent id", async () => {
    const { fetcher, calls } = fakeWhapi();
    const id = await sendWhapiText(fetcher, KEYS, PHONE, "hello");
    expect(id).toBe("3EB0C767-AAAAAAAAAAAA");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gate.whapi.cloud/messages/text");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok-123");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[0].body).toEqual({ to: "15555550100", body: "hello" });
  });

  it("sends a group to its jid unchanged", async () => {
    const { fetcher, calls } = fakeWhapi();
    await sendWhapiText(fetcher, KEYS, GROUP, "hi all");
    expect(calls[0].body).toEqual({ to: GROUP, body: "hi all" });
  });

  it("refuses a destination that is neither a phone nor a group, without calling Whapi", async () => {
    const { fetcher, calls } = fakeWhapi();
    await expect(sendWhapiText(fetcher, KEYS, "someone@example.com", "hi")).rejects.toBeInstanceOf(ServiceError);
    expect(calls).toHaveLength(0);
  });

  it("slices the body to the reply limit", async () => {
    const { fetcher, calls } = fakeWhapi();
    await sendWhapiText(fetcher, KEYS, PHONE, "a".repeat(MAX_REPLY_TEXT + 50));
    expect((calls[0].body?.body as string).length).toBe(MAX_REPLY_TEXT);
  });

  it("quotes a plausible message id", async () => {
    const { fetcher, calls } = fakeWhapi();
    await sendWhapiText(fetcher, KEYS, PHONE, "yes", MSG);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ to: "15555550100", body: "yes", quoted: MSG });
  });

  it("leaves out a quote that is not a message id", async () => {
    const { fetcher, calls } = fakeWhapi();
    await sendWhapiText(fetcher, KEYS, PHONE, "yes", "not an id!");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toHaveProperty("quoted");
  });

  it("sends again plain when the quoted send is refused with a 4xx, logging only the status", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetcher, calls } = fakeWhapi((_url, _method, body) =>
      body?.quoted !== undefined ? { status: 400, raw: "QUOTE-ECHO-SECRET quoted text" } : { status: 200, body: SENT },
    );
    const id = await sendWhapiText(fetcher, KEYS, PHONE, "yes", MSG);
    expect(id).toBe("3EB0C767-AAAAAAAAAAAA");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveProperty("quoted", MSG);
    expect(calls[1].body).toEqual({ to: "15555550100", body: "yes" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('{"event":"whapi_quote","outcome":"refused","status":400}');
  });

  it("throws ServiceError on a 500 and never puts the error body anywhere", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetcher } = fakeWhapi(() => ({ status: 500, raw: "BODY-ECHO-SECRET the message text" }));
    const error = await sendWhapiText(fetcher, KEYS, PHONE, "hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).service).toBe("whapi");
    expect((error as ServiceError).status).toBe(500);
    expect(String(error)).not.toContain("BODY-ECHO-SECRET");
    expect(log).not.toHaveBeenCalled();
  });

  it("throws ServiceError with a null status when the request fails or times out", async () => {
    const { fetcher } = fakeWhapi(() => new Error("socket reset"));
    const error = await sendWhapiText(fetcher, KEYS, PHONE, "hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBeNull();
  });

  it("returns no id when the id is not a string or is over 200 characters", async () => {
    const long = { status: 200, body: { sent: true, message: { id: "x".repeat(201) } } };
    expect(await sendWhapiText(fakeWhapi(() => long).fetcher, KEYS, PHONE, "hi")).toBeUndefined();
    const numeric = { status: 200, body: { sent: true, message: { id: 42 } } };
    expect(await sendWhapiText(fakeWhapi(() => numeric).fetcher, KEYS, PHONE, "hi")).toBeUndefined();
  });
});

describe("sendWhapiMedia", () => {
  it("sends a picture as an image, whatever its case and query", async () => {
    const { fetcher, calls } = fakeWhapi();
    const url = "https://cdn.example.com/out/PHOTO.JPG?sig=abc";
    await sendWhapiMedia(fetcher, KEYS, PHONE, url);
    expect(calls[0].url).toBe("https://gate.whapi.cloud/messages/image");
    expect(calls[0].body).toEqual({ to: "15555550100", media: url });
  });

  it("sends anything else as a document named after the address's last segment", async () => {
    const { fetcher, calls } = fakeWhapi();
    await sendWhapiMedia(fetcher, KEYS, GROUP, "https://cdn.example.com/out/report%20final.pdf");
    expect(calls[0].url).toBe("https://gate.whapi.cloud/messages/document");
    expect(calls[0].body).toEqual({ to: GROUP, media: "https://cdn.example.com/out/report%20final.pdf", filename: "report final.pdf" });
    await sendWhapiMedia(fetcher, KEYS, PHONE, "https://cdn.example.com/out/clip.heic");
    expect(calls[1].url).toBe("https://gate.whapi.cloud/messages/document");
  });

  it("refuses an address that is not https, without calling Whapi", async () => {
    const { fetcher, calls } = fakeWhapi();
    const error = await sendWhapiMedia(fetcher, KEYS, PHONE, "http://cdn.example.com/a.png").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("quotes like a text, and sends plain after a quote refused with a 4xx", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetcher, calls } = fakeWhapi((_url, _method, body) => (body?.quoted !== undefined ? { status: 400 } : { status: 200, body: SENT }));
    await sendWhapiMedia(fetcher, KEYS, PHONE, "https://cdn.example.com/a.webp", MSG);
    expect(calls.map((c) => c.body?.quoted)).toEqual([MSG, undefined]);
  });

  it("throws ServiceError on a 500", async () => {
    const { fetcher } = fakeWhapi(() => ({ status: 500 }));
    const error = await sendWhapiMedia(fetcher, KEYS, PHONE, "https://cdn.example.com/a.png").catch((e: unknown) => e);
    expect((error as ServiceError).status).toBe(500);
  });
});

describe("sendWhapiContact", () => {
  it("is true on a 2xx and posts the card to the phone's digits", async () => {
    const { fetcher, calls } = fakeWhapi();
    expect(await sendWhapiContact(fetcher, KEYS, PHONE, "Tex", "BEGIN:VCARD")).toBe(true);
    expect(calls[0].url).toBe("https://gate.whapi.cloud/messages/contact");
    expect(calls[0].body).toEqual({ to: "15555550100", name: "Tex", vcard: "BEGIN:VCARD" });
  });

  it("is false on a refusal, a failure or a bad destination, and never throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sendWhapiContact(fakeWhapi(() => ({ status: 500, raw: "ECHO" })).fetcher, KEYS, PHONE, "Tex", "v")).toBe(false);
    expect(await sendWhapiContact(fakeWhapi(() => new Error("down")).fetcher, KEYS, PHONE, "Tex", "v")).toBe(false);
    expect(await sendWhapiContact(fakeWhapi().fetcher, KEYS, "nope", "Tex", "v")).toBe(false);
  });
});

describe("reactWhapi", () => {
  it("refuses a bad message id without calling Whapi", async () => {
    const { fetcher, calls } = fakeWhapi();
    expect(await reactWhapi(fetcher, KEYS, "../../groups/x", "❤️")).toBe(false);
    expect(await reactWhapi(fetcher, KEYS, "bad id!", "❤️")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("puts the emoji on the message and is true on a 2xx", async () => {
    const { fetcher, calls } = fakeWhapi(() => ({ status: 200, body: { success: true } }));
    expect(await reactWhapi(fetcher, KEYS, MSG, "❤️")).toBe(true);
    expect(calls[0].url).toBe(`https://gate.whapi.cloud/messages/${MSG}/reaction`);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({ emoji: "❤️" });
  });

  it("is false on a refusal, and never throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reactWhapi(fakeWhapi(() => ({ status: 404 })).fetcher, KEYS, MSG, "👍")).toBe(false);
    expect(await reactWhapi(fakeWhapi(() => new Error("timeout")).fetcher, KEYS, MSG, "👍")).toBe(false);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '{"event":"whapi_reaction","outcome":"refused","status":404}',
      '{"event":"whapi_reaction","outcome":"refused","status":null}',
    ]);
  });
});

describe("typing and read receipts", () => {
  it("sets typing on a chat by its digits or its group jid, encoded", async () => {
    const { fetcher, calls } = fakeWhapi(() => ({ status: 200 }));
    await startWhapiTyping(fetcher, KEYS, PHONE);
    await startWhapiTyping(fetcher, KEYS, GROUP);
    expect(calls[0].url).toBe("https://gate.whapi.cloud/presences/15555550100");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({ presence: "typing" });
    expect(calls[1].url).toBe("https://gate.whapi.cloud/presences/120363012345678901%40g.us");
  });

  it("never throws, even when Whapi cannot be reached", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(startWhapiTyping(fakeWhapi(() => new Error("down")).fetcher, KEYS, PHONE)).resolves.toBeUndefined();
    await expect(markWhapiRead(fakeWhapi(() => new Error("down")).fetcher, KEYS, MSG)).resolves.toBeUndefined();
  });

  it("marks a message read with a bodiless PUT, and skips a bad id", async () => {
    const { fetcher, calls } = fakeWhapi(() => ({ status: 200 }));
    await markWhapiRead(fetcher, KEYS, MSG);
    await markWhapiRead(fetcher, KEYS, "bad id!");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://gate.whapi.cloud/messages/${MSG}`);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toBeNull();
  });
});

describe("readWhapiMessage", () => {
  it("reads a text's body and whether Tex sent it", async () => {
    const { fetcher, calls } = fakeWhapi(() => ({ status: 200, body: { id: MSG, chat_id: `${PHONE.slice(1)}@s.whatsapp.net`, from_me: true, type: "text", text: { body: "  hi there  " } } }));
    expect(await readWhapiMessage(fetcher, KEYS, MSG)).toEqual({ chatId: "15555550100@s.whatsapp.net", fromMe: true, text: "hi there" });
    expect(calls[0].url).toBe(`https://gate.whapi.cloud/messages/${MSG}`);
    expect(calls[0].method).toBe("GET");
  });

  it("reads a picture's caption, and is not from Tex when from_me is not true", async () => {
    const { fetcher } = fakeWhapi(() => ({ status: 200, body: { chat_id: "15555550100@s.whatsapp.net", from_me: false, type: "image", image: { caption: "look at this" } } }));
    expect(await readWhapiMessage(fetcher, KEYS, MSG)).toEqual({ chatId: "15555550100@s.whatsapp.net", fromMe: false, text: "look at this" });
  });

  it("slices the words to 500", async () => {
    const { fetcher } = fakeWhapi(() => ({ status: 200, body: { chat_id: "c", from_me: false, text: { body: "b".repeat(600) } } }));
    expect((await readWhapiMessage(fetcher, KEYS, MSG))?.text.length).toBe(500);
  });

  it("is null for a bad id without calling Whapi, for a failure, and for a message with no chat", async () => {
    const { fetcher, calls } = fakeWhapi();
    expect(await readWhapiMessage(fetcher, KEYS, "bad id!")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await readWhapiMessage(fakeWhapi(() => ({ status: 404 })).fetcher, KEYS, MSG)).toBeNull();
    expect(await readWhapiMessage(fakeWhapi(() => new Error("down")).fetcher, KEYS, MSG)).toBeNull();
    expect(await readWhapiMessage(fakeWhapi(() => ({ status: 200, body: { from_me: true } })).fetcher, KEYS, MSG)).toBeNull();
  });
});

describe("readWhapiGroupMembers", () => {
  it("maps each participant as personOfJid does, and adds Tex's own line", async () => {
    const { fetcher, calls } = fakeWhapi(() => ({
      status: 200,
      body: {
        id: GROUP,
        participants: [
          { id: "15555550100", rank: "admin" },
          { id: "15557654321@s.whatsapp.net", rank: "member" },
          { id: "98765@lid", rank: "member" },
          { id: "not-an-id", rank: "member" },
        ],
      },
    }));
    expect(await readWhapiGroupMembers(fetcher, KEYS, GROUP)).toEqual(["+15555550100", "+15557654321", "lid:98765", "?", LINE]);
    expect(calls[0].url).toBe("https://gate.whapi.cloud/groups/120363012345678901%40g.us");
  });

  it("never reads a @lid as a phone", async () => {
    const { fetcher } = fakeWhapi(() => ({ status: 200, body: { participants: [{ id: "15555550100@lid" }] } }));
    const members = await readWhapiGroupMembers(fetcher, KEYS, GROUP);
    expect(members).toContain("lid:15555550100");
    expect(members).not.toContain(PHONE);
  });

  it("reads at most 64 participants", async () => {
    const participants = Array.from({ length: 70 }, (_, i) => ({ id: `1555555${String(1000 + i).padStart(4, "0")}` }));
    const { fetcher } = fakeWhapi(() => ({ status: 200, body: { participants } }));
    const members = await readWhapiGroupMembers(fetcher, KEYS, GROUP);
    expect(members).toHaveLength(65);
    expect(members?.at(-1)).toBe(LINE);
  });

  it("is null for a jid that is not a group, without calling Whapi, and for any failure", async () => {
    const { fetcher, calls } = fakeWhapi();
    expect(await readWhapiGroupMembers(fetcher, KEYS, PHONE)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await readWhapiGroupMembers(fakeWhapi(() => ({ status: 403 })).fetcher, KEYS, GROUP)).toBeNull();
    expect(await readWhapiGroupMembers(fakeWhapi(() => new Error("down")).fetcher, KEYS, GROUP)).toBeNull();
    expect(await readWhapiGroupMembers(fakeWhapi(() => ({ status: 200, body: { id: GROUP } })).fetcher, KEYS, GROUP)).toBeNull();
  });
});
