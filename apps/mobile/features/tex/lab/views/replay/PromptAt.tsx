/**
 * The prompt a turn ran on, in Replay's right panel (`engine/promptAt.ts`): the commit and setup that answered, then
 * each model round's modules in the order they were sent. A module opens to its exact words when the catalogue at that
 * commit holds its fingerprint; one built from the person's notes or the moment says where it came from instead.
 */
import { useEffect, useState } from "react";

import { catalogAt, commitUrl, fromRepo, moduleSource, toldTime, wordsOf, type TurnPrompt } from "../../engine/promptAt";

type Cat = Awaited<ReturnType<typeof catalogAt>>;

export function PromptAt({ p }: { p: TurnPrompt }) {
  const [cat, setCat] = useState<Cat | "loading">(p.code ? "loading" : null);
  useEffect(() => {
    let live = true;
    if (!p.code) {
      setCat(null);
      return;
    }
    setCat("loading");
    catalogAt(p.code).then((c) => live && setCat(c));
    return () => {
      live = false;
    };
  }, [p.code]);
  const told = toldTime(p.inputs);
  // A round with the same modules as the one before says so, rather than listing them again.
  const key = (r: TurnPrompt["rounds"][number]) => r.modules.map((m) => m.h).join(",");
  return (
    <div className="grp" id="rPrompt">
      <h4>Prompt</h4>
      <div className="rset">
        {p.code ? (
          <a className="pill" href={commitUrl(p.code)} target="_blank" rel="noreferrer" title="The commit that ran this turn">
            Code {p.code.slice(0, 7)}
          </a>
        ) : (
          <span className="pill">Code not logged</span>
        )}
        {p.setup ? <span className="pill" title="The texting setup's version">Setup {p.setup.slice(0, 7)}</span> : null}
        {p.inputs?.model ? <span className="pill">{p.inputs.model.replace(/^anthropic\//, "")}</span> : null}
        {typeof p.inputs?.history === "number" ? <span className="pill">{p.inputs.history} earlier turns</span> : null}
      </div>
      {told ? <p className="hint">Told it was {told}.</p> : null}
      {cat === "loading" ? <p className="hint" id="rPromptLoading">Reading the prompt at this version…</p> : null}
      {p.code && cat === null ? <p className="hint" id="rPromptOld">This version has no prompt catalogue (it ran before 2026-11-14), so only each module's size and fingerprint are shown.</p> : null}
      {p.rounds.length === 0 ? <p className="hint">No context modules logged for this turn (before 2026-11-14 16:00 UTC).</p> : null}
      {p.rounds.map((r, i) => (
        <div key={i} className="io">
          <b>
            Round {i + 1}
            {r.model ? " · " + r.model.replace(/^anthropic\//, "") : ""}
          </b>
          {i > 0 && key(r) === key(p.rounds[i - 1]) ? (
            <p className="hint">Same modules as the round before.</p>
          ) : (
            r.modules.map((m) => {
              const words = cat && cat !== "loading" ? wordsOf(cat, m) : null;
              return (
                <details key={m.id + m.h} className="iofold pmod" data-mod={m.id}>
                  <summary>
                    {m.id} · {m.n.toLocaleString("en-US")} chars{words !== null ? " · exact words" : ""}
                  </summary>
                  {words !== null ? (
                    <pre>{words}</pre>
                  ) : (
                    <p className="hint">
                      {m.id === "preamble/now" && told ? `The time: ${told}. ` : ""}
                      From {moduleSource(m.id)}
                      {cat && cat !== "loading" ? (fromRepo(m.id) ? ". Not in this version's catalogue (a chat's own progress level, say)" : ". Built from their own words when the turn ran, which are never kept") : ""}. Fingerprint {m.h}.
                    </p>
                  )}
                </details>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
}
