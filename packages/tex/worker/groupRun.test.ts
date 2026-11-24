import { describe, expect, it } from "vitest";
import { addressOf, groupRunOf, withoutGroupRun } from "./groupRun";

const PHOTO = { url: "https://agent.example/photon/attachment/att-7?e=1&s=x", mimeType: "image/jpeg", filename: "IMG_1.jpg", size: 1000 };

describe("groupRunOf", () => {
  it("takes the lines out and names the chat", () => {
    const run = groupRunOf("(name the chat) Lisbon trip\nDone, it's Lisbon trip now.", { text: "Tex call this chat Lisbon trip" });
    expect(run).toEqual({ text: "Done, it's Lisbon trip now.", actions: [{ kind: "name", name: "Lisbon trip" }], refused: [] });
  });

  it("strips quotes round a name, and keeps a text with no lines as it is", () => {
    expect(groupRunOf("(Name the chat) “Lisbon trip”", { text: "" }).actions).toEqual([{ kind: "name", name: "Lisbon trip" }]);
    expect(groupRunOf("just words (name the chat) inside", { text: "" })).toEqual({ text: "just words (name the chat) inside", actions: [], refused: [] });
  });

  it("sets the photo from a picture the asker sent with this text, on Photon's line", () => {
    expect(groupRunOf("(set the chat photo)", { text: "make this the photo", attachments: [PHOTO] }).actions).toEqual([{ kind: "photo", attachment: "att-7" }]);
    expect(groupRunOf("(set the chat photo)", { text: "make this the photo" }).refused).toEqual(["photo_none"]);
    expect(groupRunOf("(set the chat photo)", { text: "", attachments: [{ ...PHOTO, url: "https://elsewhere.example/x.jpg" }] }).refused).toEqual(["photo_none"]);
    expect(groupRunOf("(set the chat photo)", { text: "", attachments: [{ ...PHOTO, mimeType: "application/pdf" }] }).refused).toEqual(["photo_none"]);
  });

  it("adds someone only by a number or email the asker's own text holds", () => {
    const asked = { text: "Tex add my mom, her number is (555) 010-0199" };
    expect(groupRunOf("(add to the chat) +1 555 010 0199\nAdded her!", asked)).toEqual({ text: "Added her!", actions: [{ kind: "add", address: "+15550100199" }], refused: [] });
    expect(groupRunOf("(add to the chat) +15550100200", asked).refused).toEqual(["add_not_in_their_words"]);
    expect(groupRunOf("(add to the chat) Mom", asked).refused).toEqual(["add_not_an_address"]);
    expect(groupRunOf("(add to the chat) Mom@Example.com", { text: "add mom@example.com please" }).actions).toEqual([{ kind: "add", address: "mom@example.com" }]);
  });

  it("does each thing once", () => {
    const run = groupRunOf("(name the chat) A\n(name the chat) B\n(add to the chat) 5550100199\n(add to the chat) +15550100199", { text: "5550100199" });
    expect(run.actions).toEqual([{ kind: "name", name: "A" }, { kind: "add", address: "+15550100199" }]);
    expect(run.text).toBe("");
  });
});

describe("addressOf", () => {
  it("writes numbers as E.164 and emails in lower case", () => {
    expect(addressOf("555-010-0199")).toBe("+15550100199");
    expect(addressOf("1 555 010 0199")).toBe("+15550100199");
    expect(addressOf("+44 20 7946 0958")).toBe("+442079460958");
    expect(addressOf("A@B.co")).toBe("a@b.co");
    expect(addressOf("12345")).toBeNull();
    expect(addressOf("call 5550100199")).toBeNull();
  });
});

describe("withoutGroupRun", () => {
  it("takes the lines out and leaves other words alone", () => {
    expect(withoutGroupRun("(set the chat photo)\nNice photo")).toBe("Nice photo");
    expect(withoutGroupRun("Nice photo")).toBe("Nice photo");
  });
});
