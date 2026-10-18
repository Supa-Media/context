import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { texCard } from "./card";

describe("Tex's contact card", () => {
  it("names Tex with the chat's own line and a photo, in lines iOS reads", () => {
    const card = texCard("+15555550199");
    const lines = card.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCARD");
    expect(lines).toContain("FN:Tex");
    expect(lines).toContain("TEL;TYPE=CELL,VOICE,pref:+15555550199");
    expect(lines.at(-2)).toBe("END:VCARD");
    expect(lines.every((line) => line.length <= 75)).toBe(true);
    // Unfolded, the photo is a whole PNG.
    const photo = card.replace(/\r\n /g, "").match(/PHOTO;ENCODING=b;TYPE=PNG:([A-Za-z0-9+/=]+)/)![1];
    expect([...atob(photo).slice(1, 4)].join("")).toBe("PNG");
    // The same picture the Name & Photo points at, so the two never drift apart.
    const served = btoa(String.fromCharCode(...readFileSync(new URL("../../mobile/public/texts-card.png", import.meta.url))));
    expect(photo).toBe(served);
  });
});
