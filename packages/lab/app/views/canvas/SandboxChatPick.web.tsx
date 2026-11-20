/**
 * The test chat's chat picker (decluttered Lab, mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N): your
 * account's 1:1 and group chats, the test account, the Training and Dev conversations, the chats people shared with
 * the developers (their texts play what ran, a test text runs as them; `labSandbox/shared.js`), and the recent test chats, each opened
 * in the dock (`SandboxChat.web.tsx`).
 */
import { useEffect, useState } from "react";
import { attachSandbox, readRecentSandboxes, readSandboxChats, readSandboxSets, readSandboxShared, openSandbox, useSandbox, type SandboxSource } from "../../engine/sandbox";
import { Pop } from "../bar/Pop.web";

type Tab = "mine" | "test" | "sets" | "shared";

const srcKey = (s: SandboxSource) => (s.kind === "maya" ? "maya" : s.kind === "chat" ? "chat:" + s.chatId : s.kind === "shared" ? "shared:" + s.chatId : "set:" + s.convId);

/** When a shared chat last had a text, in a few words. */
function ago(at: number | null): string {
  if (at === null) return "";
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 60 ? Math.max(m, 1) + " min ago" : m < 48 * 60 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
}

/** Reads the recent test chats each time the picker opens. */
function ReadRecent() {
  useEffect(() => void readRecentSandboxes(), []);
  return null;
}

/** The chat picker: your account's 1:1 and group chats, the test account, and the Training and Dev conversations. */
export function ChatPick({ versionId }: { versionId: string }) {
  const sb = useSandbox();
  const [tab, setTab] = useState<Tab>(sb.source.kind === "maya" ? "test" : sb.source.kind === "set" ? "sets" : sb.source.kind === "shared" ? "shared" : "mine");
  const [q, setQ] = useState("");
  const name = sb.source.kind === "maya" ? "Maya (test account)" : sb.source.kind === "chat" && sb.source.chatId === "me" ? "Your 1:1 with Tex" : sb.source.name;
  const who = sb.source.kind === "shared" ? "shared" : sb.source.kind === "maya" || (sb.source.kind === "chat" && sb.source.chatId === "me") ? "1:1" : sb.people.length ? sb.people.length + " people" : "";
  const qq = q.trim().toLowerCase();
  const hit = (s: string) => !qq || s.toLowerCase().includes(qq);
  const cur = srcKey(sb.source);
  const groupChat = () => sb.chats.find((c) => c.chatId !== "me" && c.kind !== "dm")?.chatId;
  return (
    <Pop
      id="sbChat"
      title="Which chat the test texts go to"
      button={
        <>
          <svg className="i" viewBox="0 0 24 24">
            <path d="M4 5h16v11H9l-5 4z" />
          </svg>
          <span className="nm" id="sbChatName">
            {name}
          </span>
          {who ? <span className="cwho">{who}</span> : null}
          <span className="car">▾</span>
        </>
      }
    >
      {(close) => {
        const open = (s: SandboxSource) => {
          close();
          void openSandbox(s, versionId);
        };
        const recent = (sb.recent ?? []).filter((c) => hit(c.name + " " + c.openedBy + " " + c.lastBy)).slice(0, 8);
        const one = sb.chats.filter((c) => (c.chatId === "me" || c.kind === "dm") && hit(c.chatId === "me" ? "Your 1:1 with Tex" : c.name));
        const groups = sb.chats.filter((c) => c.chatId !== "me" && c.kind !== "dm" && hit(c.name));
        const convs = sb.sets.filter((c) => hit(c.title));
        const shared = sb.sharedChats.filter((c) => hit(c.name + " " + c.sharedBy.join(" ")));
        return (
          <div className="vmenu chatpick">
            <ReadRecent />
            <div className="seg" role="tablist" id="sbPickTabs">
              {(
                [
                  ["mine", "Your account"],
                  ["test", "Test account"],
                  ["sets", "Training / Dev"],
                  ["shared", "Shared with devs"],
                ] as const
              ).map(([k, w]) => (
                <button
                  key={k}
                  role="tab"
                  data-tab={k}
                  aria-selected={tab === k}
                  onClick={() => {
                    setTab(k);
                    if (k === "sets" && !sb.sets.length) void readSandboxSets();
                    if (k === "mine" && !sb.chats.length) void readSandboxChats();
                    // Asked every time: someone who stopped sharing is gone at once.
                    if (k === "shared") void readSandboxShared();
                  }}
                >
                  {w}
                </button>
              ))}
            </div>
            {recent.length ? (
              <div id="sbRecent">
                <div className="mh">Recent test chats</div>
                {recent.map((c) => (
                  <button
                    key={c.sandboxId}
                    className="mi"
                    data-sandbox={c.sandboxId}
                    aria-current={sb.id === c.sandboxId}
                    title={`Opened by ${c.openedBy}${c.lastBy !== c.openedBy ? `, last text by ${c.lastBy}` : ""}`}
                    onClick={() => {
                      close();
                      void attachSandbox(c.sandboxId, versionId, c);
                    }}
                  >
                    <span className="nm">{c.name}</span>
                    {c.ai ? <span className="aib">AI</span> : null}
                    <span className="meta">{c.running ? "running" : c.texts + " test text" + (c.texts === 1 ? "" : "s")}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <input type="search" id="sbChatQ" className="vren" placeholder="Find a chat" aria-label="Find a chat" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <div id="sbChatList">
              {tab === "mine" ? (
                <>
                  {one.length ? <div className="mh">1:1</div> : null}
                  {one.map((c) => (
                    <button key={c.chatId} className="mi" data-chat={c.chatId} aria-current={cur === "chat:" + c.chatId} onClick={() => open({ kind: "chat", chatId: c.chatId, name: c.chatId === "me" ? "Your 1:1 with Tex" : c.name })}>
                      <span className="nm">{c.chatId === "me" ? "Your 1:1 with Tex" : c.name}</span>
                      <span className="meta">1:1</span>
                    </button>
                  ))}
                  {groups.length ? <div className="mh">Group chats</div> : null}
                  {groups.map((c) => (
                    <button key={c.chatId} className="mi" data-chat={c.chatId} aria-current={cur === "chat:" + c.chatId} onClick={() => open({ kind: "chat", chatId: c.chatId, name: c.name })}>
                      <span className="nm">{c.name}</span>
                      {c.people != null ? <span className="meta">{c.people === 1 ? "only you" : c.people + " people"}</span> : null}
                    </button>
                  ))}
                  {!one.length && !groups.length ? <div className="mnote">{sb.chats.length ? "No chat matches." : "No chats with Tex on your account yet."}</div> : null}
                </>
              ) : tab === "shared" ? (
                <>
                  <div className="mnote">People who said yes to sharing their Tex chats with the developers (Settings → Feedback, or texting "share my chats with the devs"). ▶ plays what ran; a test text runs as them, writes stay in the sandbox.</div>
                  {(["dm", "group"] as const).map((k) => {
                    const xs = shared.filter((c) => c.kind === k);
                    return xs.length ? (
                      <div key={k}>
                        <div className="mh">{k === "dm" ? "1:1" : "Group chats"}</div>
                        {xs.map((c) => (
                          <button key={c.chatId} className="mi" data-shared={c.chatId} aria-current={cur === "shared:" + c.chatId} title={"Shared by " + c.sharedBy.map((h) => "@" + h).join(", ")} onClick={() => open({ kind: "shared", chatId: c.chatId, name: c.name })}>
                            <span className="nm">{c.name}</span>
                            <span className="meta">{[k === "group" ? c.people + " people" : "1:1", ago(c.lastAt)].filter(Boolean).join(" · ")}</span>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })}
                  {!shared.length ? <div className="mnote">{sb.sharedChats.length ? "No chat matches." : "Nobody has shared their chats with the developers yet."}</div> : null}
                </>
              ) : tab === "test" ? (
                <>
                  <div className="mnote">A made-up person with her own workspace and chats, so nothing touches yours.</div>
                  {hit("Maya (test account)") ? (
                    <button className="mi" data-chat="maya" aria-current={cur === "maya"} onClick={() => open({ kind: "maya" })}>
                      <span className="nm">Maya (test account)</span>
                      <span className="meta">1:1</span>
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {(["dev", "training"] as const).map((k) => {
                    const xs = convs.filter((c) => c.set === k);
                    return xs.length ? (
                      <div key={k}>
                        <div className="mh">{k === "dev" ? "Dev" : "Training"} set</div>
                        {xs.map((c) => (
                          <button
                            key={c.id}
                            className="mi"
                            data-conv={c.id}
                            aria-current={cur === "set:" + c.id}
                            onClick={() => {
                              const chatId = c.group ? groupChat() : undefined;
                              open({ kind: "set", convId: c.id, name: c.title + " (" + (k === "dev" ? "Dev" : "Training") + ")", ...(chatId ? { chatId } : {}) });
                            }}
                          >
                            <span className="nm">{c.title}</span>
                            <span className="meta">{c.texts} texts</span>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })}
                  {!convs.length ? <div className="mnote">No conversation matches.</div> : null}
                  <div className="mnote">The Test set never shows here; it only runs in the Promote gate.</div>
                </>
              )}
            </div>
          </div>
        );
      }}
    </Pop>
  );
}
