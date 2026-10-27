/**
 * WHAT A PERSON SENDS WITH A TEXT REACHES THE MODEL (owner, 2026-10-15: "make
 * sure that the images and files get attached to the models").
 *
 * Tex answered "I don't see an image come through" to a texted picture: the
 * texting Worker kept only the words. Now `/agent` takes `attachments` — a
 * picture or PDF as base64, a file's words as text, or a file nobody could
 * open with why — and the model gets them as its own image and document
 * blocks, ahead of the person's words. A picture can be kept in a note by
 * reference (`attachment:N`) without the model ever holding its bytes.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `anthropicMessages` ignoring `attachments` → "a texted picture, PDF and
 *     file reach the model as its own blocks" fails.
 *   `readAttachments` letting any media type through as data → "an SVG sent
 *     as data is refused" fails.
 *   `withAttachmentImages` not wrapping the dispatcher → "a texted picture is
 *     kept in a note by reference" fails (the stored image is the literal text).
 *   `attachmentsLine` dropped from the saved conversation → "the saved
 *     conversation names what was sent, never its bytes" fails.
 *   `turnAttachments` not calling `hearVoiceMessages` → "a texted voice
 *     message reaches the model as what was said" fails (readAttachments'
 *     audio passes through as data and no transcript block is built).
 *   hearing voice messages before `openProvider` → "a turn refused for the
 *     daily cap spends no transcription" fails.
 *   `attachmentsLine` dropping the `heard` lines → the same check fails on
 *     the saved conversation.
 *   `anthropicMessages` sending a tool's answer as its words only → "a
 *     picture in a tool's answer is shown to a model that sees…" fails, and
 *     so does the transcript route's read_image check (2026-10-20).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { anthropicMessages, openAiMessages } from "../src/agent/providers.js";
import { hearVoiceMessages, readAttachments, withAttachmentImages } from "../src/agent/attachments.js";
import { KEPT_PHOTOS_PATH } from "../src/agent/pictureMaker.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const ATTACHED = [
  { name: "meme.png", mediaType: "image/png", data: PNG },
  { name: "lease.pdf", mediaType: "application/pdf", data: PDF },
  { name: "Ada.vcf", mediaType: "text/vcard", text: "BEGIN:VCARD\nFN:Ada Lovelace\nEND:VCARD" },
  { name: "clip.mov", mediaType: "video/quicktime", unread: "Tex can't watch videos yet." },
];

const lastUser = (body) => body.messages.filter((message) => message.role === "user").at(-1);

test("a texted picture, PDF and file reach the model as its own blocks", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "A crying cartoon frog." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", {
      question: "what's this image",
      conversation: "texts",
      attachments: ATTACHED,
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "A crying cartoon frog.");
    const content = lastUser(world.model.requests.at(-1)).content;
    assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
    assert.deepEqual(content[1], { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF }, title: "lease.pdf" });
    assert.equal(content[2].type, "document");
    assert.equal(content[2].source.type, "text");
    assert.match(content[2].source.data, /Ada Lovelace/);
    const words = content.at(-1).text;
    assert.match(words, /1\. meme\.png: a picture/);
    assert.match(words, /4\. clip\.mov: could not be opened\. Tex can't watch videos yet\./);
    assert.match(words, /what's this image$/);
    assert.match(words, /data: "attachment:<number>"/);
  } finally {
    world.restore();
  }
});

test("the saved conversation names what was sent, never its bytes", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Nice." }]);
    await request(world.env, TOKEN_TEXTS, "/agent", { question: "look", conversation: "texts", attachments: ATTACHED.slice(0, 1) });
    // The photo itself is kept apart, for a later "try again" (`pictureMaker.js`, KEPT_PHOTOS_PATH);
    // the conversation never carries it.
    const keys = world.objectsUnder(".context/");
    assert.ok(keys.includes(KEPT_PHOTOS_PATH));
    const saved = keys.filter((key) => key !== KEPT_PHOTOS_PATH).map((key) => String(world.bucket.get(key)?.body ?? "")).join("\n");
    // The picture is named with where today's transcript keeps it, so a later text can look again.
    assert.match(saved, /look\\n\[Sent with this text: meme\.png \(image upload-[0-9a-f]{16}\.png in tex\/transcripts\/\d{4}-\d{2}-\d{2}\.md\)\. Seen only on that turn\. read_image with that note and image shows it again; to email one, attach takes the same words \(<image> in <note>\), never the browser\.\]/);
    assert.doesNotMatch(saved, new RegExp(PNG.slice(0, 40).replace(/[+/]/g, "\\$&")));
  } finally {
    world.restore();
  }
});

test("a picture with no words is a question; nothing at all is not", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "A frog." }]);
    const alone = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", attachments: ATTACHED.slice(0, 1) });
    assert.equal(alone.status, 200);
    assert.match(lastUser(world.model.requests.at(-1)).content.at(-1).text, /No words, just the attachments/);
    const nothing = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", attachments: [] });
    assert.equal(nothing.status, 400);
  } finally {
    world.restore();
  }
});

test("a yes sent with a picture goes to the model, not to a waiting ask", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Got it." }]);
    const before = world.model.requests.length;
    const yes = await request(world.env, TOKEN_TEXTS, "/agent", { question: "yes", conversation: "texts", attachments: ATTACHED.slice(0, 1) });
    assert.equal(yes.status, 200);
    assert.equal(world.model.requests.length, before + 1);
  } finally {
    world.restore();
  }
});

test("a texted picture is kept in a note by reference", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([
      {
        toolCalls: [
          {
            name: "write_note",
            args: { path: "1-projects/frog.md", content: "# Frog\n\n![[frog.png]]\n", images: [{ name: "frog.png", data: "attachment:1" }] },
          },
        ],
      },
      { text: "Saved." },
    ]);
    const saved = await request(world.env, TOKEN_TEXTS, "/agent", { question: "save this as a plain note", conversation: "texts", attachments: ATTACHED.slice(0, 1) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const images = world.objectsUnder(".context/assets/images/");
    assert.equal(images.length, 1, `stored: ${images.join(", ")}`);
    const stored = world.bucket.get(images[0]).body;
    const bytes = Buffer.isBuffer(stored) || stored instanceof Uint8Array ? Buffer.from(stored) : Buffer.from(String(stored), "binary");
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
    assert.match(String(world.bucket.get("1-projects/frog.md")?.body ?? ""), /!\[\[upload-[0-9a-f]+\.png\]\]/);
  } finally {
    world.restore();
  }
});

test("attachments the model cannot take are refused before any model runs", async () => {
  const world = await createEgressWorld();
  try {
    const refused = async (attachments) =>
      (await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts", attachments })).status;
    assert.equal(await refused([{ name: "x.svg", mediaType: "image/svg+xml", data: PNG }]), 400, "an SVG sent as data is refused");
    assert.equal(await refused([{ name: "x.png", mediaType: "image/png", data: "not base64!" }]), 400);
    assert.equal(await refused(Array.from({ length: 9 }, () => ATTACHED[0])), 400);
    assert.equal(await refused("meme.png"), 400);
    assert.equal(world.model.requests.length, 0);
  } finally {
    world.restore();
  }
});

test("size ceilings: a picture over write_note's 5,000,000 bytes and a PDF over 10 MB", () => {
  const big = (megabytes) => "A".repeat(Math.ceil((megabytes * 1024 * 1024) / 3) * 4);
  assert.throws(() => readAttachments([{ name: "a.jpg", mediaType: "image/jpeg", data: big(4.8) }]), /5 MB/);
  assert.throws(() => readAttachments([{ name: "a.pdf", mediaType: "application/pdf", data: big(10.1) }]), /10 MB/);
  assert.equal(readAttachments([{ name: "a.jpg", mediaType: "image/jpeg", data: big(4.7) }]).length, 1);
});

test("a model that reads words only is told what it cannot see", () => {
  const [message] = openAiMessages(null, [{ role: "user", text: "what is it", attachments: readAttachments(ATTACHED) }]);
  assert.match(message.content, /meme\.png: you cannot see this one/);
  assert.match(message.content, /Ada Lovelace/);
  // And the Anthropic shape leaves an ordinary text alone.
  assert.deepEqual(anthropicMessages([{ role: "user", text: "hi" }]), [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("a reference that names no picture is passed through for write_note to refuse", async () => {
  const seen = [];
  const call = withAttachmentImages(readAttachments(ATTACHED), async (name, args) => {
    seen.push(args);
    return {};
  });
  await call("write_note", { path: "a.md", images: [{ name: "a.pdf", data: "attachment:2" }, { name: "b.png", data: "attachment:9" }, { name: "c.png", data: "attachment:1" }] });
  assert.equal(seen[0].images[0].data, "attachment:2");
  assert.equal(seen[0].images[1].data, "attachment:9");
  assert.equal(seen[0].images[2].data, `data:image/png;base64,${PNG}`);
  await call("read_note", { path: "a.md", images: [{ data: "attachment:1" }] });
  assert.equal(seen[1].images[0].data, "attachment:1");
});

const VOICE = { name: "Audio Message.caf", mediaType: "audio/x-caf", data: Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 7, 7]).toString("base64") };
const TRANSCRIBER = "https://transcribe.example.test/";

/** The transcription service, answering `answer` (or failing with `status`), and the bodies it was sent. */
function installTranscriber(world, { answer = { text: " Pick up oat milk on the way home. ", segments: [] }, status = 200 } = {}) {
  world.env.TRANSCRIBE_WORKER_URL = TRANSCRIBER;
  world.env.TRANSCRIBE_WORKER_SECRET = "test-transcribe-secret";
  const sent = [];
  const through = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(TRANSCRIBER)) return through(input, init);
    sent.push({ url, auth: new Headers(init.headers).get("Authorization"), body: JSON.parse(init.body) });
    return Response.json(answer, { status });
  };
  return sent;
}

test("a texted voice message reaches the model as what was said, and is kept as said", async () => {
  const world = await createEgressWorld();
  try {
    const sent = installTranscriber(world);
    world.model.install([{ text: "Added oat milk." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", attachments: [VOICE] });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${TRANSCRIBER}transcribe`);
    assert.equal(sent[0].auth, "Bearer test-transcribe-secret");
    assert.deepEqual(Object.keys(sent[0].body).sort(), ["audioBase64", "mimeType"], "no ids travel with the audio");
    assert.equal(sent[0].body.audioBase64, VOICE.data);
    const content = lastUser(world.model.requests.at(-1)).content;
    assert.deepEqual(content[0], {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "Pick up oat milk on the way home." },
      title: "Audio Message.caf (voice message, transcribed)",
    });
    assert.match(content.at(-1).text, /1\. Audio Message\.caf: a voice message; what they said is transcribed above/);
    assert.ok(!JSON.stringify(world.model.requests.at(-1)).includes(VOICE.data), "the audio itself never reaches the model");
    const saved = world.objectsUnder(".context/").map((key) => String(world.bucket.get(key)?.body ?? "")).join("\n");
    assert.match(saved, /Voice message Audio Message\.caf: \\"Pick up oat milk on the way home\.\\"/);
    assert.ok(!saved.includes(VOICE.data));
  } finally {
    world.restore();
  }
});

test("a voice message nobody could transcribe is named as such, and the turn still answers", async () => {
  const world = await createEgressWorld();
  try {
    installTranscriber(world, { status: 502, answer: { error: "upstream" } });
    world.model.install([{ text: "Could you type it?" }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", attachments: [VOICE] });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.match(lastUser(world.model.requests.at(-1)).content.at(-1).text, /could not be opened\. It is a voice message, and transcribing it failed/);
  } finally {
    world.restore();
  }
});

test("a turn refused for the daily cap spends no transcription", async () => {
  const world = await createEgressWorld();
  try {
    const sent = installTranscriber(world);
    world.controlPlane.setBuiltinVerdict("ws_egress", { allowed: false, reason: "daily_cap" });
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", attachments: [VOICE] });
    assert.equal(asked.status, 429);
    assert.equal(sent.length, 0, "the audio was never sent");
  } finally {
    world.restore();
  }
});

test("voice messages: no service, silence, and the 8 MB ceiling", async () => {
  const [none] = await hearVoiceMessages([VOICE], null, "ws");
  assert.match(none.unread, /can't be transcribed on this server/);
  const [quiet] = await hearVoiceMessages([VOICE], async () => ({ text: "", segments: [], refused: 2 }), "ws");
  assert.match(quiet.unread, /no words you could make out/);
  const [joined] = await hearVoiceMessages([VOICE], async () => ({ segments: [{ text: " One." }, { text: "Two. " }] }), "ws");
  assert.equal(joined.text, "One. Two.");
  const big = "A".repeat(Math.ceil((8.1 * 1024 * 1024) / 3) * 4);
  assert.throws(() => readAttachments([{ name: "a.caf", mediaType: "audio/x-caf", data: big }]), /8 MB/);
});

test("a picture in a tool's answer is shown to a model that sees, and named to one that does not", () => {
  const messages = [
    { role: "assistant", toolCalls: [{ id: "t1", name: "read_image", args: {} }] },
    { role: "tool", id: "t1", name: "read_image", text: "The image.", images: [{ mediaType: "image/png", data: PNG }] },
  ];
  const shown = anthropicMessages(messages).at(-1).content[0];
  assert.deepEqual(shown.content, [
    { type: "text", text: "The image." },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ]);
  const named = openAiMessages("", messages).at(-1).content;
  assert.match(named, /^The image\.\n\[A picture in this result; you cannot see pictures on this model/);
});
