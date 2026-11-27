/**
 * The Lab's place in the address bar (Dev2, 2026-11-14: "please make sure we are tracking state in the url so that when
 * we refresh the page or try to go back it doesnt just take us to the lab homepage"): Lab or Testing, the Lab's page,
 * the group or step focused on the canvas, and the chat and the text a link points at (an old `?mode=replay` address opens the Lab there). A refresh opens where it was; Back and Forward step through pages, modes,
 * focused groups and chats. Picking another text replaces the entry rather than adding one, so Back is not a walk through every text.
 */
import { useEffect } from "react";
import { fit, focusOn, lab, set, subscribe, unfocus } from "../engine/state";
import { pageNamed } from "../engine/pages";
import { pickChat } from "./mine/useMine";
import { placeOf, searchOf, type Place } from "./labPlace";

export { placeOf, searchOf, type Place } from "./labPlace";

const now = (): Place => ({ mode: lab.mode, view: lab.view, chat: lab.myChat, moment: lab.mode === "lab" ? lab.moment : null, set: lab.mode === "testing" ? lab.setChat : null, graph: lab.mode === "lab" && lab.graphPage !== "texting" ? lab.graphPage : null, focus: lab.mode === "lab" && lab.view === "canvas" ? lab.cfocus : null });

/** Put the Lab where an address says. */
function go(p: Place) {
  if (p.chat !== lab.myChat) {
    if (Array.isArray(lab.myTexts)) pickChat(p.chat);
    else lab.myChat = p.chat; // not read yet: the first read is this chat's
  }
  // A node named in the address (Testing's "Node settings" link) opens selected on the canvas; the address keeps no selection after.
  const sel = p.node && lab.cur.graph.nodes.some((n) => n.id === p.node) ? { t: "node" as const, id: p.node } : null;
  // The canvas's page: another page draws other steps, so it is fitted again once drawn.
  // A node named without a page opens on the page it lives on.
  const graphPage = p.graph ?? (sel ? pageNamed(lab.cur.graph.nodes.find((n) => n.id === sel.id)?.graph) : "texting");
  if (graphPage !== lab.graphPage) setTimeout(fit, 0);
  set({ graphPage, mode: p.mode, view: p.view, sel, ...(p.mode === "lab" ? { real: null } : {}), ...(p.moment ? { moment: p.moment } : {}), ...(p.mode === "testing" ? { setChat: p.set ?? null } : {}) });
  // The group opened or the step focused (`?focus=`): Back from a nested group steps out to the one around it.
  if (p.focus) {
    if (p.focus !== lab.cfocus) focusOn(p.focus);
  } else if (lab.cfocus) unfocus();
}

export function useLabUrl() {
  useEffect(() => {
    go(placeOf(window.location.search));
    let last = searchOf(now());
    let lastMain = searchOf({ ...now(), moment: null });
    // Putting the Lab where Back landed changes its state, and every change writes the address; that write must not
    // push the entry Back just left onto the history again (it did, and Back went nowhere).
    let applying = false;
    const write = () => {
      if (applying) return;
      const s = searchOf(now());
      if (s === last) return;
      const main = searchOf({ ...now(), moment: null });
      const url = window.location.pathname + s + window.location.hash;
      if (main === lastMain) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState(window.history.state, "", url);
      last = s;
      lastMain = main;
    };
    const off = subscribe(write);
    const back = () => {
      applying = true;
      try {
        go(placeOf(window.location.search));
      } finally {
        applying = false;
      }
      last = searchOf(now());
      lastMain = searchOf({ ...now(), moment: null });
      // An old or partial address (`?mode=replay`, a focus that is gone) is rewritten as the Lab's own, in place.
      if (last !== window.location.search) window.history.replaceState(window.history.state, "", window.location.pathname + last + window.location.hash);
    };
    window.addEventListener("popstate", back);
    return () => {
      off();
      window.removeEventListener("popstate", back);
    };
  }, []);
}
