/**
 * TEX SETS UP A PERSON'S COMPUTER ITSELF (decided by the owner, 2026-11-08:
 * "we should never really make functionality that only humans are native to
 * like setting up a computer by pressing UI etc... it should definitely say
 * the things that only they can do but do the other things themselves. OR
 * give them a prompt to hand an agent working on their computer";
 * `docs/decisions/texting-assistant/computer-setup.md`).
 *
 * In Tex Devs on 2026-11-05, "Tex add my computer for community compute" got
 * "Connect it on your own Tex page first. Then you can lend it to this chat
 * from the machines page": every step was a button in the app
 * (`appRoutes.js`, console-only), and Tex had no tool for any of it. This is
 * that tool, `send` action `computers`, for a person's own texts and a group
 * chat's turn:
 *
 *  - `setup_prompt` hands the prompt for the coding agent on their computer
 *    (`setupPrompt.js`, the same words as `context.lc/download`);
 *  - `pair` approves the code it shows when they text it to Tex, in their own
 *    1:1 only (`texMachineTexts.ts`): read out in a group, anyone there could
 *    approve it into their own account and run jobs on it;
 *  - `lend` / `unlend` lend it to the group chat the turn is in, with who may
 *    use it and Ask me first, as the app's lend does;
 *  - `rename`, `limits`, `more_time`, `install`, `sign_in` (+ `sign_in_code`,
 *    1:1 only: the link signs an account in) and `disconnect`, as the app's.
 *
 * What only the person can do stays theirs and is named as such: running the
 * prompt (or the one command) on their computer, signing in to their own
 * Claude or OpenAI account on the page the link opens, and texting the code.
 *
 * WHO ACTS. Only the person the grant names (`session.actorUserId`, the
 * tagger in a group), on their own computers, found by the control plane by
 * that id (`texMachinesOwned`) and re-checked against each computer's own
 * `ownerId`: never a workspace owner on somebody else's computer, and never a
 * name from the arguments. Every change runs only when the turn's own message,
 * from that person, asks for it: a pairing or sign-in code must be in their
 * words verbatim, and anything else must name a computer and pass the same
 * small judge as any widening (`consentFor` in `commandTools.js`). Another
 * member's text, a quote or an email can't set up anyone's computer.
 */

import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { groupChatId, lentToChat, TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID } from "./reach.js";
import { setupPrompt, SETUP_SYSTEMS } from "./setupPrompt.js";

export const COMPUTER_TOOL = "tex_computers";
const CHAT_KEY = /^[0-9a-f]{64}$/;
const TOOLS = { claude: "Claude Code", codex: "Codex" };
const HOUR_MS = 60 * 60 * 1000;
/** How long a sign-in waits for its link before the turn is told to look again. */
const SIGN_IN_WAIT_MS = 8000;

const DOES = ["list", "setup_prompt", "pair", "lend", "unlend", "rename", "limits", "more_time", "install", "sign_in", "sign_in_code", "disconnect"];

/** The words a change needs in the person's own message before the judge is asked. */
const COMPUTER_WORDS = /\b(computers?|machines?|laptops?|mac(?:book)?s?|imacs?|pcs?|desktops?|servers?|vms?|boxe?s?|minis?|studios?|compute|runners?|claude|codex|lend\w*|lent|pair\w*|connect\w*|add|share|unshare|rename|call it|name it|limits?|hours?|minutes?|slots?|time|install\w*|sign\w*|log\w*|disconnect\w*|remove|unpair\w*|stop|take (?:it )?back|community)\b/i;

const JUDGED = {
  lend: "lend the person's own computer to this group chat, so jobs from the chat can run on it",
  unlend: "stop lending the person's own computer to this group chat",
  rename: "rename the person's own computer",
  limits: "change how much Tex may use the person's own computer",
  more_time: "give Tex more time on the person's own computer today",
  install: "install a coding tool on the person's own computer",
  sign_in: "start signing a coding tool in on the person's own computer",
  disconnect: "disconnect the person's own computer from Tex",
};

const text = (words, isError = false) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/** Upper-cased letters and digits only: `kq7-4mp` and `KQ74MP` are one code. */
const plainCode = (value) => (typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

/** Whether `code` is one of the six-character codes in the person's own words, however they spaced it. */
export function codeInWords(code, words) {
  const wanted = plainCode(code);
  if (wanted.length !== 6) return false;
  return (String(words ?? "").match(/\b[A-Za-z0-9]{3}[\s-]?[A-Za-z0-9]{3}\b/g) ?? []).some((found) => plainCode(found) === wanted);
}

/** Whether a sign-in code (up to 512 characters, as the app takes it) is in their own words verbatim. */
export function signInCodeInWords(code, words) {
  const given = typeof code === "string" ? code.trim() : "";
  return given.length >= 4 && given.length <= 512 && /^[A-Za-z0-9#_.~-]+$/.test(given) && String(words ?? "").includes(given);
}

/**
 * Whether the turn's own message asks for `action` on a computer: a computer word first, then the judge when the
 * deployment has one. Anything but a clear yes is a no.
 */
export function computerConsent(words, judge = null) {
  return async (action) => {
    const said = typeof words === "string" ? words : "";
    if (!COMPUTER_WORDS.test(said)) return false;
    if (typeof judge !== "function") return true;
    try {
      return (await judge({ words: said, action: JUDGED[action] ?? "change the person's own computer" }))?.allow === true;
    } catch {
      return false;
    }
  };
}

const OWN_WORDS = "They have to ask for that in their own words. Nothing was changed; tell them so.";

async function objectCall(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  try {
    const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
    return await response.json();
  } catch {
    return null;
  }
}

const plain = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** One computer named in words: by exact name, id, or a part of its name; a lone computer needs no name. */
export function findComputer(owned, name) {
  const named = plain(name);
  if (named === "") return owned.length === 1 ? owned[0] : null;
  return owned.find(({ machine }) => plain(machine.name) === named || machine.id === name) ?? owned.find(({ machine }) => plain(machine.name).includes(named)) ?? null;
}

const hours = (ms) => {
  const h = ms / HOUR_MS;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
};

function describe({ machine }, here) {
  const tools = (machine.tools ?? []).map((tool) => TOOLS[tool] ?? tool).join(", ") || "no coding tool yet";
  const limits = machine.limits ?? {};
  const parts = [
    `"${machine.name}" (${machine.os ?? "unknown system"}, ${machine.online ? "online" : "offline"})`,
    `tools: ${tools}`,
    Number.isSafeInteger(limits.slots) ? `${limits.slots} ${limits.slots === 1 ? "slot" : "slots"}` : null,
    Number.isSafeInteger(limits.dayMs) ? `${hours(limits.dayMs)} a day, ${hours(limits.weekMs ?? 0)} a week, others ${hours(limits.othersDayMs ?? 0)} a day` : null,
    (machine.folders ?? []).length > 0 ? `folders: ${machine.folders.join(", ")}` : null,
    machine.signIn ? `sign-in ${machine.signIn.state}${machine.signIn.url ? `: ${machine.signIn.url}` : ""}${machine.signIn.userCode ? ` (code ${machine.signIn.userCode})` : ""}` : null,
    machine.install ? `install of ${TOOLS[machine.install.tool] ?? machine.install.tool} ${machine.install.state}${machine.install.error ? ` (${machine.install.error})` : ""}` : null,
  ];
  if (here !== null) {
    const rule = machine.chats?.[here];
    parts.push(rule ? `lent here: ${rule.who === "everyone" ? "anyone here may use it" : Array.isArray(rule.who) ? "named people may use it" : "only its owner may use it"}, Ask me first ${rule.askFirst === false ? "off" : "on"}` : "not lent to this chat");
  }
  return parts.filter(Boolean).join("; ");
}

/**
 * The computer tool for one texted turn, `[{ tool, call }]`, or `[]` where it doesn't belong (not a person's own
 * texts nor a group's turn, a guest's tag, no workspace objects or control plane).
 *
 * @param {{ env: object, session: object, controlPlane: object, group: object|null, words: string, judge?: Function|null }} options
 */
export function computerTools({ env, session, controlPlane, group, words, judge = null }) {
  if (!env?.WORKSPACE_STORE || !controlPlane || typeof controlPlane.texMachinesOwned !== "function") return [];
  const own = session?.actorClientId === TEXTS_CLIENT_ID && group === null;
  const groupKey = session?.actorClientId === TEXTS_GROUP_CLIENT_ID && CHAT_KEY.test(session.texChatId ?? "") ? session.texChatId : null;
  if (!own && groupKey === null) return [];
  if (group?.guestTagger === true || typeof session.actorUserId !== "string" || session.actorUserId === "") return [];
  const here = groupKey === null ? null : groupChatId(groupKey);
  const consent = computerConsent(words, judge);
  const asked = async (action) => {
    try {
      return (await consent(action)) === true;
    } catch {
      return false;
    }
  };

  /** Their own computers, each `{ workspaceId, machine }`, re-checked against the computer's own owner. */
  async function owned() {
    const rows = await controlPlane.texMachinesOwned(session.actorUserId).catch(() => []);
    const found = await Promise.all(rows.map(async ({ workspaceId, machineId }) => {
      const answer = await objectCall(env, workspaceId, "ws.machine.get", { id: machineId });
      return answer?.ok === true && answer.machine?.ownerId === session.actorUserId && answer.machine.mailOnly !== true ? [{ workspaceId, machine: answer.machine }] : [];
    }));
    return found.flat();
  }

  const noneYet = () =>
    text(
      "They have no computer paired with Tex yet. Set it up: call this with do setup_prompt and the system (mac, linux or headless; ask only if you can't tell), " +
        "text them the prompt to paste into Claude Code or Codex on that computer" +
        (own ? ", and say to text you the code it shows, which you approve with do pair." : ", and say to text you the code it shows in their own texts with Tex (never here), or open the link it prints. Once it's paired they say \"Tex, lend my computer here\"."),
      true,
    );

  async function picked(args) {
    const mine = await owned();
    if (mine.length === 0) return { error: noneYet() };
    const found = findComputer(mine, args?.computer);
    if (found === null) return { error: text(`Name one of their computers: ${mine.map(({ machine }) => `"${machine.name}"`).join(", ")}. Nothing was changed.`, true) };
    return { found };
  }

  const changed = (answer, success) => (answer?.ok === true ? text(success(answer)) : text(`That didn't go through (${answer?.code ?? "the computer's workspace couldn't be reached"}). Nothing was changed; say so plainly.`, true));

  async function call(args) {
    const does = args?.do;
    if (!DOES.includes(does)) return text(`Say what to do: ${DOES.join(", ")}.`, true);

    if (does === "setup_prompt") {
      const system = SETUP_SYSTEMS.includes(args?.system) ? args.system : "linux";
      return text(
        `Text them this prompt, as it is, in its own message, to paste into Claude Code or Codex on that computer:\n\n${setupPrompt(system)}\n\n` +
          (own
            ? "Then say: text me the code it shows and I'll approve it. When they do, call this with do pair and that code."
            : "Then say: text me the code it shows in your own texts with Tex, not here (anyone here could approve it into their own account), or open the link it prints. Once it's paired, say \"Tex, lend my computer here\"."),
      );
    }

    if (does === "list") {
      const mine = await owned();
      if (mine.length === 0) return noneYet();
      const lent = groupKey === null ? null : await lentToChat(controlPlane, session);
      const others = lent === null ? "" : lent.filter((entry) => entry.ownerId !== session.actorUserId).length;
      return text(`Their computers: ${mine.map((entry) => describe(entry, here)).join(". ")}.${lent !== null && others > 0 ? ` ${others} other ${others === 1 ? "computer is" : "computers are"} lent here by other people.` : ""}`);
    }

    if (does === "pair") {
      if (!own) return text("A pairing code is approved only in their own texts with Tex, never in a group: anyone here could approve it into their own account. Tell them to text you the code there. Nothing was changed.", true);
      if (!codeInWords(args?.code, words)) return text("Pass the six-character code exactly as they texted it. It has to be in their own message; a code from anywhere else is never approved. Nothing was changed.", true);
      if (typeof controlPlane.texMachinePairApproveFromTexts !== "function" || typeof session.accessToken !== "string") return text("Pairing from a text isn't available on this deployment. Nothing was changed.", true);
      const answer = await controlPlane.texMachinePairApproveFromTexts(session.accessToken, args.code).catch(() => ({ refused: "REFUSED" }));
      if (answer?.approved) {
        return text(
          `Paired: "${answer.approved.name}" (${answer.approved.os}) is now one of their computers. Its runner picks it up within a few seconds and the prompt's next steps keep it running. ` +
            "Code and heavy jobs can go to it from now on. To use it in a group chat they say there \"Tex, lend my computer here\".",
        );
      }
      const why = {
        PAIRING_NOT_FOUND: "no computer is showing that code now (it may have run out after 30 minutes: start `context-machine pair` again for a new one)",
        PAIRING_EXPIRED: "that code ran out: start pairing again for a new one",
        RATE_LIMITED: "too many codes were tried just now: wait ten minutes",
        INSUFFICIENT_ROLE: "their own texts with Tex can't add a computer here",
      }[answer?.refused] ?? "it couldn't be approved just now";
      return text(`Not paired: ${why}. Nothing was changed.`, true);
    }

    if ((does === "lend" || does === "unlend") && groupKey === null) {
      return text(`A computer is lent to a group chat from that chat: they say there "Tex, ${does === "lend" ? "lend my computer here" : "stop lending my computer here"}". Nothing was changed.`, true);
    }
    if ((does === "sign_in" || does === "sign_in_code") && !own) {
      return text("A coding tool is signed in from their own texts with Tex, never in a group: the link signs an account in. Tell them to text you there. Nothing was changed.", true);
    }

    // Everything below changes something on their computer: their own words first.
    if (does === "sign_in_code") {
      if (!signInCodeInWords(args?.code, words)) return text("Pass the code exactly as they texted it; it has to be in their own message. Nothing was changed.", true);
    } else if (!(await asked(does))) {
      return text(OWN_WORDS, true);
    }
    const { found, error } = await picked(args);
    if (error) return error;
    const { workspaceId, machine } = found;

    if (does === "lend") {
      const lent = await controlPlane.texMachineChatAttach(session.actorUserId, machine.id, groupKey).catch(() => null);
      if (lent?.attached !== true) return text(lent?.refused === 409 ? "This chat already has as many computers as it can take. Nothing was changed." : "It couldn't be lent here. Nothing was changed; say so plainly.", true);
      let who = "owner";
      if (args?.who === "everyone") who = "everyone";
      else if (typeof args?.who === "string" && args.who.trim() !== "" && args.who !== "me") {
        const people = (await controlPlane.texMachineChatPeople(session.actorUserId, groupKey).catch(() => null)) ?? [];
        const handles = args.who.split(/[\s,]+/).map((handle) => handle.replace(/^@/, "").toLowerCase()).filter(Boolean);
        const ids = people.filter((person) => handles.includes(String(person.handle).toLowerCase())).map((person) => person.userId);
        if (ids.length === 0) return text(`Lent, but none of ${args.who} is one of this chat's people, so only its owner may use it for now. Name them by their handle.`, true);
        who = [...new Set([session.actorUserId, ...ids])];
      }
      const rule = { ...(machine.chats?.[here] ?? {}), who, askFirst: args?.ask_first !== false };
      const answer = await objectCall(env, workspaceId, "ws.machine.set", { id: machine.id, patch: { chats: { ...machine.chats, [here]: rule } } });
      return changed(answer, () =>
        `Lent "${machine.name}" to this chat: ${who === "everyone" ? "anyone here may send it work" : Array.isArray(who) ? "the people they named may send it work" : "only they may send it work"}, ` +
          `Ask me first ${rule.askFirst ? "on (their 👍 here lets each job start)" : "off"}. Say so in one line.`,
      );
    }

    if (does === "unlend") {
      if ((await controlPlane.texMachineChatDetach(session.actorUserId, machine.id, groupKey).catch(() => null)) === null) return text("It couldn't be taken back just now. Nothing was changed.", true);
      const { [here]: _gone, ...chats } = machine.chats ?? {};
      const answer = await objectCall(env, workspaceId, "ws.machine.set", { id: machine.id, patch: { chats } });
      return changed(answer, () => `"${machine.name}" is no longer lent to this chat.`);
    }

    if (does === "rename") {
      const name = typeof args?.name === "string" ? args.name.trim().slice(0, 60) : "";
      if (name === "") return text("Pass the new name. Nothing was changed.", true);
      return changed(await objectCall(env, workspaceId, "ws.machine.set", { id: machine.id, patch: { name } }), () => `Renamed "${machine.name}" to "${name}".`);
    }

    if (does === "limits") {
      const limits = { ...(machine.limits ?? {}) };
      const set = (key, value, scale) => {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) limits[key] = Math.round(value * scale);
      };
      set("slots", args?.slots, 1);
      set("dayMs", args?.day_hours, HOUR_MS);
      set("weekMs", args?.week_hours, HOUR_MS);
      set("othersDayMs", args?.others_day_hours, HOUR_MS);
      if (JSON.stringify(limits) === JSON.stringify(machine.limits ?? {})) return text("Pass slots, day_hours, week_hours or others_day_hours. Nothing was changed.", true);
      return changed(await objectCall(env, workspaceId, "ws.machine.set", { id: machine.id, patch: { limits } }), (answer) => `Saved. ${describe({ machine: answer.machine }, null)}.`);
    }

    if (does === "more_time") {
      const minutes = Math.round((typeof args?.hours === "number" ? args.hours : 0) * 60);
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 24 * 60) return text("Pass hours, more than 0 and at most 24. Nothing was changed.", true);
      return changed(await objectCall(env, workspaceId, "ws.machine.raise", { id: machine.id, minutes }), () => `Added ${hours(minutes * 60000)} on "${machine.name}" for today; it's gone tomorrow.`);
    }

    if (does === "install") {
      if (!TOOLS[args?.tool]) return text("Pass tool: claude or codex. Nothing was changed.", true);
      return changed(await objectCall(env, workspaceId, "ws.machine.install", { id: machine.id, tool: args.tool }), () =>
        `Installing ${TOOLS[args.tool]} on "${machine.name}" now, from its maker's own build; do list shows how far it got. Then it needs signing in (do sign_in).`,
      );
    }

    if (does === "sign_in") {
      if (!TOOLS[args?.tool]) return text("Pass tool: claude or codex. Nothing was changed.", true);
      const started = await objectCall(env, workspaceId, "ws.machine.signIn", { id: machine.id, tool: args.tool });
      if (started?.ok !== true) return changed(started, () => "");
      let signIn = started.machine?.signIn ?? null;
      for (let waited = 0; waited < SIGN_IN_WAIT_MS && !(signIn?.url || signIn?.state === "failed" || signIn?.state === "done"); waited += 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        signIn = (await objectCall(env, workspaceId, "ws.machine.get", { id: machine.id }))?.machine?.signIn ?? signIn;
      }
      if (signIn?.state === "failed") return text(`The sign-in couldn't start on "${machine.name}"${signIn.error ? `: ${signIn.error}` : ""}. Say so plainly.`, true);
      if (signIn?.state === "done") return text(`${TOOLS[args.tool]} is signed in on "${machine.name}".`);
      if (!signIn?.url) return text(`The sign-in is starting on "${machine.name}". Check again in a moment with do list, which shows its link.`);
      return text(
        `Text them this link to sign in to their own ${args.tool === "codex" ? "OpenAI" : "Claude"} account: ${signIn.url}` +
          (signIn.userCode ? ` and the code to enter there: ${signIn.userCode}. Nothing comes back to you; it finishes on its own.` : ". The page then shows a code: they text it to you, and you pass it with do sign_in_code.") +
          " Signing in is the one step that's theirs.",
      );
    }

    if (does === "sign_in_code") {
      const signInId = machine.signIn?.id;
      if (typeof signInId !== "string") return text(`No sign-in is waiting on "${machine.name}". Start one with do sign_in.`, true);
      return changed(await objectCall(env, workspaceId, "ws.machine.signIn", { id: machine.id, signInId, code: args.code.trim() }), () =>
        `Code handed to "${machine.name}"; it's checking it. do list shows when it's signed in.`,
      );
    }

    if (does === "disconnect") {
      // The control plane decides too (`revokeMachineAs`); its grant goes first, so an offline computer can't come back.
      const revoked = await controlPlane.texMachineRevoke(machine.id, session.actorUserId).catch(() => null);
      if (revoked === null || revoked.workspaceId !== workspaceId) return text("It couldn't be disconnected. Nothing was changed; say so plainly.", true);
      await objectCall(env, workspaceId, "ws.machine.remove", { id: machine.id, reason: "revoked" });
      return text(`Disconnected "${machine.name}": Tex can't use it any more, and it's no longer lent anywhere.`);
    }
    return text("Nothing was changed.", true);
  }

  return [
    {
      tool: {
        name: COMPUTER_TOOL,
        description:
          "Set up and run the person's own computers yourself, instead of sending them to buttons: never tell them to do in the app what this does. " +
          "do: list (their computers and how each is set), setup_prompt (the prompt for Claude Code or Codex on a computer that isn't paired yet; pass system mac, linux or headless), " +
          "pair (approve the code its runner shows, passed exactly as they texted it; their own texts only), lend / unlend (lend it to this group chat or take it back, " +
          "who: everyone, me, or @handles, ask_first true or false; a group only), rename (name), limits (slots, day_hours, week_hours, others_day_hours), " +
          "more_time (hours, today only), install (tool claude or codex), sign_in (tool; texts them the link; their own texts only), sign_in_code (code they texted back), disconnect. " +
          "computer names one of theirs; leave it out when they have one. What only they can do: paste the prompt into their agent (or run it), sign in to their own account on the page " +
          "the link opens, and text you the code. Say just that, and do the rest.",
        inputSchema: {
          type: "object",
          properties: {
            do: { type: "string", enum: DOES },
            computer: { type: "string" },
            system: { type: "string", enum: SETUP_SYSTEMS },
            code: { type: "string" },
            who: { type: "string" },
            ask_first: { type: "boolean" },
            name: { type: "string" },
            tool: { type: "string", enum: Object.keys(TOOLS) },
            hours: { type: "number" },
            slots: { type: "integer" },
            day_hours: { type: "number" },
            week_hours: { type: "number" },
            others_day_hours: { type: "number" },
          },
          required: ["do"],
        },
      },
      call: async (args) => {
        try {
          return await call(args);
        } catch {
          return text("That couldn't be done right now. Nothing was changed; say so plainly.", true);
        }
      },
    },
  ];
}

/** The `send` action the tool is shown as (`sixTools.js`). */
export const COMPUTER_SEND_ACTIONS = {
  computers: { tool: COMPUTER_TOOL, summary: "Set up and run their own computers yourself: list, setup prompt, pair by texted code, lend to this group, rename, limits, more time, install, sign in, disconnect." },
};
