/**
 * `setNoteProperty`: the one-line frontmatter write behind editing a status or
 * an owner from a list. See `src/lists/setProperty.js`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/lists/setProperty.js`, and reverted.
 *
 * 1. **The read-back check removed** — 1 failed: an opening fence with a
 *    trailing space, which the reader does not take as frontmatter, was
 *    written as if it were.
 * 2. **`quoted` returning the value bare** — 3 failed: the leading quote,
 *    the boolean-looking word and the value holding both quotes.
 * 3. **Block-list continuation lines left in place** — 2 failed: the block
 *    list and the nested map.
 */

import { noteProperties, setNoteProperty } from "../src/lists.js";

export function runSetPropertyChecks(check) {
  const set = (text, key, value) => setNoteProperty(text, key, value);
  const note = "---\ntitle: Website\nstatus: planned # soon\nowner: Seyi\n---\n\n# Website\n\nstatus: not frontmatter\n";

  {
    const { text } = set(note, "status", "active");
    check("a property is changed on its own line", text === note.replace("status: planned # soon", "status: active"));
    check("…and reads back", noteProperties(text).status === "active");
  }
  check("a missing property is added as the frontmatter's last line", set(note, "due", "Oct 3").text === note.replace("owner: Seyi\n---", "owner: Seyi\ndue: Oct 3\n---"));
  check("null removes a property", set(note, "owner", null).text === note.replace("owner: Seyi\n", ""));
  check("removing one that is not there changes nothing", set(note, "due", null).text === note);
  check("the body is never read as frontmatter", set(note, "status", "done").text.endsWith("status: not frontmatter\n"));
  check("a note with no frontmatter gets one", set("# Hi\n\nText", "status", "active").text === "---\nstatus: active\n---\n\n# Hi\n\nText");
  check("an empty note gets one", set("", "status", "active").text === "---\nstatus: active\n---\n");
  check("an empty frontmatter gains the line", set("---\n---\nx", "owner", "Ada").text === "---\nowner: Ada\n---\nx");
  {
    const crlf = "\uFEFF---\r\nstatus: planned\r\n---\r\nbody\r\n";
    const { text } = set(crlf, "status", "active");
    check("line endings and a byte-order mark are kept", text === "\uFEFF---\r\nstatus: active\r\n---\r\nbody\r\n");
  }
  {
    const listed = "---\nowner:\n  - Seyi\n  - Ada\ntags: [a]\n---\n";
    const { text } = set(listed, "owner", "Ada");
    check("a block list is replaced whole", text === "---\nowner: Ada\ntags: [a]\n---\n");
  }
  check("the last of a repeated key is the one changed, the one the reader uses", noteProperties(set("---\nstatus: a\nstatus: b\n---\n", "status", "c").text).status === "c");

  /* ------------------------------ quoting ------------------------------ */
  const roundTrips = (value) => noteProperties(set(note, "owner", value).text).owner === value;
  check("an agent's name is written plainly", set(note, "owner", "Seyi's Codex").text.includes("owner: Seyi's Codex\n") && roundTrips("Seyi's Codex"));
  check("a colon is quoted so it reads back", roundTrips("Q4: launch"));
  check("a leading quote is quoted", roundTrips("'maybe'"));
  check("a word YAML would read as a boolean is quoted", set(note, "owner", "yes").text.includes('owner: "yes"'));
  check("a hash that would read as a comment is refused", /comment/.test(set(note, "owner", "room #4").error ?? ""));
  check("a hash inside a word is kept", roundTrips("C#"));
  check("the value is trimmed", noteProperties(set(note, "owner", "  Ada ").text).owner === "Ada");

  /* ------------------------------ refusals ------------------------------ */
  check("a key that is not a property name is refused", /not a property name/.test(set(note, "two words", "x").error ?? ""));
  check("a line break is refused", /one line/.test(set(note, "status", "a\nstatus: evil").error ?? ""));
  check("a control character is refused", /one line/.test(set(note, "status", "a\u0000b").error ?? ""));
  check("both kinds of quote are refused", /both kinds/.test(set(note, "owner", `'a"b`).error ?? ""));
  check("both kinds of quote are fine where no quoting is needed", roundTrips(`a'b"c`));
  check("an empty value is refused, not written", /needs a value/.test(set(note, "owner", "  ").error ?? ""));
  check("a fence the reader does not accept is refused rather than written blind", /safely/.test(set("--- \nstatus: a\n---\n", "status", "b").error ?? ""));
  check("an unclosed frontmatter is refused", /never closed/.test(set("---\nstatus: a\n# body", "status", "b").error ?? ""));
  check("a nested map under the key is replaced whole", set("---\nteam:\n  owner: Bo\nx: 1\n---\n", "team", "core").text === "---\nteam: core\nx: 1\n---\n");
}
