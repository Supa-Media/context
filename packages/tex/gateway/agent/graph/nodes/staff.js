/**
 * Staff messages node "staff" (`texConfig.json`): a text staff send through Tex from the console, the start of its run.
 * Today the one kind is a chat moving to Tex's new number (Platform → Lines → Move chats), which the texting Worker
 * asks for (`textsMove.js`); its `move` wire takes it to Staff move a chat (`moveChat`), which words it, and the
 * Worker sends it on the chat's old line. No model.
 */
export async function staffNode(input) {
  const { kind, number, archiveOn } = input;
  return { when: ["move"], kind, ...(number === undefined ? {} : { number }), ...(archiveOn === undefined ? {} : { archiveOn }) };
}
