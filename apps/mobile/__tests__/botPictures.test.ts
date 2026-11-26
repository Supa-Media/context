/**
 * @jest-environment node
 */

/**
 * A BOT'S LOGO IS THERE AT ONCE, LIKE A PERSON'S FACE.
 *
 * Dev2, 2026-11-26: "it takes some time for the bot image to load up, can we have it be instant? like the person
 * images?" A logo read once this session is drawn on the first frame, before any effect runs; one still loading is
 * drawn plain, never as a robot that then turns into the logo; a failed read is asked again.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - start `usePicture` at null rather than the logo already read, and "on the first frame" fails;
 *  - draw the robot while waiting, and "plain while it loads" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readPicture, resetBotPictures, shownPicture } from "../features/console/faces/botPictures";
import { OwnerFace } from "../features/console/files/folderPage/Glyphs";

describe("bots' logos", () => {
  test("read once a session, kept for the next face, and a failed read asked again", async () => {
    resetBotPictures();
    let reads = 0;
    const picture = { key: "ws|upload-0123456789abcdef.png", read: async (): Promise<string | null> => {
      reads += 1;
      return "data:image/png;base64,AAAA";
    } };
    await Promise.all([readPicture(picture), readPicture(picture)]);
    await readPicture(picture);
    expect(reads).toBe(1);
    expect(shownPicture(picture.key)).toBe("data:image/png;base64,AAAA");
    let tries = 0;
    const failing = { key: "ws|upload-fedcba9876543210.png", read: async () => ((tries += 1), null) };
    await readPicture(failing);
    await readPicture(failing);
    expect(tries).toBe(2);
    expect(shownPicture(failing.key)).toBeUndefined();
  });

  test("a logo already read is drawn on the first frame, and one still loading is drawn plain", async () => {
    resetBotPictures();
    const read = { key: "ws|upload-00112233445566aa.png", read: async () => "data:image/png;base64,AAAA" };
    await readPicture(read);
    const first = renderToStaticMarkup(createElement(OwnerFace, { face: { kind: "agent", picture: read } }));
    expect(first).toContain('data-testid="owner-face-logo"');
    const loading = { key: "ws|upload-99887766554433aa.png", read: () => new Promise<string | null>(() => {}) };
    const plain = renderToStaticMarkup(createElement(OwnerFace, { face: { kind: "agent", picture: loading } }));
    expect(plain).toContain('data-testid="owner-face-waiting"');
    expect(plain).not.toContain('data-testid="owner-face-agent"');
    // A bot with no logo is the robot.
    expect(renderToStaticMarkup(createElement(OwnerFace, { face: { kind: "agent" } }))).toContain('data-testid="owner-face-agent"');
  });
});
