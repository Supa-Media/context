/**
 * How Tex writes a phone number and a line's archive day in a text: the old-number reply (gateway node `oldLine`)
 * and the bulk "Tex has a new number" notice (`apps/agent/src/newLine.ts`) word them the same way.
 */
"use strict";

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

module.exports = { formatNumber, archiveSentence };
