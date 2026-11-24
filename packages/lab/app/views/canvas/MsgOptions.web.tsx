/**
 * A message's ⋯ in the test chat's Grid (`SandboxChat.web.tsx`): the tapbacks and Reply, and on a test text Edit and
 * Delete (Undo Send), each run as production runs it (`docs/decisions/texting-assistant/edits-and-unsends.md`).
 */
import { reactTo, unsendText, TAPBACKS, useSandbox, type SandboxRow } from "../../engine/sandbox";
import { Pop } from "../bar/Pop.web";

/** A message's ⋯: the tapbacks and Reply, and on a test text Edit and Delete (Undo Send), each run as production runs it. */
export function MsgOptions({ r, onReply, onEdit }: { r: SandboxRow; onReply: () => void; onEdit: () => void }) {
  const sb = useSandbox();
  const own = !r.prod && !r.tex && !r.kind && !r.unsent;
  const idle = !sb.running && !sb.busy;
  return (
    <Pop id={"sbOpt-" + r.id} label="Message options" title="React, reply, edit or delete" className="mopt" button="⋯">
      {(close) => (
        <div className="vmenu">
          <div className="taps">
            {TAPBACKS.map((e) => (
              <button
                key={e}
                data-tap={e}
                title={"React as " + sb.as}
                disabled={!!sb.running || sb.busy}
                onClick={() => {
                  close();
                  void reactTo(r.id, e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <hr />
          <button
            className="mi"
            data-reply={r.id}
            onClick={() => {
              close();
              onReply();
            }}
          >
            ↩ Reply
          </button>
          {own ? (
            <>
              <button
                className="mi"
                data-edit-open={r.id}
                disabled={!idle}
                title={"Edit as " + r.who + ": Tex gets it as a real iMessage edit"}
                onClick={() => {
                  close();
                  onEdit();
                }}
              >
                ✎ Edit
              </button>
              <button
                className="mi"
                data-unsend={r.id}
                disabled={!idle}
                title={"Undo Send as " + r.who + ": Tex gets it as taken back and answers nothing"}
                onClick={() => {
                  close();
                  void unsendText(r.id);
                }}
              >
                ⌫ Delete <span className="meta">Undo Send</span>
              </button>
            </>
          ) : null}
          <div className="mnote">As {sb.as || "you"}; Tex runs on each.</div>
        </div>
      )}
    </Pop>
  );
}
