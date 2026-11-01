/**
 * Past Google's passkey step by itself (a tester's chat, 2026-11-01).
 *
 * Passkeys are off in this browser (./passkeys.ts), so Google's passkey step
 * fails over at once instead of waiting on a window nobody sees. That was not
 * enough: a job signing in to a site with "Continue with Google" stopped on
 * that step, pressed around it, started the sign-in again twice, and said
 * there was "no other route". The browser was already signed in to Google;
 * this was Google checking it was really them before handing the site their
 * account, and the step that check opens on is the passkey one. "Try another
 * way" was on the page, and nothing on record says it was ever pressed.
 *
 * So after the steps, the browser does what anyone at that page would: it
 * presses "Try another way", and on the list Google then shows, it picks
 * "Enter your password" when it is there, which the saved login fills next.
 * Without one, the list is what the assistant reads: a code by text, or a
 * "tap Yes" prompt Google sends to the person's own phone, which (unlike a
 * passkey request from this browser) does reach them.
 *
 * And it logs which step Google stopped on and which kinds of way it offered,
 * by kind only: an option's own words carry the end of a phone number.
 */

import type { AttachedPage } from "./cdp";
import { PASSKEY_STEP_SOURCE } from "./passkeys";

/** The ways Google offers, by kind; anything else is "other". */
export type WayKind = "password" | "code" | "phone_prompt" | "passkey" | "authenticator" | "backup_code" | "help" | "other";

/** Which Google sign-in step a page is, by its address; null when it is not one. */
export type GoogleStep = "passkey" | "options" | "password" | "code" | "phone_prompt" | "other";

/** How long a press on Google's sign-in is given to load what comes next. */
const SETTLE_MS = 8_000;

/** The kinds of way, from an option's words. Run in the page and in tests. */
const WAY_KINDS = String.raw`[
  ["password", /\b(?:enter|type) your password\b/i],
  ["phone_prompt", /\btap yes\b|\byes on your (?:phone|tablet)\b|\bcheck your (?:phone|tablet)\b/i],
  ["authenticator", /\bauthenticator\b/i],
  ["backup_code", /\bbackup codes?\b/i],
  ["passkey", /\bpasskey\b|\buse another phone or computer\b|\bsecurity key\b/i],
  ["code", /\bverification code\b|\bsecurity code\b|\btext message\b|\bget a code\b/i],
  ["help", /\bget help\b|\btry another way\b|\bmore ways\b/i]
]`;

/** Where the page is in Google's sign-in, and the kinds of way it lists. */
export const GOOGLE_STEP_SOURCE = `(() => {
  try {
    if (location.hostname !== "accounts.google.com") return null;
    const kinds = ${WAY_KINDS};
    const words = (document.body && document.body.innerText) || "";
    const path = location.pathname;
    const passkey = ${PASSKEY_STEP_SOURCE};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ways = [];
    for (const el of document.querySelectorAll("[data-challengetype], [role=link], li")) {
      if (!visible(el)) continue;
      const said = (el.innerText || "").split("\\n")[0].trim();
      if (!said || said.length > 160) continue;
      const kind = (kinds.find(([, re]) => re.test(said)) || ["other"])[0];
      if (!ways.includes(kind)) ways.push(kind);
    }
    const step = passkey ? "passkey"
      : /\\/challenge\\/selection\\b/i.test(path) || /choose how you want to sign in/i.test(words) ? "options"
      : /\\/challenge\\/pwd\\b/i.test(path) ? "password"
      : /\\/challenge\\/(?:ipp|sk|iap)\\b/i.test(path) ? "code"
      : /\\/challenge\\/(?:dp|az)\\b/i.test(path) ? "phone_prompt"
      : /\\/challenge\\//i.test(path) ? "other" : null;
    return step === null ? null : { step, ways: step === "options" ? ways : [] };
  } catch { return null; }
})()`;

/**
 * The centre of the first visible thing on the page whose own words match
 * `pattern`, clickable or inside something that is; null when there is none.
 */
export function findPressSource(pattern: string): string {
  return `(() => {
  try {
    const re = new RegExp(${JSON.stringify(pattern)}, "i");
    const all = document.querySelectorAll("button, a, [role=button], [role=link], [data-challengetype], li");
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const said = (el.innerText || el.getAttribute("aria-label") || "").split("\\n")[0].trim();
      if (!re.test(said)) continue;
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  } catch { return null; }
})()`;
}

/** "Try another way", and the other names Google has given it. */
export const ANOTHER_WAY = String.raw`^(?:try another way|use another method|try another method|more ways to (?:sign in|verify))$`;
/** The password way on Google's list. */
export const PASSWORD_WAY = String.raw`^(?:enter|type) your password\b`;

export type GoogleDetour = { before: GoogleStep; after: GoogleStep | null; ways: WayKind[]; pressed: Array<"another_way" | "password"> };

async function press(page: AttachedPage, pattern: string): Promise<boolean> {
  const at = await page.evaluate<{ x: number; y: number } | null>(findPressSource(pattern)).catch(() => null);
  if (!at) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
  await page.settle(SETTLE_MS);
  return true;
}

const where = (page: AttachedPage) =>
  page.evaluate<{ step: GoogleStep; ways: WayKind[] } | null>(GOOGLE_STEP_SOURCE).catch(() => null);

/**
 * On Google's passkey step, press "Try another way", and on the list, the
 * password way when there is one. Answers what it found and did, or null
 * when the page is not Google's sign-in; logs the same, by kind only.
 */
export async function pastGooglePasskey(page: AttachedPage): Promise<GoogleDetour | null> {
  const first = await where(page);
  if (first === null) return null;
  const detour: GoogleDetour = { before: first.step, after: first.step, ways: first.ways, pressed: [] };
  let now = first;
  if (now.step === "passkey" && (await press(page, ANOTHER_WAY))) {
    detour.pressed.push("another_way");
    now = (await where(page)) ?? { step: "other", ways: [] };
  }
  if (now.step === "options") {
    detour.ways = now.ways;
    // Only on a list this call opened: a list Tex came back to is its own
    // pick (a code when no password is saved), never pressed for it.
    if (detour.pressed.length > 0 && now.ways.includes("password") && (await press(page, PASSWORD_WAY))) {
      detour.pressed.push("password");
      now = (await where(page)) ?? { step: "other", ways: [] };
    }
  }
  detour.after = now.step;
  console.log(JSON.stringify({ event: "site_shots_google_step", ...detour }));
  return detour;
}
