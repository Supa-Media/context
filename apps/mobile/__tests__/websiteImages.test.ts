/**
 * @jest-environment jsdom
 *
 * Pasted pictures on a published page. The site loads no images, so a
 * `![[paste-….png]]` is drawn from the picture the page carried: on a
 * `/@handle` page by `NoteBody`, and on the homepage by the editor, whose
 * `loadImage` answers from the snapshot. Nothing but an inline picture under
 * a stored leaf is ever drawn, and one the page did not carry shows its name.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { publishedImageLeaves } from "@context/shared";
import { liveHomeTree } from "../features/home/homeSite";
import { parseHomeSnapshot } from "../features/home/homeSnapshot";
import { useLocalFileBrowser, type LocalHome } from "../features/home/useLocalFileBrowser";
import { NoteBody } from "../features/share/NoteBody";
import { parseNote } from "../features/share/markdown";
import { publishedImages } from "../features/share/publishedImages";

const LEAF = "paste-be3b688afc175efb.png";
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";
const LINE = `![[${LEAF}|356]] <!-- context: align=center -->`;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mountIn(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

describe("which pictures a page publishes", () => {
  test("stored leaves it embeds outside code, once each, and nothing else", () => {
    expect(
      publishedImageLeaves(
        [
          LINE,
          `![a photo](paste-0123456789abcdef.jpg) ![[${LEAF}]]`,
          "![[../privacy.md]] ![[notes/other.png]] ![x](https://attacker.example/pixel.png)",
          "![[photo.heic]] ![[vector.svg]]",
          "`![[paste-c0dec0dec0dec0de.png]]`",
          "```\n![[paste-fe11cefe11cefe11.png]]\n```",
        ].join("\n"),
      ),
    ).toEqual([LEAF, "paste-0123456789abcdef.jpg"]);
  });

  test("the app keeps only inline pictures of the four types, under stored leaves", () => {
    expect(
      publishedImages({
        [LEAF]: PICTURE,
        "tracker.png": "https://attacker.example/pixel.gif",
        "vector.svg": "data:image/svg+xml;base64,PHN2Zz4=",
        "../privacy.png": PICTURE,
        "broken.png": 'data:image/png;base64,iVBOR"onerror=',
      }),
    ).toEqual({ [LEAF]: PICTURE });
    expect(publishedImages(null)).toEqual({});
    expect(publishedImages([PICTURE])).toEqual({});
  });
});

describe("a /@handle page", () => {
  test("an image line is its own block, with the editor's width and alignment", () => {
    expect(parseNote(`Onboarding\n${LINE}\n\nAfter`).blocks).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "Onboarding" }] },
      { kind: "images", images: [{ target: LEAF, alt: "", width: 356 }], align: "center" },
      { kind: "paragraph", content: [{ kind: "text", text: "After" }] },
    ]);
  });

  test("a picture the page carried is drawn, named for screen readers", () => {
    const page = mountIn(
      createElement(NoteBody, { blocks: parseNote(LINE).blocks, look: "site", images: { [LEAF]: PICTURE } }),
    );
    expect(page.querySelector(`[aria-label="${LEAF}"]`)).not.toBeNull();
    expect(page.innerHTML).toContain(PICTURE);
  });

  test("one it did not carry shows its name and fetches nothing", () => {
    const page = mountIn(createElement(NoteBody, { blocks: parseNote(LINE).blocks, look: "site" }));
    expect(page.textContent).toContain(LEAF);
    expect(page.querySelector("img")).toBeNull();
    expect(page.innerHTML).not.toContain("url(");
  });
});

describe("the homepage", () => {
  test("its snapshot keeps the pictures, and the editor loads them from it", async () => {
    const snapshot = parseHomeSnapshot({
      siteName: "Context",
      revision: "1:1",
      pages: [{ path: "use-cases.md", routePath: "/use-cases", title: "Use cases", markdown: LINE }],
      emoji: {},
      images: { [LEAF]: PICTURE, "tracker.png": "https://attacker.example/pixel.gif" },
    });
    expect(snapshot?.images).toEqual({ [LEAF]: PICTURE });

    // Built once: a new tree on every render is a new site on every render.
    const home = liveHomeTree(snapshot!.pages);
    const seen: { current: LocalHome | null } = { current: null };
    function Probe() {
      seen.current = useLocalFileBrowser(home, "home", "/use-cases", {}, snapshot!.images);
      return null;
    }
    mountIn(createElement(Probe));
    await expect(seen.current!.files.loadImage(LEAF)).resolves.toBe(PICTURE);
    await expect(seen.current!.files.loadImage("paste-9999999999999999.png")).resolves.toBeNull();
  });
});
