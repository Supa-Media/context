/**
 * The panel, rendered from `UiState` and nothing else.
 *
 * Four states, from the same markup: nothing detected, a meeting detected and
 * waiting for an answer, a recording in progress, and a permission the person
 * refused. It is written with `textContent` throughout and never with
 * `innerHTML`: half of what this window shows is a window title or a calendar
 * summary, which is text somebody else wrote, and the panel is the one surface
 * where that text is quoted back.
 */

import type { UiState } from "../main/ipc.ts";


const root = document.getElementById("panel");

const TICK =
  'M20 7L10 17l-5-5';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tick(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "var(--ok)");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", TICK);
  svg.append(path);
  return svg;
}

function header(state: UiState): HTMLElement {
  const section = element("section", "head");
  const status = element("div", "status row");
  const recording = state.session?.capturing === true;
  status.dataset["tone"] = recording ? "recording" : state.detection ? "detected" : "idle";
  status.append(element("span", "dot"));
  status.append(
    element(
      "span",
      "eyebrow",
      recording ? "Recording" : state.detection ? "Meeting detected" : "Watching for meetings",
    ),
  );
  section.append(status);

  const title = element("h1", "title");
  title.textContent =
    state.session?.title ?? state.detection?.suggestedTitle ?? "Nothing right now";
  section.append(title);

  const summary = element("p", "summary");
  summary.textContent = state.detection?.summary ?? "The menu bar will say when a meeting starts.";
  section.append(summary);

  section.append(actions(state));
  return section;
}

function actions(state: UiState): HTMLElement {
  const row = element("div", "actions");

  if (state.session && (state.session.state === "recording" || state.session.state === "paused")) {
    const paused = state.session.state === "paused";
    const toggle = element("button", "ghost", paused ? "Resume" : "Pause");
    toggle.addEventListener("click", () => (paused ? window.context.resume() : window.context.pause()));
    const end = element("button", "cta", "");
    end.append(element("span", "", "End & write up"));
    end.addEventListener("click", () => window.context.end());
    row.append(end, toggle);
    return row;
  }

  if (state.detection?.episode) {
    const episode = state.detection.episode;
    const accept = element("button", "cta");
    accept.append(element("span", "rec"), element("span", "", "Take notes"));
    accept.addEventListener("click", () => window.context.accept(episode));
    const decline = element("button", "ghost", "Not now");
    decline.addEventListener("click", () => window.context.decline(episode));
    row.append(accept, decline);
  }

  return row;
}

function evidence(state: UiState): HTMLElement | null {
  if (!state.detection || state.detection.evidence.length === 0) return null;
  const section = element("section", "evidence");
  section.append(element("div", "eyebrow", "What it noticed"));
  const list = element("ul");
  for (const line of state.detection.evidence) {
    const item = element("li");
    item.append(tick(), element("span", "", line));
    list.append(item);
  }
  section.append(list);
  if (state.detection.degradedNotice) {
    section.append(element("p", "notice", state.detection.degradedNotice));
  }
  return section;
}

function permissions(state: UiState): HTMLElement | null {
  if (state.missingPermissions.length === 0) return null;
  const section = element("section");
  const names = state.missingPermissions
    .map((kind) => (kind === "screen" ? "Screen Recording" : "the microphone"))
    .join(" and ");
  section.append(
    element(
      "p",
      "notice",
      `macOS has not granted ${names}. Nothing can be recorded until it does — open System Settings › Privacy & Security to change it.`,
    ),
  );
  return section;
}

function settings(state: UiState): HTMLElement {
  const section = element("section", "settings");

  const ask = element("div", "setting");
  ask.append(element("span", "", "Ask before every meeting"));
  const toggle = element("button", "switch");
  toggle.dataset["on"] = String(state.settings.askBeforeEveryMeeting);
  toggle.setAttribute("aria-pressed", String(state.settings.askBeforeEveryMeeting));
  toggle.append(element("span"));
  toggle.addEventListener("click", () =>
    window.context.setAskBeforeEveryMeeting(!state.settings.askBeforeEveryMeeting),
  );
  ask.append(toggle);
  section.append(ask);

  const blocked = element("div", "setting");
  blocked.append(element("span", "", "Never record these apps"));
  const count = state.settings.blocklist.length;
  blocked.append(element("span", "value", count === 0 ? "none yet" : `${count} set`));
  section.append(blocked);

  section.append(
    element(
      "p",
      "footnote",
      "Nothing joins the call. This machine captures system audio and your microphone locally — the people in the meeting see one fewer participant than they would with a bot.",
    ),
  );
  return section;
}

function render(state: UiState): void {
  if (!root) return;
  root.replaceChildren();
  root.append(header(state));
  const noticed = evidence(state);
  if (noticed) root.append(noticed);
  const missing = permissions(state);
  if (missing) root.append(missing);
  root.append(settings(state));
}

window.context.onState(render);
