/**
 * One ```` ```box ```` fence of a page: the note's own HTML, CSS and script,
 * drawn in a frame of its own.
 *
 * The page runtime (`entry.js`) loads this page in an
 * `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so the box
 * has an opaque origin: no cookies, no storage, no reach into the page around
 * it or the app around that. Its CSP (`box.html`, from
 * `scripts/build-drawing-editor.mjs`) lets the box run inline script and
 * styles and load nothing from anywhere, so a box cannot fetch, beacon or
 * phone home with the words it was handed. It is given the page's blocks as
 * `window.page`, read-only data, and the runtime reads nothing back from it
 * but its height.
 *
 * Scripts are added as new `<script>` elements so they run in order, the way
 * a page's own scripts would; `innerHTML` alone never runs them.
 */

const CHANNEL = "context-page-box";

/**
 * The box draws only where the runtime puts it: an `<iframe sandbox="allow-scripts">`
 * with no `allow-same-origin`, whose origin is opaque and reads as "null".
 *
 * It runs the HTML its parent hands it, scripts and all, and it cannot check
 * who that parent is — across an opaque origin there is no origin to compare.
 * That is safe only while the box is opaque itself. This file is served with
 * no framing header, because neither `X-Frame-Options` nor `frame-ancestors`
 * can match an opaque ancestor and both would blank every box
 * (`infra/router/src/securityHeaders.ts`), so any page may frame it — and one
 * that leaves the sandbox off would get a real document of the site this file
 * came from, still talking to a parent the box cannot check. So when the box
 * can see a real origin of its own, it is not where it belongs: it draws
 * nothing and says nothing.
 */
const SEALED = (() => {
  try {
    return typeof window.origin !== "string" || window.origin === "null" || window.origin === "";
  } catch {
    return true;
  }
})();

function fromParent(event) {
  return event.source === window.parent && event.data && event.data.channel === CHANNEL;
}

function tell(message) {
  window.parent.postMessage({ channel: CHANNEL, ...message }, "*");
}

let drawn = false;

window.addEventListener("message", (event) => {
  if (!SEALED || !fromParent(event) || event.data.type !== "box" || drawn) return;
  drawn = true;
  const data = JSON.parse(JSON.stringify(event.data.page ?? {}));
  Object.defineProperty(window, "page", { value: deepFreeze(data), writable: false, configurable: false });
  const template = document.createElement("template");
  template.innerHTML = String(event.data.html ?? "");
  const scripts = [];
  for (const script of template.content.querySelectorAll("script")) {
    scripts.push(script.textContent);
    script.remove();
  }
  document.body.appendChild(template.content);
  for (const text of scripts) {
    const script = document.createElement("script");
    script.textContent = text;
    document.body.appendChild(script);
  }
  report();
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

let last = -1;
function report() {
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (height === last) return;
  last = height;
  tell({ type: "height", height });
}
if (SEALED) {
  new ResizeObserver(report).observe(document.documentElement);
  tell({ type: "ready" });
}
