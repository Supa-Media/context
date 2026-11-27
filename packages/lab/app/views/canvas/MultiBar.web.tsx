/**
 * The bar over several picked steps, and its Make component popover (Dev, 2026-11-27; artboard
 * /lab-new-component-artboards, frames 01, 02, 05 and 06). The bar sits centred just above the canvas's toolbar:
 * placed beside the picks it covered the open group's title and steps, and picks spread across the canvas have no
 * single "near" (as in Figma UI3's bottom bar).
 *
 *   3 steps | ◇ Make component ⌥⌘K | ✕
 *
 * When the picks cannot become a component the button is greyed, with no shortcut, and a second line says why, naming
 * the step (`engine/makeComponent.ts` `whyNot`). The popover asks a Name (prefilled, all selected) and an optional
 * Goal; Enter creates, Esc closes it and keeps the picks.
 */
import { useEffect, useRef, useState } from "react";
import { fromWhere, makeComponent, NEW_NAME, whyNot } from "../../engine/makeComponent";
import { clearPicks } from "../../engine/picks";
import { set } from "../../engine/state";
import { useLab } from "../../store";

const DIAMOND = '<path d="M12 3.5l8.5 8.5-8.5 8.5-8.5-8.5z"/>';
const CROSS = '<path d="M7 7l10 10M17 7L7 17"/>';

/** The shortcut as this keyboard writes it: ⌥⌘K on a Mac, Ctrl+Alt+K elsewhere. */
export function makeKeys(): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  return mac ? "⌥⌘K" : "Ctrl+Alt+K";
}

/** ⌥⌘K or Ctrl+Alt+K (read by the key's place, since ⌥ changes the letter a Mac types). */
export const isMakeKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.altKey && (e.code === "KeyK" || e.key.toLowerCase() === "k");

export function MultiBar({ ids }: { ids: string[] }) {
  const s = useLab();
  const why = whyNot(ids);
  const open = s.makeOpen && !why;
  const n = ids.length;
  return (
    <>
      <div className="float mbar" id="multiBar" role="toolbar" aria-label={`${n} steps selected`}>
        <span className="mcount">{n} steps</span>
        <span className="sep" />
        <button
          className={"mmake" + (open ? " on" : "")}
          id="makeComp"
          aria-disabled={why ? true : undefined}
          aria-expanded={open}
          title={why ? why.text : `Make component (${makeKeys()})`}
          onClick={() => {
            if (!why) set({ makeOpen: !open });
          }}
        >
          <svg className="i dia" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: DIAMOND }} />
          Make component
          {why ? null : <span className="mkbd">{makeKeys()}</span>}
        </button>
        <button className="ib mx" title="Clear the selection (Esc)" aria-label="Clear the selection" onClick={clearPicks}>
          <svg className="i" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: CROSS }} />
        </button>
        {why ? (
          <div className="mwhy" id="makeWhy">
            {why.bold && why.text.startsWith(why.bold) ? (
              <>
                <b>{why.bold}</b>
                {why.text.slice(why.bold.length)}
              </>
            ) : (
              why.text
            )}
          </div>
        ) : null}
      </div>
      {open ? <MakePopover ids={ids} /> : null}
    </>
  );
}

function MakePopover({ ids }: { ids: string[] }) {
  const [name, setName] = useState(NEW_NAME);
  const [goal, setGoal] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  const create = () => makeComponent(ids, name, goal);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    } else if (e.key === "Escape") {
      // Closes the popover and keeps the picks: the canvas's own Esc (clear) never sees it.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      set({ makeOpen: false });
    }
  };
  return (
    <div className="mpop" id="makePop" role="dialog" aria-label="Make component" onKeyDown={keys}>
      <label className="mf">
        <span>Name</span>
        <input ref={nameRef} id="makeName" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mf">
        <span>
          Goal <small>optional</small>
        </span>
        <input id="makeGoal" value={goal} maxLength={200} placeholder="What it does, in one line" onChange={(e) => setGoal(e.target.value)} />
      </label>
      <div className="mfoot">
        <span className="mfrom">
          {ids.length} steps from {fromWhere()}
        </span>
        <button className="primary" id="makeCreate" onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}
