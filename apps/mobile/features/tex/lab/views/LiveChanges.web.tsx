/**
 * The draft's live part of the Lab (Dev2, 2026-11-15): the top bar's "● Claude Code is editing" and "rev N · saved"
 * chips, and the Changes list in the sidebar: what each side just did to this draft, newest first.
 */
import { aiClient, ago, isLive, live, whoLabel } from "../engine/live";
import { lab } from "../engine/state";

const myHandle = () => lab.me?.handle ?? (lab.myId ? lab.names[lab.myId] : null) ?? null;

export function LiveChips() {
  if (!isLive()) return null;
  const ai = aiClient();
  return (
    <>
      {ai ? (
        <span className="lchip ai" id="liveAi" title="An AI client is changing this draft over the Context connection">
          {ai} is editing
        </span>
      ) : null}
      <span className="lchip" id="liveRev" title="Every edit is saved as it happens">
        rev {live.rev} · {lab.dirty || live.inflight ? "saving" : "saved"}
      </span>
    </>
  );
}

export function LiveChanges() {
  if (!isLive()) return null;
  const rows = [...live.feed.changes].sort((a, b) => b.rev - a.rev).slice(0, 30);
  return (
    <>
      <div className="sec">
        <span>Changes</span>
      </div>
      <div className="chg" id="changes">
        {rows.length ? (
          rows.map((c) => (
            <div key={c.rev} className={"row" + (c.via !== "lab" ? " ai" : "")}>
              <span>
                <b>{whoLabel(c, myHandle())}</b> {c.said.join("; ") || "changed the draft"}
              </span>
              <small>
                rev {c.rev} · {ago(c.at)}
              </small>
            </div>
          ))
        ) : (
          <div className="none">Nothing changed yet.</div>
        )}
      </div>
    </>
  );
}
