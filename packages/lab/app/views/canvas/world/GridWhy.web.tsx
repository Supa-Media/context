/**
 * The why line in the Grid's Message cell for a made-up group chat (artboard 03-grid of `group-chat-sim-artboards/`):
 * Tex answers or stays quiet, the reason cut short, and a tag naming the step that decided, which matches a column.
 */
import type { SandboxRow } from "../../../engine/sandbox";
import { whyOf } from "./chatModel";

export function GridWhy({ r, rows, running }: { r: SandboxRow; rows: SandboxRow[]; running: boolean }) {
  const why = whyOf(
    r,
    rows.filter((x) => x.tex && x.reply === r.id),
    running,
  );
  if (!why) return null;
  return (
    <span className={"why " + (why.yes ? "yes" : "no")}>
      <span className="v">{why.yes === null ? "Tex is deciding" : why.yes ? "Tex answers" : "Tex stays quiet"}</span>
      <span className="r" title={why.reason}>
        {why.reason}
      </span>
      {why.by ? (
        <span className="by" title="The step that decided">
          {why.by}
        </span>
      ) : null}
    </span>
  );
}
