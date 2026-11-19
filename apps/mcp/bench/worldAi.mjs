/**
 * The Workers AI binding a run's world gets (`run.mjs` answerJobs): which one answers Clef, the router's model, and the
 * embeddings, when the run goes through the model socket.
 *
 * The scripted stand-in (`fakeAi`) answers Clef in the old `tier` shape only, so the specialist router (`readRoute`,
 * which reads `route.choice`) reads nothing from it and every live pick is "none": no specialist door ever runs. Lab
 * `sets run` (MODELS=cc, `.github/workflows/tex-lab-run.yml`: "Clef stays on Workers AI") put its live front door turns
 * on that stand-in, so its fd rows measured the front door alone while the isolated router scoring, on the real binding,
 * read 57/63 (2026-11-18). So:
 *
 *   - a socket that covers workers-ai: the examiner runs those calls for real (`LAB_REAL_ENV`, `labAi`), or a replay
 *     answers them with the stand-in, unchanged;
 *   - a Claude-only socket asked for real Clef (`REAL_CLEF_ENV`, set by the front door's `sets run`, `setsFd.mjs` runFd):
 *     Clef and every other Workers AI model on the binding `benchModels` gave, the same engine the isolated router
 *     scoring uses; the embeddings for search by meaning stay on the stand-in, so what a turn finds does not move;
 *   - any other Claude-only socket (the replay gate, live and replayed): the stand-in, unchanged, because a request
 *     must hash the same live and replayed and the examiner session holds no Cloudflare key.
 */
import { LAB_REAL_ENV, labAi, socketAi } from "./modelSocket.mjs";
import { cachedEmbeddings, fakeAi } from "./models.mjs";
import { MEANING_MODEL } from "../src/search/meaning/embed.js";

/** Set (to anything) by the front door's `sets run` so a Claude-only socketed run keeps Clef on Workers AI. Not a secret. */
export const REAL_CLEF_ENV = "BENCH_REAL_CLEF";

/** Every model on `real`, the embeddings on `embeddings`; a call's options (a gateway route) pass through. */
export function realClefAi(real, embeddings) {
  return { run: (model, input, options) => (model === MEANING_MODEL ? embeddings : real).run(model, input, options) };
}

/** The binding a run's world uses for Workers AI. `socketed` says the run goes through the model socket at all. */
export function worldAi({ socket, socketed, currentAi, env = process.env }) {
  if (!socketed) return currentAi;
  if (socket?.covers("workers-ai") === true) return env[LAB_REAL_ENV] ? labAi(socketAi(socket), cachedEmbeddings(fakeAi())) : cachedEmbeddings(fakeAi());
  return env[REAL_CLEF_ENV] ? realClefAi(currentAi, cachedEmbeddings(fakeAi())) : cachedEmbeddings(fakeAi());
}
