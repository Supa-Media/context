/**
 * The share card, with the note's title drawn into it.
 *
 * satori lays the card out and resvg rasterises it, both as WebAssembly inside
 * this Worker. Measured: 20–24 ms warm, 86 ms on the first request of an
 * isolate (wasm compile), 13–22 KB of PNG. The bundle cost is ~819 KiB gzipped
 * including both fonts.
 *
 * ## `loadAdditionalAsset` is the most important line in this file
 *
 * By default, satori **makes outbound network requests** when it meets a glyph
 * its fonts do not cover — to `fonts.googleapis.com` for a fallback face and to
 * `cdn.jsdelivr.net` for Twemoji. That default is wrong here three times over:
 *
 *  - **It is a hidden runtime dependency on two third parties**, in the request
 *    path of a Worker whose whole selling point is "clone this and deploy it".
 *    It would also send note titles to Google and jsDelivr.
 *  - **It makes latency attacker-influenced.** Measured: 20 ms for ASCII, 725 ms
 *    for Japanese, 464 ms for a string of emoji — a 36× swing driven by text
 *    somebody typed.
 *  - **It crashes.** With a fetched Noto Arabic, opentype.js throws
 *    `lookupType: 5 - substFormat: 3 is not yet supported` and the request 500s.
 *
 * Returning `""` closes all three. It also closes an SSRF path: satori 0.29.1
 * hardened its remote-asset fetcher against trailing dots, redirects and
 * private-IP DNS, and `@cf-wasm/og` pins 0.29.0 — one patch short. With remote
 * loading disabled that code is never entered, so the mitigation is
 * load-bearing for security and not only for latency.
 *
 * What it costs is that an uncovered glyph would render as tofu. That is
 * handled *before* we get here, by `isRenderable` — see `renderShareCard`.
 *
 * ## satori is not a browser
 *
 * Flexbox only. No grid, no `calc()`, no `z-index`, no `<style>`, and **every
 * element that has children needs an explicit `display: "flex"`**. The design
 * below is therefore a simplification of `og-card.source.html` rather than a
 * port of it: the radial blooms and the masked grid are gone, because they are
 * `background-image` and `mask-image`, which satori does not implement. The
 * palette, the type and the layout rhythm are the same.
 */

import { ImageResponse } from "@cf-wasm/og";
import onest from "./fonts/Onest.ttf";
import instrumentSans from "./fonts/InstrumentSans.ttf";
import { fontCoverage, isRenderable } from "./fontCoverage";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Straight from `og-card.source.html`, so the two cards are the same object. */
const GROUND = "#050506";
const TEXT = "#F2F2F4";
const TEXT_2 = "#A8A8B2";
const MUTED = "#75757F";
const ACCENT = "#3B82F6";
const LINE_STRONG = "rgba(255,255,255,.14)";

/**
 * The title's font, and the only one a caller's text is drawn in.
 *
 * Coverage is computed from this one alone: the subtitle and wordmark are
 * fixed strings we wrote, so Instrument Sans only ever has to draw characters
 * that were checked when they were typed. Onest covers 780 codepoints,
 * including every accented Latin letter, em dash, curly quote and ellipsis —
 * verified against the actual file, not assumed.
 */
let titleCoverage: Set<number> | null = null;

function coveredCodepoints(): Set<number> {
  titleCoverage ??= fontCoverage(onest as ArrayBuffer);
  return titleCoverage;
}

/**
 * Whether a card can be drawn for this title without tofu.
 *
 * Exported so the route can decide *before* spending 20 ms of CPU, and so the
 * decision is testable without rendering anything.
 */
export function canRenderTitle(title: string): boolean {
  return isRenderable(title, coveredCodepoints());
}

/**
 * Type sizes, chosen by length rather than measured.
 *
 * satori has no text-measurement API to auto-fit with, and the input is bounded
 * at 60 characters by `MAX_PREVIEW_TITLE` in the control plane, so three steps
 * cover the whole range. The largest is a little under the static card's 88px
 * because that one sets its own copy and this one does not.
 */
function titleSize(title: string): number {
  if (title.length <= 24) return 82;
  if (title.length <= 42) return 66;
  return 54;
}

/**
 * Render the card, or `null` if this title cannot be drawn.
 *
 * `null` rather than a throw for the uncovered-glyph case, because it is an
 * expected outcome with a defined answer — serve the static card — not a
 * failure. Genuine failures still throw, and the route catches those and serves
 * the same static card, so the two paths converge on the safe result by
 * different routes.
 */
export async function renderShareCard(title: string): Promise<Response | null> {
  if (!canRenderTitle(title)) return null;

  return new ImageResponse(card(title), {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [
      { name: "Onest", data: onest as ArrayBuffer, weight: 600, style: "normal" },
      {
        name: "Instrument Sans",
        data: instrumentSans as ArrayBuffer,
        weight: 500,
        style: "normal",
      },
    ],
    // THE LINE. See the module comment before changing it.
    loadAdditionalAsset: async () => "",
  });
}

/** The card itself, as satori's element tree. */
function card(title: string) {
  return {
    type: "div",
    props: {
      style: {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "74px 80px",
        backgroundColor: GROUND,
        fontFamily: "Instrument Sans",
      },
      children: [wordmark(), heading(title), footer()],
    },
  };
}

/** `● Context` — the dot is the accent light the static card blooms with. */
function wordmark() {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 13 },
      children: [
        {
          type: "div",
          props: {
            style: {
              width: 11,
              height: 11,
              borderRadius: 999,
              backgroundColor: ACCENT,
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontFamily: "Onest",
              fontSize: 27,
              fontWeight: 600,
              color: TEXT,
              letterSpacing: "-0.025em",
            },
            children: "Context",
          },
        },
      ],
    },
  };
}

/**
 * The title, and the one line that says what the reader has to do.
 *
 * The subtitle is deliberately about *access* rather than about the note.
 * Everything on this card reaches anybody who holds the URL, so it says how to
 * read the thing and nothing about what is in it.
 */
function heading(title: string) {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column" },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontFamily: "Onest",
              fontWeight: 600,
              fontSize: titleSize(title),
              lineHeight: 1.06,
              letterSpacing: "-0.038em",
              color: TEXT,
              // Wraps rather than truncating. A 60-character title lands on two
              // lines at 54px with room to spare — measured, not hoped.
              maxWidth: 940,
            },
            children: title,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              marginTop: 26,
              fontSize: 25,
              color: TEXT_2,
              letterSpacing: "-0.005em",
            },
            children: "Shared with you — sign in to read it",
          },
        },
      ],
    },
  };
}

/** The rule and chip the static card ends on, so the two look related. */
function footer() {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 12 },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              padding: "9px 16px",
              borderRadius: 999,
              border: `1px solid ${LINE_STRONG}`,
              fontSize: 16,
              color: MUTED,
              letterSpacing: "-0.01em",
            },
            children: "context.lc",
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexGrow: 1, height: 1, backgroundColor: LINE_STRONG },
          },
        },
      ],
    },
  };
}
