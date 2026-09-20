/**
 * The Context plugins that ship with the product.
 *
 * ## Why these are plugins at all
 *
 * Forms, images, meetings, chat days and contacts were each built as a
 * feature *of the app* — a tool in the gateway, a widget in the editor, a card
 * in the console — while the only thing this product called a "plugin" was
 * somebody else's Obsidian bundle. That split is arbitrary from the customer's
 * side: a person looking for "the forms thing" and a person looking for
 * Templater are asking the same question, and they had two different screens,
 * two vocabularies, and one of them had no off switch at all.
 *
 * So a Context plugin is declared here in **Obsidian's manifest shape**, listed
 * beside the vault's plugins, and can be turned off. What it is *not* is a
 * bundle: nothing in this file is downloaded, stored in a bucket or executed
 * from one. The code ships with the gateway and the console, and what a bucket
 * holds is one small file recording which of them their owner turned off — see
 * `enablement.js`.
 *
 * ## The manifest is Obsidian's, and the extension is one key
 *
 * `id`, `name`, `version`, `minAppVersion`, `description`, `author`,
 * `authorUrl` and `isDesktopOnly` are Obsidian's keys, spelled the way Obsidian
 * spells them, because the whole argument of `plugins.md` is that this
 * ecosystem is not somebody else's. Everything Context needs that Obsidian has
 * no concept of goes under a single `context` key, which Obsidian ignores the
 * way it ignores any unknown manifest key — the same round-trip rule
 * frontmatter already keeps.
 *
 * That is what makes "the same shape, in two places" true rather than a
 * resemblance: one renderer draws a row for a plugin from this catalogue and a
 * row for a plugin in `.obsidian/plugins/`, because the fields it reads are the
 * same fields.
 *
 * ## Ids are prefixed, and the prefix is a guard rather than a naming style
 *
 * Every id here begins with `context-`, and `isReservedPluginId` refuses that
 * prefix to anything read out of a bucket. A vault folder called `forms`, or a
 * community plugin published under that id, must never be able to present
 * itself as the built-in one: the built-in's row carries an off switch that
 * changes what the gateway serves, and a folder anybody can sync into a bucket
 * borrowing that row would be a control surface with an untrusted name on it.
 * Reserved is checked, not assumed — see `contextPlugins.test.mjs`.
 */

/**
 * Every id in this file starts here, and nothing read from a bucket may.
 *
 * @see isReservedPluginId
 */
export const CONTEXT_PLUGIN_PREFIX = "context-";

/**
 * The version every built-in manifest carries.
 *
 * One number for the set, deliberately. These do not ship independently of each
 * other — they ship when the gateway ships — so a per-plugin version would be a
 * number nobody increments and everybody trusts. The console shows it as the
 * product version it is.
 */
const BUILTIN_VERSION = "1.0.0";

/**
 * A Context plugin, in Obsidian's manifest shape.
 *
 * `context.tools` is the gateway half of the switch: those tool names leave
 * `tools/list` and are refused per call when the plugin is off. `context.offMeans`
 * is the console half, and is a rule rather than decoration — the one thing a
 * person needs before turning something off is what it costs, and every entry
 * here says what stays behind (which is always: their files, untouched).
 */
function contextPlugin({ id, name, description, tools = [], surfaces, offMeans, defaultEnabled = true }) {
  return Object.freeze({
    id: `${CONTEXT_PLUGIN_PREFIX}${id}`,
    name,
    version: BUILTIN_VERSION,
    minAppVersion: "0.0.0",
    description,
    author: "Context",
    authorUrl: "https://context.lc",
    isDesktopOnly: false,
    context: Object.freeze({
      builtin: true,
      defaultEnabled,
      tools: Object.freeze([...tools]),
      surfaces: Object.freeze([...surfaces]),
      offMeans,
    }),
  });
}

/**
 * The five, in the order the console lists them: most-used first.
 *
 * A feature belongs here when turning it off removes a *capability* and nothing
 * else. Notes, privacy, search, audit, storage and encryption are deliberately
 * absent and are not candidates: a switch that can stop the privacy engine
 * running is not a plugin, it is a hole, and a switch that hides encrypted
 * notes is a switch that loses somebody's content. See `plugins.md`.
 *
 * **Drawings was written into this list and taken back out**, and the reason is
 * the rule every entry here has to pass: a switch has to *do* something. Every
 * surface drawings has — the description in `read_note`, the console's render,
 * the editor page — is a read of a file that is already there, and gating a
 * read would be the switch hiding content rather than removing a capability.
 * Excalidraw's own write guard is unconditional and is not anybody's switch to
 * work. So there was nothing left for the control to govern, and a switch that
 * governs nothing is worse than no switch: it is a promise the product does not
 * keep. It belongs here the day drawings grows a tool.
 *
 * The same discipline is why each `offMeans` below names the tools and the write
 * paths and stops there. It is the sentence printed beside the control, so an
 * over-claim in it is the product lying at the exact moment somebody is
 * deciding.
 */
export const CONTEXT_PLUGINS = Object.freeze([
  contextPlugin({
    id: "forms",
    name: "Markdown forms",
    description:
      "A ```form block in a note collects answers into a sister note — bug reports, requests, sign-ups, votes — from people who cannot write notes.",
    tools: ["create_form", "submit_form", "update_submission", "retract_submission", "vote_form"],
    surfaces: ["Notes", "Editor"],
    offMeans:
      "No new forms and no new answers: the five form tools disappear from connected clients, and the console refuses a submission too. Every form block and every response file is left exactly as it is, and turning it back on takes answers again.",
  }),
  contextPlugin({
    id: "images",
    name: "Images",
    description:
      "read_image: a connected client opening a picture stored with your notes, in .context/assets/images/.",
    tools: ["read_image"],
    surfaces: ["Notes"],
    /*
      Read-only, and the wording says so rather than claiming an upload switch.
      The first draft of this entry said "notes stop accepting new images", and
      the only thing that writes to that prefix is the share-card renderer — so
      the sentence described a control the product does not have, beside a
      control that did something else.
    */
    offMeans:
      "read_image disappears from connected clients, so an AI client can no longer open a picture from this context. Every image stays exactly where it is, still shows in your notes, and still renders in Obsidian.",
  }),
  contextPlugin({
    id: "meetings",
    name: "Meetings",
    description: "Recorded meetings, their transcripts and their summaries, read as notes.",
    tools: ["list_meetings", "read_meeting"],
    surfaces: ["Console"],
    offMeans:
      "The two meeting tools disappear from connected clients, so an AI client can no longer list or read them. Nothing stops being recorded, no transcript is deleted, and the console still shows them.",
  }),
  contextPlugin({
    id: "chats",
    name: "Chat history",
    description: "A day of a connected chat channel, read as a note.",
    tools: ["list_channel_days", "read_channel_day"],
    surfaces: ["Console"],
    offMeans:
      "The two channel tools disappear from connected clients, so an AI client can no longer read a day of a channel. The connection that syncs those chats is separate and keeps running; turn it off under Chats if that is what you meant.",
  }),
  contextPlugin({
    id: "contacts",
    name: "Contacts",
    description:
      "One page per person you correspond with, in 0-inbox/contacts — their addresses, your own notes about them, and links into the days you spoke.",
    tools: ["list_contacts", "read_contact"],
    surfaces: ["Console", "Notes"],
    /*
      Says "read", twice, because reading is the whole of what this switch
      governs. The pages are written by the Gmail, Chat and iMessage syncs on
      their own schedule, and none of them asks this file — so an `offMeans`
      promising that contacts stop being built would be the product lying at
      the moment somebody is deciding, which is the rule every entry here has
      to pass. The sentence names the connection screens instead, the way
      Chat history's does, because "stop collecting this" is a real thing
      somebody means by turning this off and they should be told where it is.
    */
    offMeans:
      "The two contact tools disappear from connected clients, so an AI client can no longer list the people you correspond with or read one of their pages. Every contact page stays exactly where it is, still readable as an ordinary note and still shown in the console; the connected accounts that build them keep running, so turn one off under Email or Chats if that is what you meant.",
  }),
]);

/** Every built-in id, for callers that only need the names. */
export const CONTEXT_PLUGIN_IDS = Object.freeze(CONTEXT_PLUGINS.map((plugin) => plugin.id));

/**
 * Tool name → the plugin that owns it.
 *
 * Built once and frozen, and it refuses to build at all if two plugins claim
 * one tool: a tool whose switch is ambiguous is a tool that is on for one
 * reader and off for another, and this is the file where that would be
 * introduced silently.
 */
export const TOOL_OWNERS = Object.freeze(
  (() => {
    const owners = new Map();
    for (const plugin of CONTEXT_PLUGINS) {
      for (const tool of plugin.context.tools) {
        if (owners.has(tool)) {
          throw new Error(`two Context plugins claim the tool ${tool}`);
        }
        owners.set(tool, plugin.id);
      }
    }
    return Object.fromEntries(owners);
  })()
);

/** The built-in manifest with this id, or `null`. */
export function contextPluginById(id) {
  return CONTEXT_PLUGINS.find((plugin) => plugin.id === id) || null;
}

/** The built-in that owns this tool, or `null` for a tool no switch governs. */
export function pluginForTool(toolName) {
  return Object.hasOwn(TOOL_OWNERS, toolName) ? TOOL_OWNERS[toolName] : null;
}

/**
 * An id a bucket is not allowed to use.
 *
 * Deliberately the whole prefix rather than the five ids in use: a plugin added
 * here later must not be shadowable by a folder somebody synced in before it
 * existed, and a check against the current five would have exactly that hole
 * for exactly as long as nobody noticed.
 */
export function isReservedPluginId(id) {
  return typeof id === "string" && id.startsWith(CONTEXT_PLUGIN_PREFIX);
}
