/**
 * A chat's change history (Dev2, 2026-11-16: "Made some change and I couldnt undo it, please make sure we have a change
 * history and the ability to undo"): every saved revision of a Training or Dev chat, newest first, with who changed
 * what and when, and Put back on any of them (a new revision, so putting back is itself undone the same way).
 * `tex_dev` reads and does the same with `set_history` and `set_back`. A Test chat lives in the eval service, which
 * keeps no revisions: there, Undo in the header walks this visit's changes.
 */
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Conversation } from "../../engine/sets";
import { restoreRev } from "../../engine/setsStore";

type Rev = { rev: number; by?: string; via?: string; said: string[]; at?: number; restorable: boolean };

const when = (at?: number) => (at ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export function History({ c }: { c: Conversation }) {
  const test = c.set === "test";
  const h = useQuery(api.functions.texSets.history, test ? "skip" : { id: c.id }) as { rev: number; isNew: boolean; revs: Rev[] } | undefined;
  const revs: Rev[] = h ? [...h.revs, ...(h.isNew ? [] : [{ rev: 0, said: ["The repo's copy"], restorable: true }])] : [];
  return (
    <div className="hist" id="histMenu" role="dialog" aria-label="Change history" onClick={(e) => e.stopPropagation()}>
      {test ? (
        <div className="muted small" style={{ padding: 8 }}>
          Test chats keep no saved history; Undo walks this visit's changes.
        </div>
      ) : !h ? (
        <div className="muted small" style={{ padding: 8 }}>
          Reading the history…
        </div>
      ) : (
        revs.map((r) => {
          const cur = r.rev === h.rev;
          return (
            <div key={r.rev} className={"hr" + (cur ? " cur" : "")} data-rev={r.rev}>
              <span className="small">
                <b>{r.rev ? `Revision ${r.rev}` : "Original"}</b> {r.by ? <span className="muted">· {r.by}{r.via && r.via !== "lab" ? ` via ${r.via}` : ""}</span> : null}
              </span>
              <span className="muted small">{when(r.at)}</span>
              <span className="small" style={{ gridColumn: "1 / -1" }}>
                {r.said.slice(0, 3).join(" · ")}
                {r.said.length > 3 ? ` · +${r.said.length - 3} more` : ""}
              </span>
              <span style={{ gridColumn: "1 / -1" }}>
                {cur ? (
                  <span className="muted small">Now</span>
                ) : r.restorable ? (
                  <button className="btn sm" data-back={r.rev} onClick={() => void restoreRev(c.id, r.rev)}>
                    Put back
                  </button>
                ) : (
                  <span className="muted small">Saved before history kept whole chats</span>
                )}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
