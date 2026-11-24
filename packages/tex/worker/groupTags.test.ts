import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { keepTagPeople, tagParts, tagWords } from "./groupTags";

const SAM = "+15550000003";
const JO = "+15550000004";
const STRANGER = "+15550000009";

async function kept() {
  const storage = new MemoryStorage();
  await keepTagPeople(storage, [
    { phone: SAM, handle: "sam", name: "Sam Lee" },
    { phone: JO, handle: "jo" },
  ]);
  return storage;
}

describe("groupTags: Tex's own native tags", () => {
  it("shows each @handle of someone here by first name and tags their number", async () => {
    const storage = await kept();
    const read = await tagWords(storage, "@sam can you take the deck? @jo has the notes", async () => [SAM, JO]);
    expect(read.text).toBe("Sam can you take the deck? jo has the notes");
    expect(read.tags).toEqual([
      { start: 0, length: 3, address: SAM },
      { start: 27, length: 2, address: JO },
    ]);
    expect(tagParts(read.text, read.tags)).toEqual([
      { text: "Sam", mention: SAM },
      { text: " can you take the deck? " },
      { text: "jo", mention: JO },
      { text: " has the notes" },
    ]);
  });

  it("never tags someone no longer here, or a number two handles share, but still shows the name", async () => {
    const storage = await kept();
    const gone = await tagWords(storage, "thanks @sam", async () => [JO]);
    expect(gone).toEqual({ text: "thanks Sam", tags: [] });
    const unread = await tagWords(storage, "thanks @sam", async () => null);
    expect(unread).toEqual({ text: "thanks Sam", tags: [] });
  });

  it("leaves an email, an unknown @word and a guest's label as written, and reads no members for them", async () => {
    const storage = await kept();
    let reads = 0;
    const members = async () => (reads++, [SAM, JO, STRANGER]);
    expect(await tagWords(storage, "mail sam@example.com or @everyone, @guest-1a2b", members)).toEqual({ text: "mail sam@example.com or @everyone, @guest-1a2b", tags: [] });
    expect(reads).toBe(0);
  });

  it("reads a handle in any case, as a sentence's first word writes it", async () => {
    const storage = await kept();
    const read = await tagWords(storage, "@Sam can you take the deck?", async () => [SAM]);
    expect(read).toEqual({ text: "Sam can you take the deck?", tags: [{ start: 0, length: 3, address: SAM }] });
  });

  it("with nobody kept, the words go as given", async () => {
    expect(await tagWords(new MemoryStorage(), "@sam hi", async () => [SAM])).toEqual({ text: "@sam hi", tags: [] });
  });
});
