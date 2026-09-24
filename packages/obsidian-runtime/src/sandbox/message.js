// @ts-check

import { isolateForDisplay } from "../../../shared/src/displayText.cjs";

/**
 * Whether the frame that just fired `load` is still the document we wrote.
 *
 * ## Why a count is the whole answer
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` denies the frame the
 * parent's DOM, and the CSP above denies it `fetch`, workers, child frames,
 * forms, objects and every external asset. **Not one of them stops a document
 * navigating itself.** `allow-top-navigation` governs the *top-level* browsing
 * context, not a frame's own, and the CSP directive that would have covered it
 * — `navigate-to` — was removed from the specification and ships in no engine.
 * So the frame can stop being ours, and the host cannot ask it politely
 * whether it still is: reading `contentWindow.location` across an opaque
 * origin throws, and any answer the frame itself gave would be the untrusted
 * party vouching for itself.
 *
 * What the host *can* see is the `load` event, and that is exact rather than a
 * heuristic. `srcdoc` is written once, from a `useMemo` constant, and is never
 * re-set for the life of the element — so the first load is the document we
 * wrote and any later one is a document somebody else chose.
 *
 * A frame that is no longer ours must be handed nothing further: not the
 * sandbox nonce, not the bundle, and no answer to an `rpc` it sends. After a
 * navigation `event.source` still equals `frame.contentWindow`, so identity
 * alone stops distinguishing the successor from the original — this count is
 * what the host has instead.
 *
 * Native needs no equivalent because it refuses the navigation outright
 * (`originWhitelist` plus `onShouldStartLoadWithRequest`); a WebView can be
 * told what it may load, an iframe cannot.
 *
 * @param {number} loadCount How many `load` events this element has fired.
 */
export function sandboxFrameIsOurs(loadCount) {
  return loadCount === 1;
}

/**
 * How many suggestions one plugin may offer for one line.
 *
 * A completion menu is a list somebody arrows through under time pressure, not
 * a search result page; past a handful it stops being faster than typing. The
 * guest stops at this and the host truncates whatever arrives anyway, because a
 * cap the untrusted half applies to itself is not a cap.
 */
export const SUGGEST_MAX = 8;

/**
 * How many status bar items one plugin may put on its card.
 *
 * Obsidian imposes no limit and neither does the shim's own list — this is the
 * console's, because the items are drawn in a card beside the Stop button and a
 * plugin that added forty of them would push it off the screen. Enforced on
 * both sides: the guest stops reporting past this, and the host truncates
 * anything that arrives anyway, because the guest is the untrusted half and a
 * cap it applies to itself is not a cap.
 */
export const STATUS_BAR_MAX = 8;

/** How many instruction rows a dialog may put under its list. */
export const SUGGEST_MODAL_INSTRUCTIONS_MAX = 6;

/**
 * What a plain `Modal` may put on screen, bounded on the trusted side.
 *
 * The guest applies the same numbers to itself, and that is not where the cap
 * lives: a bound the untrusted half enforces is a bound it can drop. These are
 * the ones that decide what is drawn.
 */
/**
 * What one plugin settings pane may put on screen.
 *
 * Twins of the numbers the guest applies to itself. These are the ones that
 * decide, for the reason STATUS_BAR_MAX states: a bound the untrusted half
 * enforces is a bound it can drop.
 */
export const SETTING_TEXT_CAP = 200;
export const SETTING_DESC_CAP = 600;
export const SETTING_VALUE_CAP = 400;
export const SETTING_OPTIONS_CAP = 60;
export const SETTING_ROWS_CAP = 120;

export const TEXT_MODAL_TITLE_CAP = 200;
export const TEXT_MODAL_TEXT_CAP = 8000;

/**
 * How many links one preview query covers, and how long one preview may be.
 *
 * The link cap bounds what the *host* sends: a long note can hold hundreds of
 * external links, and asking a plugin to fetch every one of them on open is a
 * request neither the person nor the site they are hitting asked for. The first
 * two dozen is what somebody is actually reading.
 *
 * The text cap bounds what the *guest* sends back, and that half is the one
 * that matters for safety — a preview is entirely the plugin's words, drawn in
 * a tooltip over somebody's own note. Enforced on both sides for the reason
 * `STATUS_BAR_MAX` is: a cap the untrusted half applies to itself is not a cap.
 */
export const PREVIEW_LINKS_MAX = 24;
export const PREVIEW_TEXT_MAX = 400;

/**
 * Why a piece of a plugin's work did not land, as a word rather than a sentence.
 *
 * A closed set, and that is the whole point of it being one. Every one of these
 * ends with the console telling somebody why the thing they pressed did
 * nothing, and a sentence carried up from the guest would be the plugin writing
 * Context's error message — over a refusal that is often *about* that plugin.
 * So the guest names which of three cases it is, and the console keeps the
 * words: the worst a lying guest achieves is the wrong one of three.
 *
 * - `no-note` — it reached for the open note and there was none.
 * - `not-allowed` — the owner has not given it that reach; a grant fixes it.
 * - `failed` — it threw, or the write did. The plugin's own problem.
 */
export const PLUGIN_WORK_REASONS = Object.freeze(["no-note", "not-allowed", "failed"]);

/** @param {unknown} value */
function workReason(value) {
  return typeof value === "string" && PLUGIN_WORK_REASONS.includes(
    /** @type {typeof PLUGIN_WORK_REASONS[number]} */ (value),
  )
    ? /** @type {"no-note" | "not-allowed" | "failed"} */ (value)
    : null;
}

/**
 * A plugin-authored string, bounded and then CONTAINED.
 *
 * Every string below this line is the plugin's own words drawn where Context
 * speaks in its own voice — a card beside the Stop button, a notice, a dialog
 * with the plugin's name on it. They were bounded by length alone, and length
 * is not the hazard: one U+202E reverses the rendering of everything after it,
 * so a plugin could reach out of its own card and rearrange the row holding
 * the control somebody presses to stop it.
 *
 * `isolateForDisplay` contains rather than cleans, and
 * `packages/shared/src/displayText.cjs` carries the argument for why that is
 * the stronger of the two. The cap is applied first so it measures the text
 * rather than the container.
 *
 * **Not applied to everything the guest sends.** An id, an href and a setting
 * value are matched, compared and addressed rather than read, and
 * `suggest-applied`'s line is typed into somebody's note by the trusted
 * editor — putting an invisible character into a person's own file to protect
 * a label would be the wrong trade in the wrong direction.
 *
 * @param {string} text
 * @param {number} cap
 */
function display(text, cap) {
  return isolateForDisplay(text.slice(0, cap));
}

/**
 * Strictly recognize messages that may cross from the untrusted frame.
 * @param {unknown} value
 * @param {string} expectedNonce
 */
export function parsePluginSandboxMessage(value, expectedNonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  if (row.source !== "context-plugin-sandbox" || row.version !== 1) return null;
  if (row.type === "ready") return { type: "ready" };
  if (row.nonce !== expectedNonce) return null;
  switch (row.type) {
    case "loaded":
    case "unloaded":
      return { type: row.type };
    case "rpc":
      return row.request && typeof row.request === "object"
        ? { type: "rpc", request: row.request }
        : null;
    case "crashed":
      return typeof row.code === "string" && typeof row.message === "string"
        ? {
            type: "crashed",
            code: display(row.code, 80),
            message: display(row.message, 500),
          }
        : null;
    case "notice":
      return typeof row.message === "string"
        ? { type: "notice", message: display(row.message, 500) }
        : null;
    /*
      The guest's answer to a host `command`.

      Nonce-checked above with everything else observable, and for the same
      reason: a forged result would report a command as run that never was, or
      report success for one that threw. `ok` is required to be a boolean
      rather than coerced — a message that simply omits it is malformed, and
      treating a missing field as failure would invent an outcome the guest
      never claimed.
    */
    case "command-result":
      return typeof row.id === "string" && typeof row.ok === "boolean"
        ? {
            type: "command-result",
            id: row.id.slice(0, 100),
            ok: row.ok,
            error: typeof row.error === "string" ? display(row.error, 500) : null,
            /*
              And why, when the why is one Context can state better than the
              plugin can. A command that asked for the open note and could not
              have it did not malfunction, and the card saying "it failed" over
              a grant the owner simply has not given would send somebody
              looking for a bug.
            */
            reason: workReason(row.reason),
          }
        : null;
    /*
      Everything the plugin currently has in its status bar.

      **A whole list every time, not an add and a remove.** The alternative
      needs the guest to report a removal, and a guest that is torn down, throws
      mid-render, or simply forgets leaves a line on the console describing an
      item that no longer exists — the same stale-claim failure the
      registrations card was careful to avoid, one layer down. Replacing the
      list makes the console's copy unable to drift from the guest's.

      Truncated rather than refused, unlike a malformed entry. Nine items is a
      plugin being greedy and the eight before it are real; an entry without a
      string `text` is not something the shim can produce, so the message is
      dropped whole.
    */
    case "status-bar": {
      if (!Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.id !== "string" || typeof one.text !== "string") return null;
        if (items.length >= STATUS_BAR_MAX) continue;
        items.push({ id: one.id.slice(0, 60), text: display(one.text, 120) });
      }
      return { type: "status-bar", items };
    }
    /*
      What the plugin offered for the line the host asked about.

      Text only, bounded twice like the status bar, and nonce-authenticated like
      every observable event: a forged list would put words into a completion
      menu the person is about to accept into their own note.

      `seq` is required and carried back unchanged. Typing is faster than a
      round trip, so a result that arrives after the line has moved on must be
      *droppable* — the host compares the sequence it asked with the one that
      came back and ignores anything stale. Without it a suggestion computed for
      a line nobody is on any more would be offered for the line they are.
    */
    case "suggest-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.text !== "string") return null;
        if (items.length >= SUGGEST_MAX) continue;
        items.push({ text: display(one.text, 200) });
      }
      return { type: "suggest-results", seq: row.seq, items };
    }
    /*
      A plugin opened or closed its suggestion dialog.

      The console draws the dialog, so this is the plugin asking for one rather
      than announcing one it made. Nonce-authenticated like every observable
      event: a forged open would put a dialog carrying somebody else's
      placeholder in front of a reader, over a plugin's name.

      `placeholder` and the instruction rows are the plugin's own text, bounded
      here as well as in the guest — a cap the untrusted half applies to itself
      is not a cap, which is the rule `STATUS_BAR_MAX` already states.
    */
    case "suggest-modal": {
      if (typeof row.open !== "boolean") return null;
      const instructions = [];
      for (const entry of Array.isArray(row.instructions) ? row.instructions : []) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.command !== "string" || typeof one.purpose !== "string") return null;
        if (instructions.length >= SUGGEST_MODAL_INSTRUCTIONS_MAX) continue;
        instructions.push({
          command: display(one.command, 40),
          purpose: display(one.purpose, 120),
        });
      }
      return {
        type: "suggest-modal",
        open: row.open,
        placeholder: typeof row.placeholder === "string" ? display(row.placeholder, 120) : "",
        instructions,
      };
    }
    /*
      A plain text dialog, opened or closed.

      `Modal` has no query and no pick, so unlike `suggest-modal` there is
      nothing to route back — the console draws the title and the body and
      offers a way out. The text is re-sent on every mutation of the dialog's
      own DOM, because a plugin may fill it asynchronously and the one this was
      written for does.

      Bounded here as well as in the guest, for `suggest-modal`'s reason: a cap
      the untrusted half applies to itself is not a cap.
    */
    /*
      A plugin says it has a settings pane. One bit, and it only ever turns a
      control on: the console draws a Settings button on that plugin's row.
      Nothing about the pane's contents rides on this.
    */
    case "settings-tab":
      return row.present === true ? { type: "settings-tab" } : null;
    /*
      The pane itself, as rows to draw.

      Every bound the guest applies to itself is applied again here, for the
      reason STATUS_BAR_MAX states: a cap the untrusted half enforces is not a
      cap. A row whose shape does not hold is dropped rather than failing the
      whole pane — one malformed control must not take away a reader's access
      to the other forty.

      `index` is checked against the row's own position in the accepted list
      rather than trusted: it is what a change is addressed by, so a guest that
      renumbered its rows could otherwise point a reader's toggle at a
      different setting than the one they pressed.
    */
    case "settings-pane": {
      if (typeof row.open !== "boolean") return null;
      // `error: null` here as well as on the open branch: the field is part of
      // the message's shape, and a consumer should not have to ask which branch
      // it came from before reading it.
      if (!row.open) return { type: "settings-pane", open: false, rows: [], error: null };
      /*
        What `display()` threw, carried rather than dropped.

        The comment on the closed branch above says this field is on both, and
        for a while only that branch had it — which cost twice. A pane that
        stopped part-way said nothing, so the rows it managed to draw looked
        like the whole pane: exactly the failure the banner exists to prevent,
        and the one a missing `hide()` really produced. And a pane that ran to
        the end arrived with `error` absent rather than null, so the console's
        `=== null` test was false and every healthy pane drew the banner with
        the word "undefined" in it.
      */
      const error = typeof row.error === "string" && row.error
        ? display(row.error, SETTING_DESC_CAP)
        : null;
      const rows = [];
      let controls = 0;
      for (const entry of Array.isArray(row.rows) ? row.rows : []) {
        if (rows.length >= SETTING_ROWS_CAP) break;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const one = /** @type {Record<string, unknown>} */ (entry);
        const kind = one.kind;
        if (kind === "heading") {
          const text = typeof one.text === "string" ? display(one.text, SETTING_TEXT_CAP) : "";
          const level = typeof one.level === "number" && one.level >= 1 && one.level <= 6
            ? Math.round(one.level)
            : 2;
          if (text) rows.push({ kind: "heading", level, text });
          continue;
        }
        if (kind === "note") {
          const text = typeof one.text === "string" ? display(one.text, SETTING_DESC_CAP) : "";
          if (text) rows.push({ kind: "note", text });
          continue;
        }
        if (kind !== "toggle" && kind !== "text" && kind !== "dropdown" &&
            kind !== "button" && kind !== "slider") {
          continue;
        }
        if (one.index !== controls) continue;
        const name = typeof one.name === "string" ? display(one.name, SETTING_TEXT_CAP) : "";
        const desc = typeof one.desc === "string" ? display(one.desc, SETTING_DESC_CAP) : "";
        const label = typeof one.label === "string" ? display(one.label, SETTING_TEXT_CAP) : "";
        const placeholder = typeof one.placeholder === "string"
          ? display(one.placeholder, SETTING_TEXT_CAP)
          : "";
        const options = [];
        for (const option of Array.isArray(one.options) ? one.options : []) {
          if (options.length >= SETTING_OPTIONS_CAP) break;
          if (!option || typeof option !== "object") continue;
          const pair = /** @type {Record<string, unknown>} */ (option);
          if (typeof pair.value !== "string" || typeof pair.label !== "string") continue;
          options.push({
            value: pair.value.slice(0, SETTING_VALUE_CAP),
            label: display(pair.label, SETTING_TEXT_CAP),
          });
        }
        const value = kind === "toggle"
          ? one.value === true
          : kind === "slider"
            ? (typeof one.value === "number" && Number.isFinite(one.value) ? one.value : 0)
            : (typeof one.value === "string" ? one.value.slice(0, SETTING_VALUE_CAP) : "");
        rows.push({
          kind,
          index: controls,
          name,
          desc,
          label,
          placeholder,
          value,
          disabled: one.disabled === true,
          // Only a dropdown has options, and saying so here rather than
          // sending an empty array on everything else keeps the wire shape and
          // the console's own type describing the same thing.
          ...(kind === "dropdown" ? { options } : {}),
        });
        controls += 1;
      }
      return { type: "settings-pane", open: true, rows, error };
    }
    case "text-modal": {
      if (typeof row.open !== "boolean") return null;
      return {
        type: "text-modal",
        open: row.open,
        title: typeof row.title === "string" ? display(row.title, TEXT_MODAL_TITLE_CAP) : "",
        text: typeof row.text === "string" ? display(row.text, TEXT_MODAL_TEXT_CAP) : "",
      };
    }
    /*
      What the open dialog would show for the query the reader typed.

      The same shape and the same bounds as `suggest-results`, and `seq` carries
      the same weight: typing outruns the round trip, so a list computed for a
      query nobody is on any more must be droppable rather than drawn.
    */
    case "suggest-modal-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.text !== "string") return null;
        if (items.length >= SUGGEST_MAX) continue;
        items.push({ text: display(one.text, 200) });
      }
      return { type: "suggest-modal-results", seq: row.seq, items };
    }
    /*
      The pick landed, and whether the plugin opened another dialog while
      handling it.

      `reopened` is not a convenience: `onChooseSuggestion` runs in the guest and
      may call `open()` again — a two-step flow picks a translation and then a
      verse — so a console that closed unconditionally on a pick would shut the
      dialog the plugin had just asked for. Required as a boolean rather than
      coerced, for `command-result`'s reason: a missing field would invent an
      answer the guest never gave.
    */
    case "suggest-modal-picked":
      return typeof row.seq === "number" && typeof row.reopened === "boolean"
        ? {
            type: "suggest-modal-picked",
            seq: row.seq,
            reopened: row.reopened,
            /*
              Whether the pick landed. Every way it does not looks the same from
              where the reader is sitting — the row was pressed, the dialog
              closed, the note did not change — so this is what turns that into
              a sentence. `null` is the ordinary case: it worked, or the plugin
              never wanted the note in the first place.
            */
            reason: workReason(row.reason),
          }
        : null;
    /*
      The line the plugin's own selectSuggestion produced.

      The *trusted* editor makes this edit, through its own editing path, which
      is why a suggester needs no write grant: it is the person typing, and it
      undoes like anything else they typed. Bounded, because the guest wrote it.
    */
    case "suggest-applied":
      return typeof row.seq === "number" && typeof row.line === "string"
        ? { type: "suggest-applied", seq: row.seq, line: row.line.slice(0, 4000) }
        : null;
    /*
      What a plugin's markdown post-processor attached to each link.

      Text keyed to an href, bounded twice, nonce-authenticated like every
      other observable event. A forged one would put a plugin's words — or
      anybody's — into a tooltip over a person's own note, next to a link they
      wrote, with the plugin's name on it.

      The href is echoed rather than indexed, because the guest may answer for
      a subset: a processor that ignored a link reports nothing for it, and a
      positional list would silently shift every remaining preview onto the
      wrong link. `seq` is carried back unchanged for the same reason a
      suggestion's is — a note can be closed or edited while a verse is being
      fetched.
    */
    case "preview-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.previews)) return null;
      const previews = [];
      for (const entry of row.previews) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.href !== "string" || typeof one.text !== "string") return null;
        if (previews.length >= PREVIEW_LINKS_MAX) continue;
        previews.push({ href: one.href.slice(0, 2000), text: display(one.text, PREVIEW_TEXT_MAX) });
      }
      return { type: "preview-results", seq: row.seq, previews };
    }
    case "registration":
      return (row.kind === "command" || row.kind === "ribbon") &&
        typeof row.id === "string" &&
        typeof row.name === "string"
        ? {
            type: "registration",
            kind: row.kind,
            id: row.id.slice(0, 100),
            name: display(row.name, 200),
            /*
              Absent means false, deliberately. A guest older than this field
              reports nothing, and reading that as "takes an editor" would
              disable every command on every card at once. False restores
              exactly the previous behaviour, and the guest still refuses the
              call itself, so the worst case is the error we already had.
            */
            needsEditor: row.needsEditor === true,
          }
        : null;
    default:
      return null;
  }
}
