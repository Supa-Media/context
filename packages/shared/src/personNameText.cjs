/**
 * A chat member's name as the group turn is told it (`groupNames.js`): letters and marks on one short line, so a name
 * cannot carry an instruction. The gateway's contacts page cleans names the same way.
 */

const MAX_NAME = 80;
/** A name as told to the turn: letters, marks, spaces, apostrophes, hyphens and periods, one line. */
function cleanName(name) {
  if (typeof name !== "string") return "";
  return name
    .replace(/[^\p{L}\p{M}\s'’.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

module.exports = { cleanName };
