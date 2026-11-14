/**
 * The Lab's place in the address bar (Dev2, 2026-11-14: "please make sure we are tracking state in the url so that when
 * we refresh the page or try to go back it doesnt just take us to the lab homepage"): Lab or Replay, the Lab's page,
 * and in Replay the chat and the moment. A refresh opens where it was; Back and Forward step through pages, modes and
 * chats. Picking another moment replaces the entry rather than adding one, so Back is not a walk through every text.
 */
import { useEffect } from "react";
import { lab, set, subscribe } from "../engine/state";
import type { View } from "../types";
import { pickChat } from "./mine/useMine";

const VIEWS: View[] = ["canvas", "modules", "convo", "tools", "sim", "tests", "run", "compare"];
type Place = { mode: "lab" | "replay"; view: View; chat: string; moment: string | null };

const CHAT = /^[A-Za-z0-9_-]{1,80}$/;
const MOMENT = /^[A-Za-z0-9_.:-]{1,120}$/;

export function placeOf(search: string): Place {
  const q = new URLSearchParams(search);
  const mode = q.get("mode") === "replay" ? "replay" : "lab";
  const view = (VIEWS as string[]).includes(q.get("page") ?? "") ? (q.get("page") as View) : "canvas";
  const chat = q.get("chat") ?? "";
  const moment = q.get("moment") ?? "";
  return { mode, view: mode === "replay" ? "canvas" : view, chat: CHAT.test(chat) ? chat : "me", moment: MOMENT.test(moment) ? moment : null };
}

export function searchOf(p: Place): string {
  const q = new URLSearchParams();
  if (p.mode === "replay") {
    q.set("mode", "replay");
    if (p.chat !== "me") q.set("chat", p.chat);
    if (p.moment) q.set("moment", p.moment);
  } else if (p.view !== "canvas") q.set("page", p.view);
  const s = q.toString();
  return s ? "?" + s : "";
}

const now = (): Place => ({ mode: lab.mode, view: lab.view, chat: lab.myChat, moment: lab.mode === "replay" ? lab.moment : null });

/** Put the Lab where an address says. */
function go(p: Place) {
  if (p.chat !== lab.myChat) {
    if (Array.isArray(lab.myTexts)) pickChat(p.chat);
    else lab.myChat = p.chat; // not read yet: the first read is this chat's
  }
  set({ mode: p.mode, view: p.view, sel: null, cfocus: null, ...(p.mode === "lab" ? { real: null } : {}), ...(p.moment ? { moment: p.moment } : {}) });
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
