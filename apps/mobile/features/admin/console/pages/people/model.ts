/**
 * People's model: the console's queries turned into the artifact's row model (`everyone()` in
 * `staff-console.html`). Pure, so the page and its test read one definition.
 *
 * A row is an account (`acct`, or `archived`), a waitlist row (`wl`: waiting, let in or removed) or
 * a referral invite that has not joined (`inv`). `st` is the artifact's status key.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { handleLine } from "../../kit";
import type { TexChange } from "../../../texAllowlist";
import { shortDay } from "../dates";

export type From = "waitlist" | "friend" | "ad" | "staff" | "direct";
export type Role = "owner" | "editor" | "member";

/** One account, as the People page shows it: `accountsPage` plus its usage (`peopleUsage`). */
export type Person = {
  userId: Id<"users">;
  name: string | null;
  handle: string | null;
  emails: string[];
  phone: string | null;
  textingPhones: string[];
  joinedAt: number;
  archived: boolean;
  /** The newest use of any of this person's grants, active or revoked. */
  lastSeenAt: number | null;
  from: From;
  /** The inviter's handle, when `from` is `friend`. */
  invitedBy: string | null;
  workspaces: Array<{ slug: string; kind: "personal" | "shared"; role: Role }>;
  /** Active grants only, newest use first. */
  clients: Array<{ name: string; lastUsedAt: number | null }>;
  aiUsd: number;
  aiByFeature: Array<{ label: string; usd: number }>;
};

/** A waitlist row (`waitlistPage`). `email` and `phone` are the address it was joined with, when it has one. */
export type WaitRow = {
  id: Id<"waitlist">;
  who: string;
  email: string | null;
  phone: string | null;
  status: "waiting" | "admitted" | "removed";
  joinedAt: number;
  from: "waitlist" | "ad" | "staff";
  campaign: string | null;
  useFor: string | null;
  /** False only for a let-in phone row that nobody has been texted about. */
  told: boolean;
};

/** A referral invite that has not joined (`invitesPage`, joined ones left out). */
export type InviteRow = {
  id: Id<"referralInvites">;
  to: string;
  inviterHandle: string | null;
  sentAt: number;
  status: "pending" | "expired" | "cancelled" | "revoked";
};

/** The list the People page draws, assembled by `useEveryone` in `People.web.tsx`. */
export type ConsolePeople = {
  accounts: Person[];
  waitlist: WaitRow[];
  invites: InviteRow[];
  invitesOff: boolean;
  truncated: boolean;
};

export type TexLine = Awaited<FunctionReturnType<typeof api.functions.admin.texAllowlist>>;
export type AiAccount = Awaited<FunctionReturnType<typeof api.functions.admin.aiCostsAccount>>;
export type WaitId = WaitRow["id"];
export type PersonId = Person["userId"];
export type InviteId = InviteRow["id"];

export type Status = "acct" | "waiting" | "in" | "invited" | "removed" | "archived";
export type Kind = "acct" | "wl" | "inv";

export type Row = {
  id: string;
  k: Kind;
  st: Status;
  /** The name, or the handle, email or phone when a person has no name. */
  name: string;
  /** Under the name: @handle, else email, else phone. Empty for waitlist and invite rows. */
  sub: string;
  when: string;
  /** Came-from label: Waitlist, Friend, Ad, Staff or Direct. */
  from: string;
  /** The inviter's handle, when this row came by a friend's invite. */
  by: string | null;
  /** The answer to the waitlist question. */
  why: string | null;
  told: boolean;
  invStatus: InviteRow["status"] | null;
  p: Person | null;
};

/** The page's URL filters (`S.f`): the keys this page owns, at least. */
export type Filters = Record<string, string>;

export type PhoneResult = { status: "saved" | "removed" | "invalid" | "taken" | "not_found"; phone?: string; heldBy?: string };

export type PeopleMutations = {
  admit(a: { ids: WaitId[] }): Promise<{ changed: number }>;
  remove(a: { ids: WaitId[] }): Promise<{ changed: number }>;
  restore(a: { ids: WaitId[] }): Promise<{ changed: number }>;
  tell(a: { ids: WaitId[] }): Promise<{ texted: number; left: number }>;
  addToWaitlist(a: { emails: string }): Promise<{ changed: number; invalid: string[] }>;
  setPhone(a: { userId: PersonId; phone: string | null }): Promise<PhoneResult>;
  setArchived(a: { userId: PersonId; archived: boolean }): Promise<{ status: string }>;
  revoke(a: { inviteId: InviteId }): Promise<{ changed: boolean }>;
  setInvitesOff(a: { off: boolean }): Promise<unknown>;
  closeInbox(a: { userId: PersonId }): Promise<{ changed: boolean }>;
  changeTex(a: { phone: string; change: "add" | "remove" }): Promise<TexChange>;
  /** Reads Tex's list again and returns it, so an act can work from what is there now. */
  texRefresh(): Promise<TexLine>;
};

/** What `useData` hands the page. `people` is undefined while the first query loads. */
export type PeopleData = {
  people: ConsolePeople | undefined;
  mailOpen: ReadonlySet<string>;
  tex: TexLine | undefined;
  acct: AiAccount | null | undefined;
  m: PeopleMutations;
};

/** The data once it has loaded, for the acts that need it. */
export type ReadyPeopleData = PeopleData & { people: ConsolePeople };

export const STATUS: Record<Status, [string, string]> = {
  acct: ["Signed up", "ok"],
  waiting: ["Waiting", "acc"],
  in: ["Let in", "team"],
  invited: ["Invited", ""],
  removed: ["Removed", ""],
  archived: ["Archived", ""],
};

export const INVITE_TEXT: Record<InviteRow["status"], string> = {
  pending: "Not used yet",
  expired: "Expired",
  cancelled: "Cancelled",
  revoked: "Revoked",
};

export const FROM_LABEL: Record<Person["from"] | WaitRow["from"], string> = {
  waitlist: "Waitlist",
  friend: "Friend",
  ad: "Ad",
  staff: "Staff",
  direct: "Direct",
};

/** The side panel's words for how someone came in. */
export const CAME_LABEL: Record<Person["from"], string> = {
  waitlist: "Waitlist",
  friend: "Friend",
  ad: "An ad",
  staff: "Added by staff",
  direct: "Direct",
};

export const ROLE_LABEL: Record<Person["workspaces"][number]["role"], string> = {
  owner: "Owner",
  editor: "Can edit",
  member: "Can read",
};

const WAIT_STATUS: Record<WaitRow["status"], Status> = { waiting: "waiting", admitted: "in", removed: "removed" };

/** The artifact's date: month and day, as "Nov 12", in local time (`dates.ts`). */
export const fmtDate = (ms: number): string => shortDay(ms);

/** "2h ago", "30m ago", "3d ago"; "just now" under a minute. */
export function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Name, else @handle, else email, else phone. A blank name counts as no name. */
export function displayName(p: Person): string {
  return p.name?.trim() || handleLine({ handle: p.handle, email: p.emails[0] ?? null, phone: p.phone });
}

export function rowsOf(people: ConsolePeople): Row[] {
  const out: Row[] = [];
  for (const p of people.accounts) {
    out.push({
      id: p.userId,
      k: "acct",
      st: p.archived ? "archived" : "acct",
      name: displayName(p),
      sub: p.name?.trim() ? handleLine({ handle: p.handle, email: p.emails[0] ?? null, phone: p.phone }) : "",
      when: fmtDate(p.joinedAt),
      from: FROM_LABEL[p.from],
      by: p.invitedBy,
      why: null,
      told: true,
      invStatus: null,
      p,
    });
  }
  for (const w of people.waitlist) {
    out.push({
      id: w.id,
      k: "wl",
      st: WAIT_STATUS[w.status],
      name: w.who,
      sub: "",
      when: fmtDate(w.joinedAt),
      from: FROM_LABEL[w.from],
      by: null,
      why: w.useFor,
      told: w.told,
      invStatus: null,
      p: null,
    });
  }
  for (const i of people.invites) {
    out.push({
      id: i.id,
      k: "inv",
      st: "invited",
      name: i.to,
      sub: "",
      when: fmtDate(i.sentAt),
      from: "Friend",
      by: i.inviterHandle,
      why: null,
      told: true,
      invStatus: i.status,
      p: null,
    });
  }
  return out;
}

/** A row the bulk bar can act on: waiting, removed, or let in but not yet texted. */
export const pickable = (r: Row): boolean => r.st === "waiting" || r.st === "removed" || (r.st === "in" && !r.told);

export function searchText(r: Row): string {
  return [r.name, r.sub, r.why ?? "", r.p ? [r.p.handle, r.p.phone].join(" ") : ""].join(" ").toLowerCase();
}

/** The artifact's filters, in its order: status, came from, answered, never told, then the search words. */
export function visibleRows(all: Row[], f: Filters, q: string): Row[] {
  const ql = q.toLowerCase();
  return all
    .filter((r) => (f.ps === "all" ? r.st !== "removed" && r.st !== "archived" : r.st === f.ps))
    .filter((r) => f.cf === "all" || r.from === f.cf)
    .filter((r) => f.ans !== "1" || Boolean(r.why))
    .filter((r) => f.told !== "no" || (r.st === "in" && !r.told))
    .filter((r) => !ql || searchText(r).includes(ql));
}

/** Tex access, read from Linq's list: what the switches can do and what the list holds. */
export type TexView =
  | { state: "loading" }
  | { state: "not_connected" }
  | { state: "error"; error: string }
  | { state: "unlimited" }
  | {
      state: "shared";
      cap: number;
      used: number;
      full: boolean;
      listed: ReadonlySet<string>;
      /** Numbers on the list that are nobody's account. */
      unowned: string[];
    };

export function texView(line: TexLine | undefined): TexView {
  if (line === undefined) return { state: "loading" };
  switch (line.state) {
    case "not_connected":
      return { state: "not_connected" };
    case "error":
      return { state: "error", error: line.error };
    case "unlimited":
      return { state: "unlimited" };
    case "shared": {
      const listed = new Set(line.contacts.map((c) => c.phone));
      return {
        state: "shared",
        cap: line.cap,
        used: line.contacts.length,
        full: line.contacts.length >= line.cap,
        listed,
        unowned: line.contacts.filter((c) => c.person === null).map((c) => c.phone),
      };
    }
  }
}

/** Whether a number is on Tex's list. */
export function listedOn(tv: TexView, phone: string | null): boolean {
  return tv.state === "shared" && phone !== null && tv.listed.has(phone);
}

/** Whether a person can text Tex: their phone or a texting phone is on the list (anyone with a phone, when unlimited). */
export function texOn(p: Person, tv: TexView): boolean {
  if (tv.state === "unlimited") return p.phone !== null;
  if (tv.state !== "shared") return false;
  return [p.phone, ...p.textingPhones].some((n) => n !== null && tv.listed.has(n));
}

/** The artifact's status counts for the status select. */
export function countOf(all: Row[], k: string): number {
  return k === "all" ? all.filter((r) => r.st !== "removed" && r.st !== "archived").length : all.filter((r) => r.st === k).length;
}

/** What a failed write says: the server's message when it has one. */
export function failureText(error: unknown, fallback = "That did not work. Try again."): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}
