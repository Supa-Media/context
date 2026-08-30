/**
 * The share card's artwork, as a satori element tree.
 *
 * Pure, and deliberately separate from the action that renders it. The action
 * is a `"use node"` module — it cannot be imported from an ordinary Convex
 * function, and anything in it is unreachable from a test that does not boot
 * Node. This file has no imports at all, so the layout, the type sizes and the
 * copy can be asserted directly.
 *
 * That split is the same one `livePreview.ts` makes in the console for the same
 * reason: the interesting decisions are in the shape, and the shape should not
 * need a renderer to check.
 *
 * ## satori is not a browser
 *
 * Flexbox only. No grid, no `calc()`, no `z-index`, no `<style>`, and **every
 * element with children needs an explicit `display: "flex"`**. This is a
 * simplification of `infra/router/og-card.source.html` rather than a port: the
 * radial blooms and the masked grid are `background-image` and `mask-image`,
 * which satori does not implement. Palette, type and rhythm are the same, so
 * the two cards read as the same object.
 */

/** Straight from `og-card.source.html`, so both cards agree. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const GROUND = "#050506";
const TEXT = "#F2F2F4";
const TEXT_2 = "#A8A8B2";
const MUTED = "#75757F";
const ACCENT = "#3B82F6";
const LINE_STRONG = "rgba(255,255,255,.14)";

/**
 * What the card says under the title.
 *
 * About *access*, never about the note. Everything on this card reaches anyone
 * who holds the URL — including people the owner never sent it to, because
 * Slack and iMessage copy the image onto their own CDNs — so it says how to
 * read the thing and nothing about what is in it.
 */
export const CARD_SUBTITLE = "Shared with you — sign in to read it";

/**
 * Type size by title length.
 *
 * satori has no text-measurement API to auto-fit with, and the input is bounded
 * at 60 characters by `MAX_PREVIEW_TITLE`, so three steps cover the range. A
 * 60-character title wraps to two lines at 54px with room to spare — measured,
 * not hoped.
 */
export function titleSize(title: string): number {
  if (title.length <= 24) return 82;
  if (title.length <= 42) return 66;
  return 54;
}

/** The card, as satori's element tree. */
export function cardElement(title: string): unknown {
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
        fontFamily: "Onest",
      },
      children: [wordmark(), heading(title), footer()],
    },
  };
}

function wordmark(): unknown {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 13 },
      children: [
        {
          type: "div",
          props: {
            style: { width: 11, height: 11, borderRadius: 999, backgroundColor: ACCENT },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
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

function heading(title: string): unknown {
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
              fontWeight: 600,
              fontSize: titleSize(title),
              lineHeight: 1.06,
              letterSpacing: "-0.038em",
              color: TEXT,
              // Wraps rather than truncating.
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
            children: CARD_SUBTITLE,
          },
        },
      ],
    },
  };
}

function footer(): unknown {
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
            style: {
              display: "flex",
              flexGrow: 1,
              height: 1,
              backgroundColor: LINE_STRONG,
            },
          },
        },
      ],
    },
  };
}
