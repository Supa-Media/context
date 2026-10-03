/**
 * The stylesheet every designed page starts from, before the site's own.
 *
 * Ours and trusted, so it is written already scoped. It makes a site that has
 * only a layout, or only a few lines of CSS, readable: a column of text, the
 * default frame laid out, pictures that fit. The variables are the ones a
 * site's `:root` usually sets, so overriding a colour is one line.
 */

import { SITE_SCOPE as S } from "./template";

export const SITE_BASE_CSS = [
  `${S} { --bg: #ffffff; --text: #1c1c1e; --muted: #6b6b70; --accent: #2457d6; --line: #e5e5ea; --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --heading-font: var(--font); --width: 44rem; display: block; min-height: 100vh; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 17px; line-height: 1.6; -webkit-font-smoothing: antialiased; }`,
  `${S} *, ${S} *::before, ${S} *::after { box-sizing: border-box; }`,
  `${S} h1, ${S} h2, ${S} h3, ${S} h4 { font-family: var(--heading-font); line-height: 1.2; margin: 1.6em 0 0.5em; }`,
  `${S} h1 { font-size: 2.4em; margin-top: 0.4em; }`,
  `${S} p, ${S} ul, ${S} ol, ${S} blockquote, ${S} pre, ${S} table, ${S} figure { margin: 0 0 1em; }`,
  `${S} a { color: var(--accent); }`,
  `${S} img { max-width: 100%; height: auto; }`,
  `${S} pre { overflow-x: auto; padding: 1em; background: rgba(127, 127, 127, 0.1); border-radius: 8px; }`,
  `${S} code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }`,
  `${S} blockquote { padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }`,
  `${S} table { border-collapse: collapse; }`,
  `${S} th, ${S} td { padding: 0.4em 0.8em; border-bottom: 1px solid var(--line); text-align: left; }`,
  `${S} hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }`,
  `${S} .site-header { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; max-width: var(--width); margin: 0 auto; padding: 1.5rem 1.25rem; }`,
  `${S} .site-name { font-weight: 600; color: var(--text); text-decoration: none; }`,
  `${S} .site-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; }`,
  `${S} .site-nav a { color: var(--muted); text-decoration: none; }`,
  `${S} .site-nav a.current { color: var(--text); }`,
  `${S} .site-main { max-width: var(--width); margin: 0 auto; padding: 1rem 1.25rem 4rem; }`,
  `${S} .site-footer { max-width: var(--width); margin: 0 auto; padding: 2rem 1.25rem; color: var(--muted); font-size: 0.9em; }`,
  `${S} p.buttons { display: flex; gap: 0.75rem; flex-wrap: wrap; }`,
  `${S} a.button { display: inline-block; padding: 0.6em 1.1em; border-radius: 999px; background: var(--accent); color: var(--bg); text-decoration: none; }`,
  `${S} img.emoji { height: 1.2em; width: auto; vertical-align: -0.2em; }`,
].join("\n");
