/**
 * The Lab's place as an address (`useLabUrl.web.ts`): Lab or Replay, the Lab's page, and in Replay the chat and the
 * moment. Pure, so the gateway's `tex_dev link` writes the same address the Lab reads (`engine/replayEntry.ts`).
 */
import type { View } from "../types";

const VIEWS: View[] = ["canvas", "modules", "convo", "tools", "sim", "tests", "run", "compare"];
export type Place = { mode: "lab" | "replay"; view: View; chat: string; moment: string | null };

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
