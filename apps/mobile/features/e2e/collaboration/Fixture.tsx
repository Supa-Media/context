/** Local-only verification: real hooks and editor; fake identity/Convex transport. */
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { useFileBrowser } from "../../console/files/useFileBrowser";
import { useNoteRoom } from "../../console/presence/useNoteRoom";
import { NoteEditor } from "../../console/files/NoteEditor";
import { ConsoleGrantSessionContext } from "../../agent/useConsoleGrant";

type FixtureWindow = Window & {
  fixture?: { files: unknown; presence: unknown; editorText: () => string | null };
};

export function CollaborationFixture({ user = "ana", note = "1-projects/verify.md" }: { user?: string; note?: string }) {
  const client = useMemo(() => ({
    action: async (ref: FunctionReference<"action">, args: unknown) => {
      const name = getFunctionName(ref).split(":").at(-1);
      const response = await fetch("http://127.0.0.1:8799/__fixture/action", {
        method: "POST", headers: { "content-type": "application/json", "x-fixture-user": user },
        body: JSON.stringify({ name, args }),
      });
      const value = await response.json();
      if (!response.ok) throw new ConvexError(value);
      return value;
    },
    watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }),
    mutation: () => { throw new Error("Unexpected fixture mutation"); },
  }) as unknown as ConvexReactClient, [user]);
  return <ConvexProvider client={client}>
    <ConsoleGrantSessionContext.Provider value={`fixture-${user}`}>
      <Session user={user} note={note} />
    </ConsoleGrantSessionContext.Provider>
  </ConvexProvider>;
}

function Session({ user, note }: { user: string; note: string }) {
  const files = useFileBrowser({ workspaceId: "ws_local_verify", canEdit: user !== "reader", tier: "team", conditionalWrite: true });
  const { presence } = useNoteRoom({
    workspaceId: "ws_local_verify", endpoint: "http://127.0.0.1:8799/mcp",
    notePath: files.editor.path, conflicted: files.editor.status === "conflict",
    textForSeed: () => files.editor.draft,
    legacyDraft: () =>
      files.editor.draft !== files.editor.baseline
        ? { baseline: files.editor.baseline, desired: files.editor.draft, baseEtag: files.editor.draftBase ?? files.editor.etag }
        : undefined,
    onExternalWrite: files.onExternalWrite, onSaved: files.onSaved,
    durable:
      files.editor.path?.endsWith(".md") === true &&
      !files.editor.path.endsWith(".excalidraw.md") &&
      files.editor.encrypted !== true &&
      files.editor.etag?.startsWith("c2.") === true,
    canEdit: user !== "reader",
    scope: "team",
    onCollaborationOwned: files.setCollaborationOwned,
    onCollaborationText: files.setCollaborationDraft,
    onCollaborationState: files.setCollaborationState,
  });
  useEffect(() => { files.select(note); }, []);
  useEffect(() => {
    (window as FixtureWindow).fixture = {
      files,
      presence,
      editorText: () => {
        const dom = document.querySelector(".cm-editor");
        return dom ? EditorView.findFromDOM(dom as HTMLElement)?.state.doc.toString() ?? null : null;
      },
    };
  });
  return <div style={{padding:24,height:"100vh",background:"var(--lp-bg)",color:"var(--lp-content)"}}>
    <h2>Local collaboration verification: {user}</h2>
    <p data-testid="state">{JSON.stringify({path:files.editor.path,status:files.editor.status,collaboration:presence.collaboration?.status,pending:presence.collaboration?.pending,phase:presence.phase,settled:presence.settled,saver:presence.canWrite,members:presence.members.map(m=>m.name)})}</p>
    <button onClick={()=>files.select("1-projects/verify.md")}>Existing note</button>
    <button onClick={()=>files.select("1-projects/empty.md")}>Empty note</button>
    <button onClick={()=>files.select("1-projects/second.md")}>Second note</button>
    <button onClick={()=>files.save()}>Save</button>
    <p>{files.notice}</p>
    {files.editor.path !== null && <NoteEditor
      state={files.editor}
      canEdit={user !== "reader"}
      presence={presence}
      visibility={{
        visibility: files.editor.visibility,
        inherited: files.editor.inherited,
        exception: files.editor.exception,
        readOnly: files.editor.readOnly,
      }}
      onChange={files.setDraft}
      onSave={files.save}
      onDiscard={files.discard}
      onUseTheirs={files.useTheirs}
      onKeepMine={files.keepMine}
      onOpenNote={(path) => { void files.select(path); }}
      onLoadImage={files.loadImage}
      onStoreImage={files.storeImage}
      onImageProblem={files.say}
      onReadFormResponses={files.readFormResponses}
      onSubmitForm={files.submitForm}
      onVoteForm={files.voteForm}
      onUpdateFormResponse={files.updateFormResponse}
      onRetractFormResponse={files.retractFormResponse}
      notePaths={files.linkPaths}
    />}
  </div>;
}
