/**
 * The Lab's place as an address (`useLabUrl.web.ts`): Lab or Testing, the Lab's page and the node selected on its
 * canvas (a cell's "Node settings" link in Testing), the chat and the text a link points at, and in Testing the
 * conversation. Replay is not a mode any more (Lab live sandbox, Dev2 2026-11-16): an old `?mode=replay` address opens
 * the Lab, at the same chat and text. Pure, so the gateway's `tex_dev link` writes the same address the Lab reads (`engine/replayEntry.ts`).
 */
import type { View } from "../types";

const VIEWS: View[] = ["canvas", "modules", "convo", "tools", "sim", "tests", "run", "compare", "evals"];
export type Place = { mode: "lab" | "testing"; view: View; chat: string; moment: string | null; node?: string | null; set?: string | null };

const CHAT = /^[A-Za-z0-9_-]{1,80}$/;
const MOMENT = /^[A-Za-z0-9_.:-]{1,120}$/;

export function placeOf(search: string): Place {
  const q = new URLSearchParams(search);
  const m = q.get("mode");
  // Replay became part of the Lab: `?mode=replay` is the Lab, with its chat and moment kept.
  const mode = m === "testing" ? "testing" : "lab";
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
    moment: mode === "lab" && MOMENT.test(moment) ? moment : null,
    ...(mode === "lab" && CHAT.test(node) ? { node } : {}),
    ...(mode === "testing" && CHAT.test(set) ? { set } : {}),
  };
}

export function searchOf(p: Place): string {
  const q = new URLSearchParams();
  if (p.mode === "testing") {
    q.set("mode", "testing");
    if (p.set) q.set("conv", p.set);
  } else {
    if (p.view !== "canvas") q.set("page", p.view);
    if (p.node) q.set("node", p.node);
    if (p.chat !== "me") q.set("chat", p.chat);
    if (p.moment) q.set("moment", p.moment);
  }
  const s = q.toString();
  return s ? "?" + s : "";
}
