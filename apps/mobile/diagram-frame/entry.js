/**
 * The Mermaid diagram renderer, as a page of its own.
 *
 * Like the drawing editor beside it, this is **not** part of the console
 * application. `scripts/build-drawing-editor.mjs` builds it into
 * `public/drawing-assets/diagram/`, and the console loads it in an `<iframe>`
 * per ```` ```mermaid ```` fence. `features/console/files/livePreview/diagram.ts`
 * is the other half and carries the argument for the shape; the short version:
 *
 *  - **Mermaid is 3.5MB of script**, and a dynamic `import()` under Expo's Metro
 *    lands in the eagerly loaded `__common` bundle (measured for Excalidraw —
 *    see `drawing-editor/entry.jsx`). Served as a page it is fetched the first
 *    time somebody opens a note with a diagram, and cached after that.
 *  - **The diagram source may have been written by a stranger** — anyone can
 *    email `<name>@context.lc` — and Mermaid has shipped XSS fixes before. So it
 *    never runs in the console's document. The frame is `sandbox="allow-scripts"`
 *    without `allow-same-origin`: an opaque origin, with no cookies, no storage,
 *    no way into the console's DOM, and this page's CSP refuses every network
 *    request beyond its own script.
 *
 * ## The whole protocol
 *
 * Three messages, all on one channel name, all checked against the window they
 * claim to come from:
 *
 *   frame → console  { type: "ready" }
 *   console → frame  { type: "render", source, theme }
 *   frame → console  { type: "rendered", height } | { type: "error", message }
 *
 * The console may send `render` again (the palette changed); the frame redraws.
 * Nothing the frame says can change a note: it reports a height or an error,
 * and the console accepts a clamped number or a short string.
 */

import mermaid from "mermaid";

const CHANNEL = "context-diagram";

/**
 * Only the parent may ask for a drawing. The frame is opaque-origin, so there is
 * no origin to compare; the window identity is the check, and it is the same
 * one the console makes in the other direction.
 */
function fromParent(event) {
  return event.source === window.parent && event.data && event.data.channel === CHANNEL;
}

function tell(message) {
  // "*" because a sandboxed frame cannot name the console's origin, and nothing
  // sent here is secret: a height, or Mermaid's complaint about the source.
  window.parent.postMessage({ channel: CHANNEL, ...message }, "*");
}

/**
 * The theme the console's palette maps to.
 *
 * `base` is the one Mermaid theme that takes its colours from variables, so the
 * diagram is drawn in the note's own ink rather than Mermaid's purple. Any
 * colour Mermaid cannot parse throws; the caller falls back to the stock
 * `default`/`dark` theme rather than drawing nothing.
 */
function themed(theme) {
  const variables = {
    darkMode: theme.dark,
    background: theme.background,
    fontFamily: theme.fontFamily,
    primaryColor: theme.raised,
    primaryTextColor: theme.text,
    primaryBorderColor: theme.line,
    secondaryColor: theme.raised,
    tertiaryColor: theme.background,
    lineColor: theme.muted,
    textColor: theme.text,
    mainBkg: theme.raised,
    nodeBorder: theme.line,
    clusterBkg: theme.background,
    clusterBorder: theme.line,
    edgeLabelBackground: theme.background,
    titleColor: theme.text,
    noteBkgColor: theme.raised,
    noteTextColor: theme.text,
    noteBorderColor: theme.line,
    actorBkg: theme.raised,
    actorBorder: theme.line,
    actorTextColor: theme.text,
    signalColor: theme.muted,
    signalTextColor: theme.text,
  };
  // A token the console could not read arrives empty; Mermaid's own value stands.
  const themeVariables = Object.fromEntries(
    Object.entries(variables).filter(([, value]) => value !== "" && value !== undefined),
  );
  return { theme: "base", themeVariables };
}

function configure(overrides) {
  mermaid.initialize({
    startOnLoad: false,
    // Mermaid's own guard, kept on even though the frame is the real boundary:
    // it encodes HTML in labels and disables `click` callbacks.
    securityLevel: "strict",
    // Mermaid's error drawing is a bomb icon appended to <body>; the console
    // draws its own quieter message from the `error` reply instead.
    suppressErrorRendering: true,
    ...overrides,
  });
}

let drawing = 0;

async function draw(source, theme) {
  const ticket = ++drawing;
  const stage = document.getElementById("stage");
  let svg;
  try {
    configure(themed(theme));
    ({ svg } = await mermaid.render(`d${ticket}`, source));
  } catch (first) {
    try {
      // The note's palette is the nicety; the diagram is the point.
      configure({ theme: theme.dark ? "dark" : "default" });
      ({ svg } = await mermaid.render(`d${ticket}`, source));
    } catch {
      if (ticket !== drawing) return;
      const message = first instanceof Error ? first.message : String(first);
      tell({ type: "error", message: message.slice(0, 300) });
      return;
    }
  }
  if (ticket !== drawing) return;
  document.documentElement.style.colorScheme = theme.colorScheme;
  stage.innerHTML = svg;
  // Mermaid leaves its measuring nodes behind on a parse error; on success the
  // stage is the only thing in the body worth measuring.
  const height = Math.ceil(stage.getBoundingClientRect().height);
  tell({ type: "rendered", height });
}

window.addEventListener("message", (event) => {
  if (!fromParent(event)) return;
  const { type, source, theme } = event.data;
  if (type !== "render" || typeof source !== "string" || theme === null || typeof theme !== "object") return;
  void draw(source, theme);
});

tell({ type: "ready" });
