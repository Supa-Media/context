/**
 * What the two data cards say when they come back from a phone
 * (`infra/router/src/messagesData.ts`), in words the person could have typed:
 *
 * - `/tex/inbox?m=<address>/<id>&m=…`, the emails they handed Tex, as
 *   "Please take care of these emails: email:<address>/<id>, …", ids Tex
 *   fetches like any other.
 * - `/tex/times?d=<minutes>&z=<zone>&s=<instant>&s=…`, the free times they
 *   picked, written out on their own clock.
 *
 * The card is untrusted input, as every card is: anything malformed is
 * dropped, and a card naming nothing is not a card (null).
 */

const MAX_EMAILS = 10;
const MAX_TIMES = 5;
const MAILBOX_ID = /^[^\s@/]{1,64}@[^\s/]{1,255}\/[A-Za-z0-9_-]{1,64}$/;

/** The words a data card stands for; null for any other card or one naming nothing. */
export function dataCardText(url: URL): string | null {
  if (url.pathname === "/tex/inbox") {
    const emails = [...new Set(url.searchParams.getAll("m").filter((m) => MAILBOX_ID.test(m)))].slice(0, MAX_EMAILS);
    return emails.length === 0 ? null : `Please take care of these emails: ${emails.map((m) => `email:${m}`).join(", ")}`;
  }
  if (url.pathname === "/tex/times") {
    const zone = knownZone(url.searchParams.get("z")) ?? "UTC";
    const minutes = Number(url.searchParams.get("d"));
    const times = [...new Set(url.searchParams.getAll("s").map((at) => Date.parse(at)).filter(Number.isFinite))].sort((a, b) => a - b).slice(0, MAX_TIMES);
    if (times.length === 0) return null;
    const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const length = Number.isInteger(minutes) && minutes >= 15 && minutes <= 240 ? ` (${minutes} min each)` : "";
    return `These times work for me${length}: ${times.map((at) => format.format(at)).join("; ")} (${zone})`;
  }
  return null;
}

/** An IANA zone this runtime knows, or null. */
function knownZone(value: string | null): string | null {
  if (value === null || value.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
