/**
 * THE BENCH'S DRAWN PICTURES, AND THE LOOK TEX TAKES AT THEM.
 *
 * The bench cannot render a card: its browser Worker answers `/render` with a white picture of the size asked for
 * (`sites.mjs` blankPng). Tex looks at every picture before it sends one (`src/agent/cardCheck.js`): a small model is
 * shown the picture and holds back one that does not answer. Shown a white rectangle it rightly says so, twice
 * (`MAX_HELD`), and `draw_visual` comes back "Not sent" both times: every card in the bench failed on the bench's own
 * stand-in, and the judge graded Tex on "I couldn't make the picture" (Training, 2026-11-18: "draw_visual failed
 * twice"). The look is real only when the picture is. So the bench remembers each picture it drew, and answers the
 * look at one of those itself, as passed: the model that looks never sees the stand-in. Every other picture (one a
 * person sent, one the picture model made) is looked at as in production.
 */

/** The pictures the bench drew this conversation: `keep(png)` one, `isIn(text)` whether a request's words carry one. */
export function drawnPictures() {
  const drawn = new Set();
  return {
    keep(png) {
      if (typeof png === "string" && png.length > 0) drawn.add(png);
    },
    isIn: (text) => typeof text === "string" && [...drawn].some((png) => text.includes(png)),
    count: () => drawn.size,
  };
}

/** `env.SITE_SHOTS` with every picture its `/render` drew kept in `drawn`. */
export function keepsRenders(binding, drawn) {
  return {
    async fetch(url, init) {
      const response = await binding.fetch(url, init);
      if (new URL(url).pathname === "/render" && response.status === 200) drawn.keep((await response.clone().json().catch(() => null))?.png);
      return response;
    },
  };
}

/** A look that passes, as the model's answer to the card check (`cardCheck.js` readVerdict). */
const PASSED = { id: "msg_bench_card", type: "message", role: "assistant", content: [{ type: "text", text: '{"send": true, "critique": ""}' }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

/** How the card check names the picture it is shown (`cardCheck.js`): only its own call says this. */
const LOOK = "TEX'S PICTURE (";

/**
 * A model transport that answers a look at one of the bench's own drawn pictures as passed, and sends every other
 * call on. `looks` counts the ones it answered.
 */
export function looksPastDrawn(send, drawn, looks = { n: 0 }) {
  return async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (drawn.count() > 0 && body.includes(LOOK) && drawn.isIn(body)) {
      looks.n += 1;
      return new Response(JSON.stringify(PASSED), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return send(url, init);
  };
}
