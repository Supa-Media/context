/**
 * The Lab's place as an address (`useLabUrl.web.ts`): Lab, Replay or Testing, the Lab's page and the node selected on
 * its canvas (a cell's "Node settings" link in Testing), in Replay the chat and the moment, and in Testing the
 * conversation. Pure, so the gateway's `tex_dev link` writes the same address the Lab reads (`engine/replayEntry.ts`).
 */
import type { View } from "../types";

const VIEWS: View[] = ["canvas", "modules", "convo", "tools", "sim", "tests", "run", "compare"];
export type Place = { mode: "lab" | "replay" | "testing"; view: View; chat: string; moment: string | null; node?: string | null; set?: string | null };

const CHAT = /^[A-Za-z0-9_-]{1,80}$/;
const MOMENT = /^[A-Za-z0-9_.:-]{1,120}$/;

export function placeOf(search: string): Place {
  const q = new URLSearchParams(search);
  const m = q.get("mode");
  const mode = m === "replay" ? "replay" : m === "testing" ? "testing" : "lab";
  const page = q.get("page") === "convo" ? "modules" : (q.get("page") ?? "");
  const view = (VIEWS as string[]).includes(page) ? (page as View) : "canvas";
  const chat = q.get("chat") ?? "";
  const moment = q.get("moment") ?? "";
  const node = q.get("node") ?? "";
  const set = q.get("conv") ?? "";
  return {
    mode,
    view: mode === "lab" ? view : "canvas",
    chat: CHAT.test(chat) ? chat : "me",
    moment: MOMENT.test(moment) ? moment : null,
    ...(mode === "lab" && CHAT.test(node) ? { node } : {}),
    ...(mode === "testing" && CHAT.test(set) ? { set } : {}),
  };
}

export function searchOf(p: Place): string {
  const q = new URLSearchParams();
  if (p.mode === "replay") {
    q.set("mode", "replay");
    if (p.chat !== "me") q.set("chat", p.chat);
    if (p.moment) q.set("moment", p.moment);
  } else if (p.mode === "testing") {
    q.set("mode", "testing");
    if (p.set) q.set("conv", p.set);
  } else {
    if (p.view !== "canvas") q.set("page", p.view);
    if (p.node) q.set("node", p.node);
  }
  const s = q.toString();
  return s ? "?" + s : "";
}
