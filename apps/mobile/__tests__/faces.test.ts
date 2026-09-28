/**
 * @jest-environment jsdom
 */

/**
 * Faces in the app: which picture a name draws, and the drawn default.
 *
 * The server decides photo-over-workspace-icon (`apps/convex/__tests__/faces.test.ts`);
 * what has to hold here is that a surface's name finds that answer however it
 * is written, that nobody's face is ever letters, and that the default face's
 * ground colour is a fixed function of the handle, so a person looks the same on
 * every device, forever, until they choose a picture (Dev2, 2026-09-28).
 *
 * ## Sabotage record
 *
 *   faceFor ignores case                                  1
 *   faceIndex seeded with Date.now()                      1
 *   faceNode draws the name's first letters               1
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { DEFAULT_FACE_GROUNDS } from "../features/design/tokens/colors";
import { defaultFace, faceIndex } from "../features/console/faces/defaultFace";
import { faceNode } from "../features/console/faces/faceDom";
import { clearFaces, faceFor, myFace, myHandle, setFaces } from "../features/console/faces/faceStore";

const never = () => Promise.reject(new Error("not asked"));

afterEach(() => clearFaces());

describe("the store", () => {
  test("a handle finds its face however a surface writes it", () => {
    setFaces(
      {
        me: { person: "u1", face: { kind: "emoji", emoji: "🧠" } },
        people: [{ person: "u1", handle: "@seyi", face: { kind: "emoji", emoji: "🧠" } }],
      },
      never,
    );
    for (const name of ["@seyi", "seyi", "@Seyi", " @seyi "]) {
      expect(faceFor(name)).toEqual({ kind: "emoji", emoji: "🧠" });
    }
    expect(faceFor("seyi@example.invalid")).toBeUndefined();
    expect(myFace()).toEqual({ kind: "emoji", emoji: "🧠" });
    expect(myHandle()).toBe("@seyi");
  });

  test("a workspace photo is fetched once and drawn when it lands", async () => {
    let asked = 0;
    const read = async () => {
      asked += 1;
      return { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "image/png" };
    };
    const answer = {
      me: null,
      people: [{ person: "u2", handle: "@shay", face: { kind: "workspacePhoto" as const, leaf: "icon-a.png" } }],
    };
    setFaces(answer, read);
    setFaces(answer, read);
    expect(faceFor("@shay")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toBe(1);
    expect(faceFor("@shay")).toEqual({ kind: "photo", uri: "data:image/png;base64,AQID" });
  });
});

describe("the default face", () => {
  test("is the same colour for the same handle, however written", () => {
    expect(faceIndex("@seyi")).toBe(faceIndex("Seyi"));
    expect(defaultFace("@seyi")).toEqual(defaultFace("@seyi"));
  });

  test("is a fixed function: these handles keep these palettes", () => {
    // Pinned, so a change to the hash is a visible change to everybody's face.
    expect(["@seyi", "@shay", "@jon", "@layomi"].map(faceIndex)).toEqual([7, 4, 0, 0]);
  });

  test("spreads people across the palettes", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => faceIndex(`@person${i}`)));
    expect(used.size).toBe(DEFAULT_FACE_GROUNDS.length);
  });

  test("in the editor's DOM, a person with no picture is the Supa mark on their colour, never lettered", () => {
    const node = faceNode("@jon", "cm-cmt-av");
    expect(node.querySelector("img")?.getAttribute("src")).toBe(defaultFace("@jon").logo);
    expect(node.style.background).not.toBe("");
    expect(node.textContent).toBe("");
  });

  test("in the editor's DOM, a chosen emoji is the face", () => {
    setFaces({ me: null, people: [{ person: "u3", handle: "@jon", face: { kind: "emoji", emoji: "🦊" } }] }, never);
    expect(faceNode("@jon", "cm-cmt-av").textContent).toBe("🦊");
  });
});
