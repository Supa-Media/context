import { describe, expect, test } from "@jest/globals";
import { matchNames, normalizePhone, syncContactNames } from "../features/tex/contacts/contactNames";

describe("guests' names from this phone's contacts", () => {
  test("a contact's number is read as +digits only when it can be without guessing", () => {
    expect(normalizePhone("(555) 010-2233")).toBe("+15550102233");
    expect(normalizePhone("1 555 010 2233")).toBe("+15550102233");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("010 2233")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  test("only asked numbers get a name, and a number two contacts name differently gets none", () => {
    const asked = ["+15550102233", "+15550104455", "+15550106677"];
    const contacts = [
      { name: "Priya  Shah", numbers: ["(555) 010-2233"] },
      { name: "Bo", numbers: ["+1 555 010 4455"] },
      { name: "Bob Work", numbers: ["555-010-4455"] },
      { name: "Not asked", numbers: ["+15550109999"] },
      { name: "", numbers: ["+15550106677"] },
      { name: "priya shah", numbers: ["+15550102233"] },
    ];
    expect(matchNames(asked, contacts)).toEqual([{ phone: "+15550102233", name: "Priya Shah" }]);
  });

  test("a sync reads the contacts only when a number needs a name, and sends back only matches", async () => {
    const sent: unknown[] = [];
    let read = 0;
    const contacts = async () => (read++, [{ name: "Dee", numbers: ["555 010 2233"] }, { name: "Else", numbers: ["555 010 9999"] }]);
    const names = async (n: { phone: string; name: string }[]) => (sent.push(n), n.length);
    expect(await syncContactNames({ numbers: async () => [], names, contacts })).toBe(0);
    expect(read).toBe(0);
    expect(await syncContactNames({ numbers: async () => ["+15550102233"], names, contacts })).toBe(1);
    expect(sent).toEqual([[{ phone: "+15550102233", name: "Dee" }]]);
    expect(await syncContactNames({ numbers: async () => null, names, contacts })).toBeNull();
  });
});
