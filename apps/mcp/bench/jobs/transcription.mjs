/**
 * MEETING TRANSCRIPTION'S CHECK: A SPOKEN SENTENCE, HEARD BACK.
 *
 * Transcription has no prompt: it is Whisper on Workers AI, asked exactly as
 * the transcribe Worker asks it (`infra/transcribe-worker/src/index.ts`:
 * `TURBO_MODEL` with `TURBO_INPUT`). The case's input is a sentence; it is
 * spoken by Workers AI's text-to-speech model, so the test needs no audio file
 * in the repository, and the words Whisper hears are the output checked.
 */

import { workersAi } from "../models.mjs";

/** `infra/transcribe-worker/src/transcribe.ts`, `TURBO_MODEL` and `TURBO_INPUT`. Kept equal by `bench/test/check.test.mjs`. */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const WHISPER_INPUT = Object.freeze({ vad_filter: true });
/** The voice the sentence is read in. */
export const SPEECH_MODEL = "@cf/myshell-ai/melotts";

/** `--fake`: speech is the text itself, and Whisper hears it back unchanged. Plumbing only. */
function fakeWorkersAi() {
  return {
    async run(model, input) {
      if (model === SPEECH_MODEL) return { audio: Buffer.from(String(input.prompt)).toString("base64") };
      if (model === WHISPER_MODEL) return { text: Buffer.from(String(input.audio), "base64").toString("utf8") };
      throw new Error(`fake workers ai: no ${model}`);
    },
  };
}

export const transcriptionJob = {
  name: "meeting-transcription",
  setupNote: false,
  async run({ testCase, fake }) {
    const sentence = String(testCase.input ?? "").trim();
    if (!sentence) throw new Error(`case ${testCase.n}: no input sentence`);
    const ai = fake ? fakeWorkersAi() : workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN);
    const spoken = await ai.run(SPEECH_MODEL, { prompt: sentence, lang: "en" });
    const audio = typeof spoken?.audio === "string" ? spoken.audio : null;
    if (!audio) return { output: "", error: "the speech model returned no audio", ms: 0, model: WHISPER_MODEL };
    const started = Date.now();
    const heard = await ai.run(WHISPER_MODEL, { audio, ...WHISPER_INPUT });
    return { output: String(heard?.text ?? "").trim(), error: null, ms: Date.now() - started, model: WHISPER_MODEL };
  },
};
