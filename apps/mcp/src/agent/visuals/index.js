/**
 * VISUAL ANSWERS (owner, 2026-10-26: "people say that they like the more
 * visual responses our competitors give, like for trips, architectures, plans
 * … essentially I want the responses to be less wordy more visuals").
 *
 * `draw_visual` turns data into one of Tex's own designed cards, photographed
 * by the same screenshot Worker as `draw_picture` (`../pictureMaker.js`). The
 * model only picks a template and fills its fields: Haiku can do that well
 * and fast, every card looks like it came from one assistant, and nothing the
 * model writes reaches the page except as escaped text or a checked picture
 * address (`./kit.js`). The templates were designed and approved on the
 * artboard "Tex visual answers" (owner: "THIS IS PERFECT + AMAZING").
 *
 * WHEN TO DRAW is `VISUALS_LINE`: two of six signals in the answer.
 */

import { CARD_HEIGHT, CARD_WIDTH, SCALE } from "./kit.js";
import { compare, gallery, option, places, tickets, versus } from "./choices.js";
import { day, plan, streak, trip } from "./time.js";
import { board, chart, people, spending, steps, system } from "./status.js";

export const VISUAL_TOOL = "draw_visual";

/** Each template, and the one line the model reads to fill it. */
const TEMPLATES = {
  compare: [compare, "options ranked on one number against a limit (quotes, plans, prices). {kicker, title, subtitle, limit, lower_is_better (default true), items:[{name, value (number), display ('$225'), detail ('$7.50 a person'), note ('$75 under'), photo, pick, tag}] ≤5, footer}"],
  gallery: [gallery, "things to look at, a photo each: clothes (style editorial), food (style warm, the pick large), gifts or products (style polaroid). {style, kicker, title, items:[{name, price, note, photo, source ('Aritzia'), pick, tag}] ≤4 (warm ≤3), footer}"],
  option: [option, "ONE option per card, for 2-8 options sent together as a swipeable set (one draw_visual call each, numbered): caterers, dresses, hotels, cars. {index, of, kicker, name, price, price_note ('$7.50 a person'), photo, source, facts:[{label, value}] ≤4, note, pick, tag}"],
  versus: [versus, "two things side by side: homes, cars, jobs. {kicker, title, items:[{name, photo, source}] ×2, rows:[{label, a, b, better: 'a'|'b'}] ≤7}"],
  places: [places, "places to go, numbered, a photo each. {kicker, title, items:[{name, detail ('Mexican · $$ · open till 11'), note, distance ('4 min'), distance_label ('walk'), photo, pick}] ≤4, footer}"],
  tickets: [tickets, "flights, trains, shows as ticket cards. {kicker, title, items:[{name ('Delta 1421'), depart, arrive, duration, stops, price, price_label, note, pick, tag}] ≤3, facts:[{label, value}] ≤3}"],
  trip: [trip, "a trip or event by day. {kicker, title, days:[{name, stops:[{time, what, note}] ≤5}] ≤3, chips:[{label, value, tone: 'good'|'warn'}] ≤3}"],
  day: [day, "one day hour by hour. {kicker, title, events:[{start ('9:30'), end, title, note, kind: meeting|free|travel|warn}] ≤9}"],
  plan: [plan, "a plan over weeks as bars. {kicker, title, weeks, today (week number, decimals ok), week_labels, tasks:[{name, who, start (weeks from 0), length (weeks), state: on_track|late|done}] ≤8}"],
  board: [board, "work by status: what's being worked on, a project's tasks. {kicker, title, columns:[{name, tone: blue|warn|good, items:[{name, progress (0-100), note, who}] ≤5}] ≤3}"],
  chart: [chart, "numbers that moved and what moved them: latency, weight, savings. {kicker, title, stats:[{label, value, tone: good|warn}] ≤3 (before → now → goal), bars_title, bars:[{name, value (number), display, state: done|doing|planned}] ≤6}"],
  spending: [spending, "where money went. {kicker, total ('$3,420'), change ('+$310 vs Sept'), title, items:[{name, amount (number), display, note}] ≤7, biggest first}"],
  steps: [steps, "how to do something. {kicker, title, needs, steps:[{title, tip, photo, source}] ≤4}"],
  people: [people, "who is in a meeting or chat. {kicker, title, people:[{name, role, last (when you last talked), ask (what to ask or know), photo, new (true if they've never met)}] ≤5}"],
  system: [system, "how a system, team or process fits together, top to bottom. {kicker, title, layers:[{label, core (true for the middle piece), link (label on the line to the next layer), parts:[{name, note, state: 'missing'}] ≤3}] ≤4}"],
  streak: [streak, "a habit over 5 weeks. {kicker, count, title, marks (35 chars oldest first, Monday first: 1 done, 0 missed, - not yet), facts:[{label, value}] ≤3}"],
};

export const VISUAL_TEMPLATES = Object.keys(TEMPLATES);

export const VISUAL_DEFINITION = {
  name: VISUAL_TOOL,
  description:
    "Turn your answer into one of your designed picture cards, to text them (and keep in the note you write). Pick a template and fill its data; " +
    "short words only, every figure one you read or they told you, never a made-up one (leave it out or write 'ask'). " +
    "photo: an https image address you read in a tool result this turn (a store, menu or listing page's picture), picture:N, attachment:N, or none. " +
    "theme 'dark' or 'light' (default) for the plain ones.\nTemplates:\n" +
    Object.entries(TEMPLATES)
      .map(([name, [, line]]) => `- ${name}: ${line}`)
      .join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      template: { type: "string", enum: VISUAL_TEMPLATES },
      data: { type: "object", description: "The template's fields, as listed for it." },
      theme: { type: "string", enum: ["light", "dark"] },
    },
    required: ["template", "data"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** The page for one visual, at the size it is photographed, or an error the model can act on. */
export function buildVisual(args) {
  const template = typeof args?.template === "string" ? args.template : "";
  if (!Object.hasOwn(TEMPLATES, template)) return { error: `No template "${template.slice(0, 30)}". Pick one of: ${VISUAL_TEMPLATES.join(", ")}.` };
  const data = args?.data && typeof args.data === "object" && !Array.isArray(args.data) ? args.data : null;
  if (data === null) return { error: "Pass the template's fields as data." };
  const theme = args?.theme === "dark" ? "dark" : "light";
  return { html: TEMPLATES[template][0](data, theme), width: CARD_WIDTH * SCALE, height: CARD_HEIGHT * SCALE };
}

/**
 * When to draw, and how short the words get. Two of six signals, counted in
 * the answer Tex is about to give; the words become one line because the
 * picture carries the detail (owner, 2026-10-26).
 */
export const VISUALS_LINE =
  "VISUAL ANSWERS: count these in your answer: 3+ things side by side; numbers to compare; times or dates; places; parts that " +
  "connect or who owns what; things whose looks matter (clothes, food, homes, gifts). Two or more, or they ask to see, compare, plan " +
  "or map: call draw_visual with the template that fits, then text ONE line (25 words at most: verdict and next step) and " +
  "[picture N]; never repeat the card in words. For 2-8 options that each need a photo and facts, draw one option card each " +
  "(index, of) and send them all: they arrive as one swipeable set, answered with a number. Never draw for a yes or no, one fact, " +
  "a draft, hard news, or after they ask for text only. If draw_visual fails, text it all in words, no word of the card. For looks, take photos from the pages you open. To keep the card in a " +
  "note: write with args { images: [{ name: 'card.png', data: 'picture:N' }] } and ![[card.png]] in the content.";
