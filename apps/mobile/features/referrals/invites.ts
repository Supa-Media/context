/**
 * What the Invite friends dialog says about each invite, and about the person
 * sending them. Pure, so every sentence is a test rather than a judgement made
 * in a component. The rules behind the statuses are the server's
 * (`apps/convex/functions/lib/referrals.ts`); this only words them.
 */

export type InviteStatus = "pending" | "joined" | "expired" | "cancelled" | "revoked";

export interface InviteRow {
  id: string;
  email: string;
  status: InviteStatus;
  sentAt: number;
  expiresAt: number;
  cancelledAt: number | null;
  joinedHandle: string | null;
}

export interface MyInvites {
  off: boolean;
  locked: "setup" | "new" | null;
  unlocksAt: number | null;
  total: number;
  left: number;
  invites: InviteRow[];
}

export type Tone = "positive" | "attention" | "neutral" | "negative";

/** "Oct 13", in the reader's own time zone. */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The pill and the line under an address in the list. */
export function describeInvite(row: InviteRow): { pill: string; tone: Tone; sub: string } {
  switch (row.status) {
    case "pending":
      return { pill: "Waiting", tone: "attention", sub: `Sent ${shortDate(row.sentAt)} · expires ${shortDate(row.expiresAt)}` };
    case "joined":
      return {
        pill: "Joined",
        tone: "positive",
        sub: row.joinedHandle === null ? "Joined" : `Joined as @${row.joinedHandle}`,
      };
    case "expired":
      return { pill: "Expired", tone: "neutral", sub: "Not used in time. Your invite is back." };
    case "cancelled":
      return { pill: "Cancelled", tone: "neutral", sub: "You cancelled it. Your invite is back." };
    case "revoked":
      return { pill: "Revoked", tone: "negative", sub: "Stopped by the Context team" };
  }
}

/** How many dots are filled: invites in use, out of the total. */
export function dots(mine: Pick<MyInvites, "total" | "left">): boolean[] {
  const used = mine.total - mine.left;
  return Array.from({ length: mine.total }, (_, index) => index < used);
}

/** The account menu's detail beside "Invite friends", or none. */
export function menuDetail(mine: MyInvites | null | undefined): string | undefined {
  if (mine === null || mine === undefined || mine.off || mine.locked !== null) return undefined;
  return `${mine.left} left`;
}

/** What stops this person sending right now, as a sentence, or null. */
export function blocker(mine: MyInvites): string | null {
  if (mine.off) return "Invites are paused right now. Invites you already sent still work.";
  if (mine.locked === "setup") return `Connect Claude, ChatGPT or another AI tool to unlock your ${mine.total} invites.`;
  if (mine.locked === "new") {
    return mine.unlocksAt === null
      ? "Your invites unlock a week after you joined."
      : `Your invites unlock on ${shortDate(mine.unlocksAt)}, a week after you joined.`;
  }
  if (mine.left <= 0) return `You've used all ${mine.total} invites. We add more as the beta grows.`;
  return null;
}

/** The sentence for a refused send, by the server's error code. */
export function sendError(code: string | undefined): string {
  switch (code) {
    case "INVALID_EMAIL":
      return "Check the address and try again.";
    case "LIMIT_REACHED":
      return "You've used all your invites.";
    case "LOCKED":
      return "Finish setting up first.";
    case "INVITES_OFF":
      return "Invites are paused right now.";
    case "RATE_LIMITED":
      return "That's enough for today. You can send more tomorrow.";
    default:
      return "Couldn't send. Nothing was used. Try again.";
  }
}

/** Undo is offered for this long after a cancel; the server allows ten minutes. */
export const UNDO_SHOWN_MS = 60 * 1000;

/** The Discord join link among the community links, if staff set one. */
export function discordLink<T extends { kind: string; url: string }>(links: readonly T[] | undefined): T | null {
  return links?.find((link) => link.kind === "discord") ?? null;
}
