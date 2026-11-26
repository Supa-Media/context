/**
 * The mail a group chat shares, read in a Lab test chat copied from it (2026-11-26). The copy runs on the Lab user's
 * own token, which reads nobody's mail, so a shared mailbox's search said "cannot read the person's email". Each read
 * here names the chat (`labChat`, its key), and the control plane answers it as the chat's own read of that mail, only
 * while the token's person is in the chat (`lib/textGroupMail.ts` `labChatMailClearance`). A send is still kept in the
 * test chat (`apps/mcp/src/labSandbox/sandboxTools.js`).
 */

const CHAT_KEY = /^[0-9a-f]{64}$/;

/** `controlPlane` with its mail reads naming the chat `chatKey`; the same `controlPlane` for anything else. */
export function labChatMail(controlPlane, chatKey) {
  if (typeof chatKey !== "string" || !CHAT_KEY.test(chatKey)) return controlPlane;
  const searchOf = controlPlane.personMailSearch;
  const readOf = controlPlane.personMailRead;
  return new Proxy(controlPlane, {
    get(target, name, receiver) {
      if (name === "personMailSearch" && typeof searchOf === "function") return (token, workspace, search) => searchOf.call(target, token, workspace, { ...search, labChat: chatKey });
      if (name === "personMailRead" && typeof readOf === "function") return (token, workspace, address, id, options = {}) => readOf.call(target, token, workspace, address, id, { ...options, labChat: chatKey });
      const value = Reflect.get(target, name, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
