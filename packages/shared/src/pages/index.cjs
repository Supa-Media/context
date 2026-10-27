/**
 * Pages: a note named `<name>.page.md`, drawn as a page people read, edit and
 * comment on, and the format Tex writes its finished work in. The format is
 * `parse.cjs`, the block kinds `blocks.cjs`, the drawing `render.cjs` and
 * `css.cjs`, and what a page may change in its own note `edits.cjs`.
 * Decision: `docs/decisions/app-and-console/pages.md`.
 *
 * CommonJS like `comments.cjs`, so the gateway (plain JavaScript), the app and
 * the page runtime read one copy.
 */

const parse = require("./parse.cjs");
const blocks = require("./blocks.cjs");
const inline = require("./inline.cjs");
const render = require("./render.cjs");
const css = require("./css.cjs");
const edits = require("./edits.cjs");

module.exports = { ...parse, ...blocks, ...inline, ...render, ...css, ...edits };
