/**
 * The children of the canvas's test picker (`#scnPop`; the caller draws the
 * wrapper). The artifact's `renderScnPop`: a search box, the test groups with
 * their tests, and "Your own" with a message box and a Trace button. A click
 * on a test sets the scenario and closes the picker; Trace keeps the typed
 * message as the own scenario.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { TRACE_GROUPS } from "../../data/areas";
import { allCases } from "../../engine/diff";
import { emit, lab } from "../../engine/state";
import { buildTraces, SCENARIOS } from "../../engine/traces";

const GROUPS = ["core", "jobs", "pipeline"];

export function ScnPop({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const own = useRef<HTMLTextAreaElement>(null);
  const ql = q.toLowerCase();

  useEffect(() => {
    search.current?.focus();
  }, []);

  const pick = (k: string) => {
    lab.scn = k;
    onClose();
    emit();
  };
  const trace = () => {
    lab.ownText = (own.current?.value ?? "").trim();
    buildTraces(allCases());
    lab.scn = "own";
    onClose();
    emit();
  };

  return (
    <>
      <input
        ref={search}
        className="search"
        id="scnQ"
        placeholder="Search tests"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        spellCheck={false}
        aria-label="Search tests"
      />
      <div className="scnl">
        {GROUPS.map((gk) => {
          const items = Object.entries(SCENARIOS).filter(
            ([, v]) =>
              v.group === gk &&
              (!ql ||
                (v.name + " " + v.id + " " + TRACE_GROUPS[gk])
                  .toLowerCase()
                  .includes(ql)),
          );
          if (!items.length) return null;
          return (
            <Fragment key={gk}>
              <div className="scng">{TRACE_GROUPS[gk]}</div>
              {items.map(([k, v]) => (
                <button
                  key={k}
                  data-tr={k}
                  aria-current={k === lab.scn ? "true" : "false"}
                  onClick={() => pick(k)}
                >
                  <span className="nm">{v.name}</span>
                  <small>{v.id}</small>
                </button>
              ))}
            </Fragment>
          );
        })}
      </div>
      <div className="scng">{TRACE_GROUPS.own}</div>
      <div className="scnown">
        <textarea
          ref={own}
          id="scnOwn"
          rows={2}
          placeholder="Type a message Tex gets"
          defaultValue={lab.ownText}
        />
        <button className="primary" id="scnOwnGo" onClick={trace}>
          Trace
        </button>
      </div>
    </>
  );
}
