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

function fromParent(event) {
  return event.source === window.parent && event.data && event.data.channel === CHANNEL;
}

function tell(message) {
  window.parent.postMessage({ channel: CHANNEL, ...message }, "*");
}

let drawn = false;

window.addEventListener("message", (event) => {
  if (!fromParent(event) || event.data.type !== "box" || drawn) return;
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
new ResizeObserver(report).observe(document.documentElement);

tell({ type: "ready" });
