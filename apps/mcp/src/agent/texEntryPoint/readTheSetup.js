/** Reads Tex's production setup: its prompt, history length, skills, models, router and fallback. One step of Tex's turn (`../texEntryPoint.js`). */

import { markUntrusted } from "../../privacy/egress.js";
import { searchSettingsOf } from "../../search/settings.js";
import { pictureFallback } from "../attachments.js";
import { builtinModel, canRunBuiltin } from "../builtin.js";
import { SHOWN_HISTORY_TURNS, earlierTextsTool } from "../conversation.js";
import { decisionEngine } from "../decide.js";
import { delegateSession } from "../delegate.js";
import { earlierChatTool } from "../groupTurn.js";
import { turnRouter } from "../modelPlan.js";
import { readProductionSkill } from "../production.js";
import { skillSession } from "../skills.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { threadView } from "../threadView.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function readTheSetup(t) {
  const { attachments, conversation, dispatch, env, group, history, job, learnedRead, ledger, logged, opened, quoted, session, setupRead, stages, store, tex, textingWriting, view = null } = t;
  /*
    THE PRODUCTION SETUP (`production.js`): the texting job's file on a texted
    turn or a group chat's (2026-10-23), none otherwise. Its prompt replaces the built-in words, and
    its model is used only when this deployment can call it: an uncallable one
    falls back.
  */
  const production = await tex.wait("setup", setupRead); stages?.mark("setup");
  // What of the conversation this turn is shown: the setup's `history:`, else the default; a text typed in a thread, that thread (`threadView.js`).
  const { shown: today, ...inThread } = threadView(history, quoted, job !== null ? 0 : production?.history ?? SHOWN_HISTORY_TURNS); // a job works from its own record, not the chat (`loggedTurn.js` `JOB_HISTORY_ENTRIES`)
  const shown = view?.history ?? today; // a turn that names no text reads the chat from its ledger, as a reply does (`loggedTurn.js` `momentView`)
  // An earlier answer never marks this turn: only what this turn itself reads from outside does (`docs/decisions/texting-assistant/turn-trust.md`).
  if (attachments.length > 0) markUntrusted(ledger); // a forwarded PDF is someone else's words, like a page
  // The rest is read on request, and carries its own mark when it is read.
  const earlier = group !== null ? [earlierChatTool(history)] : conversation === null ? [] : [earlierTextsTool(history)];
  // The setup's `search:` section, when it has one, over the deployment's
  // settings for this turn's searches, in this context and any it addresses
  // (`openContext` copies the store's settings at open time).
  if (production?.search) store.searchSettings = searchSettingsOf(store, production.search);
  // The setup's task skills (`skills.js`), read from the pinned workspace only when asked for.
  // A skill read this turn vouches for its own addresses and backticked values,
  // as the person's message does (`computer.js` `vouch`); nothing else can.
  const skills = skillSession(production?.skills ?? [], (path) => readProductionSkill(store, session, path), {
    onRead: (body) => opened?.vouch(body),
  });
  // Skills Tex wrote itself (`learnedSkills.js`): an index on a text, read on request, never vouched for.
  const learned = await tex.wait("learned_skills", learnedRead); stages?.mark("skills");
  // A text that can write may hand a sub-project to another agent (`delegate.js`), as the person.
  const home = store.contexts.find((entry) => entry.current)?.name ?? null;
  const delegation =
    session.actorClientId === TEXTS_CLIENT_ID && textingWriting.length > 0 && home !== null
      ? delegateSession(dispatch, {
          handle: home,
          home,
          vouch: (url, message) => opened?.delegated(url, message),
          trusted: () => ledger.untrusted !== true,
          browser: opened?.browser != null,
        })
      : null;
  // The setup's trusted sites (`trustedSites.js`), openable without an address given.
  // With `open_web: yes`, any public https address (owner, 2026-10-11).
  opened?.trust(production?.trustedSites ?? [], { openWeb: production?.openWeb === true });
  const productionModel =
    production !== null && canRunBuiltin(production.model, env) ? production.model : null;
  const builtinUsed = productionModel ?? builtinModel(env);
  // The setup's router (`router.js`), when this deployment can run both the
  // decision model and the thinking model; otherwise every text runs on `main`.
  const router = productionModel !== null ? turnRouter(production, (name) => canRunBuiltin(name, env), () => decisionEngine(env.AI)) : null; // or a planner for jobs alone (`modelPlan.js`)
  // The setup's fallback model (`production.js`), when this deployment can call it.
  const fallback = pictureFallback(productionModel !== null && production.fallback !== null && canRunBuiltin(production.fallback, env) ? production.fallback : null, [builtinUsed, router?.think], attachments);
  Object.assign(t, { builtinUsed, delegation, earlier, fallback, home, inThread, learned, production, productionModel, router, shown, skills });
}
// TEX ENTRY POINT: end
