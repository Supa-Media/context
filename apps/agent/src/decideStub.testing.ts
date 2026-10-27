/** Fakes of `POST /agent-texts/decide` for tests (`decide.ts`). */

type Body = { candidates: string[]; newest: string; running: boolean };

/** Decide answering every candidate in one turn: split texts joined. */
export function coverAll(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as Body;
  return Response.json({ ok: true, act: "answer", covers: body.candidates, stale: [], movedOn: false, confidence: 0.9 });
}

/** Decide answering only the newest candidate. */
export function coverNewest(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as Body;
  return Response.json({ ok: true, act: "answer", covers: [body.newest], stale: [], movedOn: false, confidence: 0.9 });
}
