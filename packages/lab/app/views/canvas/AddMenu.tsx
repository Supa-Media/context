/**
 * The children of the canvas's add menu (`#addMenu`; the caller draws the
 * wrapper). The artifact's `$("#addMenu").innerHTML` from `KINDS`: one button
 * per step kind, with its icon, name and hint. A click hands the kind up.
 */
import { KINDS } from "../../data/graph";
import { Ic } from "../ic";

export function AddMenu({ onPick }: { onPick: (kind: string) => void }) {
  return (
    <>
      {KINDS.map(([m, l, i, d]) => (
        <button key={m} data-kind={m} onClick={() => onPick(m)}>
          <span className="ph" style={{ margin: "0" }}>
            <span className="badge" style={{ width: "32px", height: "32px" }}>
              <Ic k={i} />
            </span>
          </span>
          <span>
            <b style={{ fontWeight: 600 }}>{l}</b>
            <br />
            <span className="hint" style={{ fontSize: "12px" }}>
              {d}
            </span>
          </span>
        </button>
      ))}
    </>
  );
}
