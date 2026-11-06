// A group's voice message heard over the gateway's `TexTexts` entrypoint before the chat decides whether it is for Tex
// (src/agent/textsHear.js, 2026-11-05 bug hunt): the transcription a turn uses, the words handed back bounded, the audio
// and a malformed ask refused, and nothing heard is `{ text: null }`, never an error the Worker must tell apart.
import { test } from "node:test";
import assert from "node:assert/strict";

import { hearForTexts, MAX_HEARD_CHARS, TEXTS_HEAR_PATH } from "../src/agent/textsHear.js";
import { TexTexts } from "../src/index.js";

const CALLER = "a".repeat(64);
const AUDIO = Buffer.from("caff fake audio").toString("base64");

const ask = (body) => new Request(`https://gateway${TEXTS_HEAR_PATH}`, { method: "POST", body: JSON.stringify(body) });

test("a voice message's words come back", async () => {
  let heard = null;
  const transcribe = async (input) => ((heard = input), { text: "Hey Tex, find us a dinner spot for Friday." });
  const response = await hearForTexts(ask({ audioBase64: AUDIO, mimeType: "audio/x-caf", caller: CALLER }), {}, { transcribe });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Hey Tex, find us a dinner spot for Friday." });
  assert.deepEqual(heard, { audioBase64: AUDIO, mimeType: "audio/x-caf", callerId: CALLER });
});

test("nothing heard, a failing service or no service is text null", async () => {
  const silent = async () => ({ text: "" });
  const broken = async () => { throw new Error("down"); };
  for (const transcribe of [silent, broken, null]) {
    const response = await hearForTexts(ask({ audioBase64: AUDIO, mimeType: "audio/x-caf", caller: CALLER }), {}, { transcribe });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: null });
  }
});

test("the words are bounded", async () => {
  const transcribe = async () => ({ text: "Tex ".repeat(2000) });
  const { text } = await (await hearForTexts(ask({ audioBase64: AUDIO, mimeType: "audio/mp4", caller: CALLER }), {}, { transcribe })).json();
  assert.ok(text.length <= MAX_HEARD_CHARS);
});

test("anything but audio from a hashed caller is refused, before any transcription", async () => {
  let called = 0;
  const transcribe = async () => ((called += 1), { text: "x" });
  for (const body of [
    { audioBase64: AUDIO, mimeType: "image/png", caller: CALLER },
    { audioBase64: AUDIO, mimeType: "audio/x-caf", caller: "+15555550101" },
    { audioBase64: "not base64!", mimeType: "audio/x-caf", caller: CALLER },
    { audioBase64: "", mimeType: "audio/x-caf", caller: CALLER },
  ]) {
    assert.equal((await hearForTexts(ask(body), {}, { transcribe })).status, 400);
  }
  assert.equal((await hearForTexts(new Request(`https://gateway${TEXTS_HEAR_PATH}`), {}, { transcribe })).status, 400);
  assert.equal(called, 0);
});

test("the entrypoint routes the hearing path to it and nothing else", async () => {
  // No transcription service configured: heard as nothing, never a session.
  const response = await TexTexts.fetch(ask({ audioBase64: AUDIO, mimeType: "audio/x-caf", caller: CALLER }), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: null });
});
