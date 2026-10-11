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
 * ## Graphite, because the app is Graphite
 *
 * This card used to be `#050506` and `#3B82F6` — the old blue-black world and a
 * Tailwind default blue. `apps/mobile/features/design/tokens.ts` replaced both
 * with **Graphite and Paper**, warm neutrals whose own header names the reason:
 * "a palette assembled from a framework's defaults looks like every other
 * application assembled from them". The card was still wearing the defaults, so
 * every link this product minted unfurled in a palette the product itself no
 * longer used anywhere.
 *
 * The values below are Graphite's, copied rather than imported: `apps/convex`
 * cannot reach into `apps/mobile`, and `__tests__/cardArt.test.ts` compares
 * them against the token file so the copy cannot drift silently.
 *
 * **Petrol (`ACCENT`) is the only hue this card spends**, which is that file's
 * rationing rule applied here: petrol means "here, active, yours" and is never
 * a status. A card has no statuses to report, so it has no other hue.
 *
 * ## satori is not a browser
 *
 * Flexbox only. No grid, no `calc()`, no `z-index`, no `<style>`, and **every
 * element with children needs an explicit `display: "flex"`**. It implements
 * neither radial gradients nor `mask-image`, which is why this design is flat
 * fills, hairlines and one rule: those are what can actually be drawn, rather
 * than an approximation of blooms that cannot.
 */

/** 1200x630 — what `preview.ts` advertises in `og:image:width/height`. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/*
  Graphite, from `apps/mobile/features/design/tokens.ts`. Kept in step by
  `__tests__/cardArt.test.ts`, which reads that file and compares — a comment
  claiming two files agree is the thing this repo keeps finding untrue.
*/
const GROUND = "#100F0E";
const SURFACE = "#191715";
const LINE = "rgba(237,232,224,0.07)";
const LINE_STRONG = "rgba(237,232,224,0.14)";
const TEXT = "#EDE8E0";
const TEXT_2 = "#C3BCB2";
const HERO_DIM = "#7A736A";
const ACCENT = "#6BC8C1";

/**
 * What kind of thing the link opens, as the chip in the corner.
 *
 * Three words, each derived from the **share row** rather than from the note:
 * `collect` mode is a form, `entryKind` is a folder, everything else is a note.
 * Nothing here reads a bucket, and nothing here is derived from what a note
 * contains — the card says what the link *is*, never what is inside it.
 */
export type CardKind = "note" | "folder" | "form";

const KIND_LABEL: Record<CardKind, string> = {
  note: "NOTE",
  folder: "FOLDER",
  form: "FORM",
};

/**
 * What the card says under the title.
 *
 * About *access*, never about the note. Everything on this card reaches anyone
 * who holds the URL — including people the owner never sent it to, because
 * Slack and iMessage copy the image onto their own CDNs — so it says how to
 * read the thing and nothing about what is in it.
 *
 * The form line is the one that differs, and it differs because it is the one
 * case where the honest answer is not "sign in": a collect link takes answers
 * from people with no account, and telling them to sign in would be the card
 * contradicting the page it points at.
 */
export const CARD_SUBTITLE = "Shared with you — sign in to read it";
export const CARD_SUBTITLE_FORM = "Open to fill in. No account needed.";

export function subtitleFor(kind: CardKind): string {
  return kind === "form" ? CARD_SUBTITLE_FORM : CARD_SUBTITLE;
}

/**
 * Type size by title length.
 *
 * satori has no text-measurement API to auto-fit with, and the input is bounded
 * at 60 characters by `MAX_PREVIEW_TITLE`, so three steps cover the range. The
 * panel's inner column is 944px wide; a 60-character title wraps to two lines
 * at 52px with room to spare under it.
 */
export function titleSize(title: string): number {
  if (title.length <= 24) return 74;
  if (title.length <= 42) return 62;
  return 52;
}

export interface CardFacts {
  title: string;
  /**
   * The workspace this belongs to, as `@name`, or `null` for the domain.
   *
   * **`null` is not "we could not find it".** It is the answer for every link
   * whose *address* does not already carry the handle — see `shareCard.ts`,
   * which is where that decision is taken and argued. A card is cached forever
   * by every platform that unfurls it, so a handle drawn onto one that its URL
   * did not disclose cannot be taken back.
   */
  handle: string | null;
  kind: CardKind;
  /**
   * What a **folder** link carries beside its name: two or three team-visible
   * things inside it, already filtered by the privacy engine and already
   * bounded by `boundPreviewChildren`. Nothing here filters or truncates —
   * this file draws what it is handed, and a drawing function that re-derived
   * a security bound would be a second place for that bound to be wrong.
   *
   * An empty list is the ordinary card. That is deliberate and it is what makes
   * a folder with nothing team-visible inside it indistinguishable from one
   * whose listing simply is not drawn: the row appears or it does not, and a
   * card never says "this is a folder, and there is nothing in it for you".
   */
  children: readonly string[];
}

/**
 * The kind the card actually *draws*, which is not always the kind it is told.
 *
 * **A folder with nothing team-visible inside it draws as a note**, chip
 * included. That is the rule the folder mark this chip replaced already
 * followed — the mark and the listing appeared together or not at all — and it
 * exists so a card never says "this is a folder, and there is nothing in it for
 * you". A `FOLDER` chip over an empty card would say exactly that, in a picture
 * cached forever by whoever unfurled it.
 *
 * So the chip is tied to the listing rather than to the row. The row's kind is
 * still the input, because `form` is decided there and has no listing of its
 * own; only the folder case is narrowed.
 */
export function drawnKind(kind: CardKind, children: readonly string[]): CardKind {
  if (kind !== "folder") return kind;
  return children.length > 0 ? "folder" : "note";
}

/** The card, as satori's element tree. */
export function cardElement(facts: CardFacts): unknown {
  return {
    type: "div",
    props: {
      style: {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        padding: 40,
        backgroundColor: GROUND,
        fontFamily: "Instrument Sans",
      },
      children: [
        panel({ ...facts, kind: drawnKind(facts.kind, facts.children) }),
      ],
    },
  };
}

/**
 * The inset panel, which is the whole of the frame.
 *
 * A hairline border over a surface one step up from the ground. On a message
 * bubble this is what gives the card an edge without a shadow — satori draws no
 * `box-shadow`, so the border is not a decoration, it is the only edge there
 * is.
 */
function panel(facts: CardFacts): unknown {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        padding: "58px 64px",
        backgroundColor: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 28,
      },
      children: [
        lockup(facts.handle, facts.kind),
        rule(),
        heading(facts),
        // `flexGrow` on a spacer rather than `justifyContent: space-between`
        // on the panel: the title block has to sit hard under the rule and the
        // footer hard at the bottom, and space-between would distribute the
        // slack between three children instead of putting all of it in one.
        { type: "div", props: { style: { display: "flex", flexGrow: 1 } } },
        foot(facts),
      ],
    },
  };
}

/**
 * Whose context this is, and what kind of thing the link opens.
 *
 * **The workspace leads and the domain does not appear here at all.** A card is
 * somebody's note being handed to somebody else; putting our domain in the
 * position of most emphasis made every share look like an advertisement for us.
 * `context.lc` still appears, at the foot, in the size a domain deserves.
 *
 * Where there is no handle to draw — see `CardFacts.handle` — the domain takes
 * the slot rather than the slot collapsing, because an empty corner above a
 * title reads as a rendering fault.
 */
function lockup(handle: string | null, kind: CardKind): unknown {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "row", alignItems: "center" },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "row", alignItems: "center", gap: 14 },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: 13,
                    height: 13,
                    borderRadius: 999,
                    backgroundColor: ACCENT,
                  },
                },
              },
              {
                type: "div",
                props: {
                  style: handle === null
                    ? { display: "flex", fontSize: 28, color: HERO_DIM, letterSpacing: "0.01em" }
                    : { display: "flex", fontSize: 36, fontWeight: 600, color: TEXT, letterSpacing: "-0.02em" },
                  children: handle ?? "context.lc",
                },
              },
            ],
          },
        },
        { type: "div", props: { style: { display: "flex", flexGrow: 1 } } },
        kindChip(kind),
      ],
    },
  };
}

/**
 * The kind, as a letterspaced pill.
 *
 * Uppercase Latin and nothing else, so the bundled face draws it without
 * `cardCoverage.ts` having anything to say — which is the whole reason the card
 * has one font rather than two. See `cardFont/instrumentSans.ts`.
 */
function kindChip(kind: CardKind): unknown {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        padding: "9px 19px",
        borderRadius: 999,
        border: `1px solid ${LINE_STRONG}`,
        fontSize: 20,
        color: HERO_DIM,
        letterSpacing: "0.08em",
      },
      children: KIND_LABEL[kind],
    },
  };
}

/** The one accent mark on the card. */
function rule(): unknown {
  return {
    type: "div",
    props: {
      style: { display: "flex", width: 84, height: 3, marginTop: 40, backgroundColor: ACCENT },
    },
  };
}

function heading(facts: CardFacts): unknown {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", marginTop: 32 },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontWeight: 600,
              fontSize: titleSize(facts.title),
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              color: TEXT,
              // Wraps rather than truncating.
              maxWidth: 944,
            },
            children: facts.title,
          },
        },
      ],
    },
  };
}

/**
 * The listing, the subtitle and the domain — the bottom of the card.
 *
 * **The listing is one text node rather than a chip per name, and the reason is
 * arithmetic.** A chip per name is a flex row that cannot wrap and cannot
 * shrink: three names at `MAX_PREVIEW_CHILD_NAME` plus their padding is roughly
 * 1,600px inside a 1,072px column, so the third one leaves the frame — and
 * satori clips rather than complaining, which would ship a cut-off card into
 * every unfurler's CDN permanently. Text wraps, so the worst case is a second
 * line.
 *
 * It is also **the same string the `og:description` carries**, joined the same
 * way, so the picture and the text cannot say different things about one
 * folder. Each name is drawn as it is stored — the filename the owner's bucket
 * actually holds, with a trailing `/` where it is a folder — because a
 * prettified one would be a word this product invented about somebody's file.
 */
function foot(facts: CardFacts): unknown {
  const rows: unknown[] = [];
  if (facts.children.length > 0) {
    rows.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          marginBottom: 20,
          fontSize: 24,
          lineHeight: 1.35,
          color: TEXT_2,
          letterSpacing: "-0.01em",
          maxWidth: 1072,
        },
        children: facts.children.join(" · "),
      },
    });
  }
  const domainLeads = facts.handle === null;
  rows.push(
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          fontSize: 29,
          lineHeight: 1.35,
          color: TEXT_2,
          letterSpacing: "-0.01em",
          maxWidth: 1072,
        },
        children: subtitleFor(facts.kind),
      },
    },
  );
  /*
    The domain, once. Where there is no handle the lockup is already showing
    `context.lc`, and a second copy 400px below it is the card saying one word
    twice — which is what it did when this line was unconditional, on every
    token link in existence.
  */
  if (!domainLeads) {
    rows.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          marginTop: 20,
          fontSize: 23,
          color: HERO_DIM,
          letterSpacing: "0.01em",
        },
        children: "context.lc",
      },
    });
  }
  return {
    type: "div",
    props: { style: { display: "flex", flexDirection: "column" }, children: rows },
  };
}
