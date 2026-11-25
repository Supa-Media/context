/**
 * TEX ADDED TO A GROUP TEST CHAT (Dev2, 2026-11-25: "Tex should have an intro when added to a group").
 *
 * `added { sandboxId, as? }` on a group test chat (`route.js`): `as` adds Tex's number to the group, a kind "joined" row
 * handed to the chat object as Tex's line hands Photon's `participantAdded` over (`chatRun.js` `inboundOf`, the
 * object's `/group-joined`, `packages/tex/worker/groupJoined.ts`). On a draft with node `joined` Tex says hello, once
 * per group (a fresh test chat tries it again); with the node off the object says nothing new and the reply row is quiet.
 */
import { lineOf, rowLine } from "./line.js";

/** The row and its run, through the route's own `addRow`; `helpers` are the route's (`refused`, `view`, `speakerOf`, `newIds`, `addRow`). */
export async function addTex(deps, state, { as }, cut = null) {
  const { refused, view, speakerOf, newIds, addRow } = deps.helpers;
  const about = state.meta.chat;
  if (about.kind !== "group") return refused(400, "Tex is added to a group: open a group test chat.");
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const speaker = speakerOf(about, as);
  if (speaker.error) return refused(...speaker.error);
  const { at, eid, id } = newIds();
  const row = { id, eid, who: speaker.speaker, kind: "joined", text: `${speaker.speaker} added Tex to the group`, at, prod: false, line: rowLine(lineOf(about)) };
  return await addRow({ ...deps, state, row, cut });
}
