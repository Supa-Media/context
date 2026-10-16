import { describe, expect, it } from "vitest";
import { accept, drain, MEDIA_WAIT_MS, TEXT_WAIT_MS, type InboxDeps } from "./inbox";
import { dimensions, prepareAttachments, sniff, MAX_AUDIO_BYTES, MAX_DOWNLOAD_BYTES, type ImagesLike } from "./attachments";
import { officeText } from "./officeText";
import type { Fetch } from "./clients";
import type { InboundAttachment } from "./inbound";
import type { Message } from "./reply";
import { MemoryStorage } from "./memoryStorage.testing";

// A 1x1 PNG, and a few bytes that start like an iPhone's HEIC photo.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A zip of the given files, the first stored and the rest deflated, as Office writes them. */
async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [index, [name, text]] of Object.entries(files).entries()) {
    const raw = new TextEncoder().encode(text);
    const method = index === 0 ? 0 : 8;
    const body =
      method === 0 ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(8, method, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(header.buffer), nameBytes, body);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(10, method, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...local, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}

function serving(files: Record<string, Uint8Array>): Fetch {
  return (async (url: string) => {
    const bytes = files[url];
    return bytes ? new Response(bytes) : new Response(null, { status: 403 });
  }) as unknown as Fetch;
}

const att = (url: string, mimeType: string, filename: string, size: number | null = null): InboundAttachment => ({
  url,
  mimeType,
  filename,
  size,
});

describe("prepareAttachments", () => {
  it("sends a picture and a PDF as data, typed by their bytes", async () => {
    const out = await prepareAttachments(
      [att("https://cdn/a", "image/jpeg", "meme.jpg"), att("https://cdn/b", "application/pdf", "lease.pdf")],
      { fetch: serving({ "https://cdn/a": PNG, "https://cdn/b": PDF }) },
    );
    expect(out).toEqual([
      { name: "meme.jpg", mediaType: "image/png", data: b64(PNG) },
      { name: "lease.pdf", mediaType: "application/pdf", data: b64(PDF) },
    ]);
  });

  it("converts an iPhone HEIC photo to a JPEG, or says it couldn't open it", async () => {
    const fetch = serving({ "https://cdn/h": HEIC });
    const heic = [att("https://cdn/h", "image/heic", "IMG_2368.HEIC")];
    const images: ImagesLike = {
      input: () =>
        ({
          transform: () => ({ output: async () => ({ response: () => new Response(JPEG) }) }),
        }) as unknown as ReturnType<ImagesLike["input"]>,
    };
    expect(await prepareAttachments(heic, { fetch, images })).toEqual([
      { name: "IMG_2368.jpg", mediaType: "image/jpeg", data: b64(JPEG) },
    ]);
    const [without] = await prepareAttachments(heic, { fetch });
    expect(without).toMatchObject({ name: "IMG_2368.HEIC", unread: expect.stringMatching(/photo in a format/) });
    // A picture labelled JPEG that is really HEIC is never sent as a JPEG.
    const [mislabelled] = await prepareAttachments([att("https://cdn/h", "image/jpeg", "x.jpg")], { fetch });
    expect(mislabelled).not.toHaveProperty("data");
  });

  it("reads a text file, a contact card and Office documents as words", async () => {
    const docx = await zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Rent is &amp; was $2,000</w:t></w:r></w:p><w:p><w:r><w:t>Due on the 1st</w:t></w:r></w:p></w:body></w:document>",
    });
    const xlsx = await zip({
      "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Paint</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row></sheetData>',
    });
    const pptx = await zip({
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
    });
    const out = await prepareAttachments(
      [
        att("https://cdn/t", "text/plain", "notes.txt"),
        att("https://cdn/v", "text/vcard", "Ada.vcf"),
        att("https://cdn/d", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "lease.docx"),
        att("https://cdn/x", "", "budget.xlsx"),
        att("https://cdn/p", "", "deck.pptx"),
      ],
      {
        fetch: serving({
          "https://cdn/t": new TextEncoder().encode("buy milk"),
          "https://cdn/v": new TextEncoder().encode("BEGIN:VCARD\nFN:Ada\nEND:VCARD"),
          "https://cdn/d": docx,
          "https://cdn/x": xlsx,
          "https://cdn/p": pptx,
        }),
      },
    );
    expect(out.map((item) => ("text" in item ? item.text : item))).toEqual([
      "buy milk",
      "BEGIN:VCARD\nFN:Ada\nEND:VCARD",
      "Rent is & was $2,000\nDue on the 1st",
      "Sheet 1:\nItem\tCost\nPaint\t42",
      "Slide 1:\nFirst\n\nSlide 2:\nSecond",
    ]);
  });

  it("names what it can't open, and why, instead of failing the text", async () => {
    let downloads = 0;
    const fetch = (async () => {
      downloads += 1;
      return new Response(null, { status: 403 });
    }) as unknown as Fetch;
    const out = await prepareAttachments(
      [
        att("https://cdn/v", "video/quicktime", "clip.mov"),
        att("https://cdn/big", "application/pdf", "huge.pdf", MAX_DOWNLOAD_BYTES + 1),
        att("https://cdn/gone", "image/png", "gone.png"),
      ],
      { fetch },
    );
    expect(out.map((item) => "unread" in item && item.unread)).toEqual([
      expect.stringMatching(/can't watch videos/),
      expect.stringMatching(/over the 25 MB/),
      expect.stringMatching(/download failed/),
    ]);
    // Only the one it could have read was downloaded.
    expect(downloads).toBe(1);
    expect(await officeText(new TextEncoder().encode("not a zip"), "docx")).toBeNull();
  });

  it("sends a voice message on as audio for the gateway to transcribe, whatever Linq labels it", async () => {
    const caf = new Uint8Array([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 9, 9, 9]);
    const fetch = (async () => new Response(caf)) as unknown as Fetch;
    const out = await prepareAttachments(
      [
        att("https://cdn/a", "application/octet-stream", "Audio Message.caf"),
        att("https://cdn/b", "audio/mp4", "memo.mp4"),
      ],
      { fetch },
    );
    expect(out).toEqual([
      { name: "Audio Message.caf", mediaType: "audio/x-caf", data: b64(caf) },
      { name: "memo.mp4", mediaType: "audio/mp4", data: b64(caf) },
    ]);
  });

  it("names a recording too long to transcribe instead of sending it", async () => {
    const fetch = (async () => new Response(new Uint8Array(MAX_AUDIO_BYTES + 1))) as unknown as Fetch;
    const [out] = await prepareAttachments([att("https://cdn/a", "audio/x-caf", "Audio Message.caf")], { fetch });
    expect(out).toMatchObject({ name: "Audio Message.caf", unread: expect.stringMatching(/over the 8 MB Tex can listen to/) });
  });

  it("sends a picture over 8000 pixels on a side through the converter, however small its file", async () => {
    const tall = PNG.slice();
    new DataView(tall.buffer).setUint32(20, 12_000); // a long scrolling screenshot
    expect(dimensions(tall, "image/png")).toEqual({ width: 1, height: 12_000 });
    let converted = 0;
    const images: ImagesLike = {
      input: () => {
        converted += 1;
        return {
          transform: () => ({ output: async () => ({ response: () => new Response(JPEG) }) }),
        } as unknown as ReturnType<ImagesLike["input"]>;
      },
    };
    const [out] = await prepareAttachments([att("https://cdn/t", "image/png", "scroll.png")], {
      fetch: serving({ "https://cdn/t": tall }),
      images,
    });
    expect(converted).toBe(1);
    expect(out).toEqual({ name: "scroll.jpg", mediaType: "image/jpeg", data: b64(JPEG) });
    const [plain] = await prepareAttachments([att("https://cdn/p", "image/png", "p.png")], { fetch: serving({ "https://cdn/p": PNG }), images });
    expect(converted).toBe(1);
    expect(plain).toMatchObject({ mediaType: "image/png" });
  });

  it("reads a JPEG's sides from its frame header", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x27, 0x10, 0x01, 0x00, 3, 0, 0, 0]);
    expect(dimensions(jpeg, "image/jpeg")).toEqual({ width: 256, height: 10_000 });
  });

  it("knows a picture or PDF by its first bytes", () => {
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(JPEG)).toBe("image/jpeg");
    expect(sniff(PDF)).toBe("application/pdf");
    expect(sniff(HEIC)).toBeNull();
  });
});

describe("a photo and its words, texted separately", () => {
  const message = (eventId: string, text: string, attachments?: InboundAttachment[]): Message => ({
    kind: "message",
    eventId,
    chatId: "chat_1",
    from: "+15555550100",
    messageId: `m_${eventId}`,
    text,
    ...(attachments ? { attachments } : {}),
  });

  function deps(asked: Array<{ question: string; attachments?: unknown[] }>): InboxDeps {
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://cdn.linqapp.com/")) return new Response(PNG);
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (path === "/agent") {
        const body = JSON.parse(String(init?.body));
        asked.push({ question: body.question, attachments: body.attachments });
        return Response.json({ answer: "A frog." });
      }
      return new Response("{}", { status: path.endsWith("/typing") ? 204 : 200 });
    }) as unknown as Fetch;
    return {
      fetch: fetcher,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "k",
      now: () => 1_000,
    };
  }

  const photo = [{ url: "https://cdn.linqapp.com/meme.png", mimeType: "image/png", filename: "meme.png", size: 70 }];

  it("a lone photo waits for its words, and they are answered together", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("e1", "", photo), 1_000);
    expect(storage.alarms.at(-1)).toBe(1_000 + MEDIA_WAIT_MS);
    await accept(storage, message("e2", "what's this image"), 2_000);
    expect(storage.alarms.at(-1)).toBe(2_000);
    const asked: Array<{ question: string; attachments?: unknown[] }> = [];
    await drain(storage, deps(asked));
    expect(asked).toEqual([
      { question: "what's this image", attachments: [{ name: "meme.png", mediaType: "image/png", data: b64(PNG) }] },
    ]);
    expect(await storage.list({ prefix: "pending:" })).toEqual(new Map());
  });

  it("a photo with nothing after it is still answered", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("e1", "", photo), 1_000);
    const asked: Array<{ question: string; attachments?: unknown[] }> = [];
    await drain(storage, deps(asked));
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe("");
    expect(asked[0].attachments).toHaveLength(1);
  });

  it("words that overtake their photo wait for it, and are answered together", async () => {
    // Messages sends a photo and then its words; Linq can deliver the words first (2026-10-16).
    const storage = new MemoryStorage();
    await accept(storage, message("e1", "and this one?"), 1_000);
    expect(storage.alarms.at(-1)).toBe(1_000 + TEXT_WAIT_MS);
    await accept(storage, message("e2", "", photo), 1_500);
    expect(storage.alarms.at(-1)).toBe(1_500);
    const asked: Array<{ question: string; attachments?: unknown[] }> = [];
    await drain(storage, deps(asked));
    expect(asked).toEqual([
      { question: "and this one?", attachments: [{ name: "meme.png", mediaType: "image/png", data: b64(PNG) }] },
    ]);
    expect(await storage.list({ prefix: "pending:" })).toEqual(new Map());
  });

  it("a photo after words that already have files of their own is answered on its own", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("e1", "compare these", photo), 1_000);
    await accept(storage, message("e2", "", photo), 1_500);
    const asked: Array<{ question: string; attachments?: unknown[] }> = [];
    await drain(storage, deps(asked));
    expect(asked.map((ask) => [ask.question, ask.attachments?.length])).toEqual([
      ["compare these", 1],
      ["", 1],
    ]);
  });

  it("a photo sent while another text waits does not hold that text up", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("e1", "hello"), 1_000);
    await accept(storage, message("e2", "", photo), 1_500);
    expect(storage.alarms.at(-1)).toBe(1_500);
  });
});
