/**
 * The Lab's place in the address bar (Dev2, 2026-11-14: "please make sure we are tracking state in the url so that when
 * we refresh the page or try to go back it doesnt just take us to the lab homepage"): Lab or Testing, the Lab's page,
 * and the chat and the text a link points at (an old `?mode=replay` address opens the Lab there). A refresh opens where it was; Back and Forward step through pages, modes and
 * chats. Picking another text replaces the entry rather than adding one, so Back is not a walk through every text.
 */
import { useEffect } from "react";
import { lab, set, subscribe } from "../engine/state";
import { pickChat } from "./mine/useMine";
import { placeOf, searchOf, type Place } from "./labPlace";

export { placeOf, searchOf, type Place } from "./labPlace";

const now = (): Place => ({ mode: lab.mode, view: lab.view, chat: lab.myChat, moment: lab.mode === "lab" ? lab.moment : null, set: lab.mode === "testing" ? lab.setChat : null });

/** Put the Lab where an address says. */
function go(p: Place) {
  if (p.chat !== lab.myChat) {
    if (Array.isArray(lab.myTexts)) pickChat(p.chat);
    else lab.myChat = p.chat; // not read yet: the first read is this chat's
  }
  // A node named in the address (Testing's "Node settings" link) opens selected on the canvas; the address keeps no selection after.
  const sel = p.node && lab.cur.graph.nodes.some((n) => n.id === p.node) ? { t: "node" as const, id: p.node } : null;
  set({ mode: p.mode, view: p.view, sel, cfocus: null, ...(p.mode === "lab" ? { real: null } : {}), ...(p.moment ? { moment: p.moment } : {}), ...(p.mode === "testing" ? { setChat: p.set ?? null } : {}) });
}

export function useLabUrl() {
  useEffect(() => {
    go(placeOf(window.location.search));
    let last = searchOf(now());
    let lastMain = searchOf({ ...now(), moment: null });
    const write = () => {
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
      go(placeOf(window.location.search));
      last = searchOf(now());
      lastMain = searchOf({ ...now(), moment: null });
    };
    window.addEventListener("popstate", back);
    return () => {
      off();
      window.removeEventListener("popstate", back);
    };
  }, []);
}
