/**
 * The card a note link Tex texts unfurls with, as a satori element tree
 * (Dev, 2026-11-23: the round-4 artboard he approved,
 * `docs/decisions/privacy-and-sharing/note-link-previews.md`).
 *
 * The note's name in Libron, its folders under it, and in the top corner
 * either Tex doing something that fits the note or the app's # when nothing
 * does. The ground is one of seven backdrops, picked from the link's address:
 * a notebook page, ink, and the five boards of the app's graph page in their
 * own colours (`apps/mobile/features/design/tokens/colors.ts` `boardColors`).
 *
 * Pure, like `cardArt.ts`: no renderer, so the layout is testable without
 * Node. Every picture on it (the backdrop, Tex, the #) is an SVG this file
 * builds and hands satori as an image, because satori draws neither patterns
 * nor noise and resvg draws both.
 */

import { hashTileSvg, texPoseSvg, type TexPose } from "@context/shared/src/ink/texPoses.cjs";
import type { NoteBoard } from "@context/shared/src/notePreview.cjs";

export const NOTE_CARD_WIDTH = 1200;
export const NOTE_CARD_HEIGHT = 630;

/** Each backdrop's colours: the ground, the name, the folder line, Tex's ink and the # tile's ground. */
type Board = { ground: string; text: string; text2: string; accent: string; tile: string };

export const NOTE_BOARDS: Readonly<Record<NoteBoard, Board>> = {
  // Context's brand (docs/brand/README.md): paper, ink, Tex blue.
  notebook: { ground: "#EDE4D3", text: "#16181C", text2: "#55534E", accent: "#2A45CF", tile: "#EDE4D3" },
  ink: { ground: "#16181C", text: "#EDE4D3", text2: "rgba(237,228,211,0.6)", accent: "#8A9BF2", tile: "#22252B" },
  // The graph page's boards, `boardColors` in the app's tokens.
  paper: { ground: "#FAF7F0", text: "#23211D", text2: "#4A463F", accent: "#2A45CF", tile: "#F3EFE7" },
  graph: { ground: "#F8F7F2", text: "#202329", text2: "#43474F", accent: "#2A45CF", tile: "#F8F7F2" },
  kraft: { ground: "#CFB48C", text: "#21170D", text2: "#3B2D1E", accent: "#1F3AB8", tile: "#E4D3B6" },
  chalk: { ground: "#1E2220", text: "#ECEAE4", text2: "#A39F96", accent: "#8A9BF2", tile: "#2B302E" },
  blueprint: { ground: "#1D447F", text: "#F4F8FF", text2: "#A9BEDF", accent: "#B5C3FF", tile: "#173A6E" },
};

/** The period blue of "Context." (docs/brand/README.md): the fill of what Tex holds. */
const PERIOD_BLUE = "#2F7BF5";
const PROP_PAPER = "#FBFAF6";

const W = NOTE_CARD_WIDTH;
const H = NOTE_CARD_HEIGHT;

/** Ruled lines, a grid, or a grain: what each backdrop draws over its ground. */
function backdropMarks(board: NoteBoard): string {
  const grid = (color: string, strong: number, faint: number) =>
    `<defs><pattern id="f" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${color}" stroke-opacity="${faint}" stroke-width="1"/></pattern>` +
    `<pattern id="s" width="240" height="240" patternUnits="userSpaceOnUse"><path d="M240 0H0V240" fill="none" stroke="${color}" stroke-opacity="${strong}" stroke-width="2"/></pattern></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#f)"/><rect width="${W}" height="${H}" fill="url(#s)"/>`;
  const grain = (frequency: number, alpha: number, light: boolean) =>
    `<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="7"/>` +
    `<feColorMatrix values="0 0 0 0 ${light ? 1 : 0} 0 0 0 0 ${light ? 1 : 0} 0 0 0 0 ${light ? 1 : 0} 0 0 0 ${alpha} 0"/></filter>` +
    `<rect width="${W}" height="${H}" filter="url(#g)"/>`;
  switch (board) {
    case "notebook": {
      let lines = "";
      for (let y = 94.5; y < H; y += 96) lines += `<path d="M0 ${y}H${W}" stroke="#2A45CF" stroke-opacity="0.22" stroke-width="3"/>`;
      return `${lines}<path d="M121 0V${H}" stroke="#2A45CF" stroke-width="2"/>`;
    }
    case "graph":
      return grid("#6E8FC0", 0.3, 0.16);
    case "blueprint":
      return grid("#9DBDF0", 0.38, 0.18);
    case "paper":
      return grain(0.9, 0.05, false);
    case "kraft":
      return grain(0.8, 0.14, false);
    case "chalk":
      return grain(0.55, 0.07, true);
    case "ink":
      return "";
  }
}

/** The whole backdrop as an SVG: ground and marks. */
export function backdropSvg(board: NoteBoard): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${NOTE_BOARDS[board].ground}"/>${backdropMarks(board)}</svg>`;
}

const dataUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;

/** Tex in `pose` in this backdrop's ink, or the # tile when there is no pose. */
export function cornerSvg(board: NoteBoard, pose: TexPose | null): string {
  const colors = NOTE_BOARDS[board];
  return pose === null
    ? hashTileSvg({ ground: colors.tile, ink: colors.accent })
    : texPoseSvg(pose, { ink: colors.accent, eye: PROP_PAPER, paper: PROP_PAPER, accent: PERIOD_BLUE });
}

export type NoteCardFacts = {
  /** The note's name, already checked against its key and cut to `MAX_TITLE`. */
  title: string;
  /** The note's folders as words, "" for a note at the top. */
  folder: string;
  board: NoteBoard;
  pose: TexPose | null;
};

/**
 * The card, for satori. Absolute positions throughout, as the approved
 * artboard placed them; every element with children is `display: flex`.
 */
export function noteCardElement(facts: NoteCardFacts) {
  const colors = NOTE_BOARDS[facts.board];
  const ruled = facts.board === "notebook";
  const left = ruled ? 156 : 72;
  const corner =
    facts.pose === null
      ? { right: 72, top: 56, width: 112, height: 112 }
      : { right: 44, top: 30, width: 190, height: 190 };
  return {
    type: "div",
    props: {
      style: { display: "flex", position: "relative", width: W, height: H, backgroundColor: colors.ground },
      children: [
        { type: "img", props: { src: dataUri(backdropSvg(facts.board)), width: W, height: H, style: { position: "absolute", left: 0, top: 0 } } },
        {
          type: "div",
          props: {
            style: {
              display: "block",
              position: "absolute",
              left,
              top: ruled ? 70 : 66,
              width: W - left - 280,
              fontFamily: "Libron",
              fontSize: ruled ? 84 : 104,
              lineHeight: ruled ? "96px" : 1.02,
              letterSpacing: "-0.02em",
              color: colors.text,
              lineClamp: 3,
              wordBreak: "break-word",
              overflow: "hidden",
            },
            children: facts.title,
          },
        },
        ...(facts.folder === ""
          ? []
          : [
              {
                type: "div",
                props: {
                  style: { display: "flex", position: "absolute", left, bottom: 64, fontFamily: "Instrument Sans", fontSize: 36, color: colors.text2 },
                  children: facts.folder,
                },
              },
            ]),
        { type: "img", props: { src: dataUri(cornerSvg(facts.board, facts.pose)), width: corner.width, height: corner.height, style: { position: "absolute", right: corner.right, top: corner.top } } },
      ],
    },
  };
}
