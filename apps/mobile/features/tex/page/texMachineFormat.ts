/**
 * The words the machine screens say, as pure functions so every state is
 * checked without drawing anything. Each string is the design spec's
 * (`tex-machines-artboards/design-spec.md`), audited 2026-11-03: "Coding
 * tools", never "agents"; "Tex's cloud", never "Cloud"; no time zone on a
 * time, because the page is the person's own and already in their zone.
 */

import type { Machine, MachineChat, MachinesPage, MachineState, MachineWho, Pairing, SlotPlace, ToolName, ToolState } from "./texMachineTypes";

/** `9:40 AM`. */
export function at12(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** `Oct 28`. */
export function dateOf(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `1h 40m`, `20m`, `4h`, `0m`. */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** `4 hours`, `1 hour`, `30 minutes`: a daily limit as its select shows it. */
export function hoursWord(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  const h = minutes / 60;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** The daily limit's choices, in minutes, with the machine's own value kept if it is not one of them. */
export function limitChoices(current: number): number[] {
  const base = [60, 120, 240, 360, 480, 720];
  return base.includes(current) || current <= 0 ? base : [...base, current].sort((a, b) => a - b);
}

export const OTHERS_PER_DAY = [0, 1, 3, 5, 10, 20] as const;

export const TOOL_LABEL: Record<ToolName, string> = { claude: "Claude Code", codex: "Codex" };

/** "Mac app" or the OS: how the machine is connected, the way its row names it. */
export function viaOf(m: Pick<Machine, "kind" | "os">): string {
  return m.kind === "mac" ? "Mac app" : m.os || "Command line";
}

/** "this Mac" or "this computer". */
export function hereOf(m: Pick<Machine, "kind" | "os">): string {
  return m.kind === "mac" || m.os === "macOS" ? "this Mac" : "this computer";
}

export type DotTone = "ok" | "warn" | "off";

export function dotOf(state: MachineState): DotTone {
  if (state === "online") return "ok";
  if (state === "offline") return "off";
  return "warn";
}

/** The machines page row's sub-line (screens 1 and 8). */
export function rowLine(m: Machine): string {
  switch (m.state) {
    case "online":
      return `Online · ${viaOf(m)} · ${hm(m.usedMin)} of ${hm(m.limitMin + (m.raisedMin ?? 0))} today`;
    case "paused":
      return m.paused === "plan" ? "Plan limit close · new jobs go to Tex's cloud" : "Daily limit reached · back at midnight";
    case "notReady":
      return "Not ready · no coding tool signed in";
    case "offline":
      return [m.since ? `Offline since ${at12(m.since)}` : "Offline", m.os || null].filter(Boolean).join(" · ");
    case "pending":
      return m.since ? `Wants to connect · asked ${at12(m.since)}` : "Wants to connect";
  }
}

/** The words beside the pips on a row: `1 of 4 busy`, `2 free`, `Paused`, `Offline`, `Not ready`. */
export function rowRight(m: Machine): string {
  switch (m.state) {
    case "online": {
      const busy = m.running.length;
      return busy === 0 ? `${m.slots} free` : `${busy} of ${m.slots} busy`;
    }
    case "paused":
      return "Paused";
    case "offline":
      return "Offline";
    case "notReady":
      return "Not ready";
    case "pending":
      return "Review";
  }
}

/** Every slot the person has: Tex's cloud plus each machine that is connected. */
export function totalSlots(page: MachinesPage): number {
  return page.cloud.slots + page.machines.filter((m) => m.state !== "pending").reduce((n, m) => n + m.slots, 0);
}

/** The foot line under the machines page. */
export function poolFoot(page: MachinesPage): string {
  const usable = page.machines.filter((m) => m.state === "online");
  const connected = page.machines.filter((m) => m.state !== "pending");
  if (connected.length > 0 && usable.length === 0) {
    return "None of your machines can take a job right now, so coding jobs go to Tex's cloud.";
  }
  return `${totalSlots(page)} slots in all. Coding jobs go to a free slot on your machines first; when they are busy or off, Tex uses the cloud.`;
}

/** The machine page's status line under its title (screens 2, 9 and 10). */
export function detailStatus(m: Machine, now: number = Date.now()): string {
  const via = viaOf(m);
  switch (m.state) {
    case "online":
      return [`Online`, via, m.connectedAt ? `connected ${dateOf(m.connectedAt)}` : null].filter(Boolean).join(" · ");
    case "paused":
      return m.paused === "plan" ? `Paused · plan limit close · ${via}` : `Paused · daily limit reached · ${via}`;
    case "notReady":
      return [`Not ready`, via, m.connectedAt ? `connected ${justNow(m.connectedAt, now)}` : null].filter(Boolean).join(" · ");
    case "offline":
      return [m.since ? `Offline since ${at12(m.since)}` : "Offline", via].join(" · ");
    case "pending":
      return "Waiting for you to approve";
  }
}

function justNow(at: number, now: number): string {
  return now - at < 5 * 60_000 ? "just now" : dateOf(at);
}

/** The Jobs at once row's line: `Recommended 4 for this Mac · up to 8 if it only runs Tex`. */
export function slotsLine(m: Machine): string {
  if (m.state === "notReady") return "Starts after you sign in";
  return `Recommended ${m.recommended} for ${hereOf(m)} · up to ${m.most} if it only runs Tex`;
}

/** A coding tool's line on the machine page. */
export function toolLine(state: ToolState, m: Pick<Machine, "kind" | "os">): string {
  const here = hereOf(m);
  switch (state) {
    case "signedIn":
    case "off":
      return `Signed in on ${here}`;
    case "installed":
      return "Installed, not signed in";
    case "missing":
      return `Not found on ${here}`;
  }
}

/** Who besides the owner can send a machine work, as the group select's value says it. */
export function whoLabel(who: MachineWho): string {
  if (who === "me") return "Only you";
  if (who === "everyone") return "Everyone here";
  return who.join(", ");
}

/** A chat's line in the machine page's Shared with: `All 4 slots`, `Up to 2 slots · Bola can send it work · Ask me first`. */
export function sharedLine(c: MachineChat, m: Machine): string {
  if (c.key === "me") return `All ${m.slots} slots`;
  const parts = [`Up to ${c.slots} slot${c.slots === 1 ? "" : "s"}`];
  if (c.who === "everyone") parts.push("Everyone can send it work");
  else if (c.who !== "me") parts.push(`${c.who.join(", ")} can send it work`);
  if (c.who !== "me" && c.askFirst) parts.push("Ask me first");
  return parts.join(" · ");
}

/** The Running now row's line, or the line when nothing runs. */
export function runningLine(m: Machine, now: number = Date.now()): string {
  const run = m.running[0];
  if (!run) return m.lastEndedAt ? `Nothing. The last job finished at ${at12(m.lastEndedAt)}` : "Nothing right now";
  const mins = Math.max(1, Math.round((now - run.startedAt) / 60_000));
  const more = m.running.length > 1 ? ` · and ${m.running.length - 1} more` : "";
  return [run.title, run.for ? `for ${run.for}` : null, `${mins} min`].filter(Boolean).join(" · ") + more;
}

/** The pairing card's facts: `Linux · Claude Code and Codex signed in · asked 2:14 PM`. */
export function pairingFacts(p: Pairing): string {
  const tools = p.tools.map((t) => TOOL_LABEL[t]);
  const signed = tools.length === 0 ? "no coding tool signed in" : `${tools.join(" and ")} signed in`;
  return [p.os || null, signed, p.at ? `asked ${at12(p.at)}` : null].filter(Boolean).join(" · ");
}

/** A place's header on the Tex home's minion pool: `Tex's cloud · 3`, and on the right how many are busy. */
export function placeHead(p: SlotPlace): string {
  return `${p.name} · ${p.slots}`;
}

/** `Minions 2–4` for a run of free slots, `Minion 3` for one. */
export function freeRange(first: number, last: number): string {
  return first === last ? `Minion ${first}` : `Minions ${first}–${last}`;
}

/** The Ask me first line for the owner's card (screen 5): `Claude Code in ~/code/context · uses 1 of the 2 slots for this chat · asked 2:31 PM`. */
export function askFacts(a: { tool: ToolName; folder?: string; slotsFor: number; at: number }): string {
  return [
    a.folder ? `${TOOL_LABEL[a.tool]} in ${a.folder}` : TOOL_LABEL[a.tool],
    a.slotsFor > 0 ? `uses 1 of the ${a.slotsFor} slot${a.slotsFor === 1 ? "" : "s"} for this chat` : null,
    a.at ? `asked ${at12(a.at)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Why a folder typed on the page can't be kept, or null when it can. The same rule as the workspace object's
 * `foldersOf` (`apps/mcp/src/workspaceStore/machines.js`), which drops a bad one without a word, so the page says so first.
 */
export function folderProblem(folder: string): string | null {
  if (folder.startsWith("~")) return `Write the full path, like ${folderExample("cli")}, not ${folder}`;
  const absolute = folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder);
  if (!absolute) return `Write the full path, starting with /: ${folder}`;
  if (folder.length > 1024 || folder.includes("\0")) return `That path is too long: ${folder.slice(0, 40)}…`;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(folder)) return `A path can't climb up with ..: ${folder}`;
  if (/^(\/|[A-Za-z]:[\\/]?|\/home\/[^/]+\/?|\/Users\/[^/]+\/?|\/root\/?)$/.test(folder)) return `Pick a folder inside your home folder, not all of it: ${folder}`;
  return null;
}

/** A full path to show as the folder box's example, for the kind of computer it is. */
export function folderExample(kind: "mac" | "cli"): string {
  return kind === "mac" ? "/Users/you/code" : "/home/you/code";
}
