/**
 * How Tex writes a phone number and a line's archive day in a text: the old-number reply (gateway node `oldLine`)
 * and the bulk "Tex has a new number" notice (`packages/tex/worker/newLine.ts`) word them the same way.
 */
"use strict";

/**
 * Tex's number: the one line people are told to text, everywhere the app names it (Settings, the /tex pages, the
 * waitlist's "you're in", the staff console, the Lab's test chat). Photon's dedicated Business line since 2026-11-16
 * (docs/decisions/texting-assistant/photon-line.md). A public business line, not a secret. Moving Tex to a new line is
 * a change to this line alone; `TEX_LINE_NUMBERS` only lists the older lines Tex still answers on.
 */
const TEX_NUMBER = "+14157918922";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "+1 (415) 555-0100" for a US number; any other number as given. */
function formatNumber(number) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(number));
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : String(number);
}

/** " This number stops working on December 1." for a real `YYYY-MM-DD` day; "" when there is none or it is not a day. */
function archiveSentence(archiveOn) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof archiveOn === "string" ? archiveOn : "");
  if (m === null) return "";
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return ` This number stops working on ${MONTHS[month - 1]} ${day}.`;
}

module.exports = { TEX_NUMBER, formatNumber, archiveSentence };
