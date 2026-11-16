/**
 * The Lab's Testing tab, simplified (Dev2, 2026-11-16: "simplify this page, because right now it looks horrendous";
 * built exactly from the approved mockup https://claude.ai/artifact/PUjJ7Vd6tX6BJj7vkEir1T): the sets on the left,
 * the chat as a grid in the middle, and a step's details on the right only while one of its cells is picked. Training and Dev are read and kept through Convex (`functions/texSets.ts`);
 * the Test Set only through the eval service, by a person who asks to see it.
 */
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../../../console/placeholderData";
import * as LD from "../../labData.generated";
import { lab, set } from "../../engine/state";
import type { Conversation } from "../../engine/sets";
import { mergeDrafts, testClient, type Draft } from "../../engine/setsData";
import { loadConvs, setSetsSink, setUi, undo, useSets, type HiddenChat } from "../../engine/setsStore";
import { Grid, gridKey } from "./Grid.web";
import { Inspector } from "./Inspector.web";
import { SetsList } from "./SetsList.web";
import { TESTING_CSS } from "./testingCss";
import { RunsPanel } from "../runs/Runs.web";
import { TryPanel } from "./TryText.web";
import { useRunsUi } from "../../engine/labRuns";
import { useSandboxCall } from "../canvas/sandboxCall";

/** The repo's Training and Dev conversations, as the build carries them. */
const REPO: Conversation[] = ((LD as Record<string, unknown>).SETS as Conversation[] | undefined) ?? [];
/** The Test Set's owner: its editors may read and write it. */
const TEST_HOME = "context-lc";

const unfinished = (c: Conversation) => c.msgs.some((m) => !m.tex && m.kind !== "delete" && !m.text.trim() && !m.pics?.length);
/** The largest picture a message takes. */
const MAX_PIC_BYTES = 10 * 1024 * 1024;

/** Reads and keeps the tab's conversations; mounted once, while the tab is open. */
function useSetsSync() {
  const data = useQuery(api.functions.texSets.list, {});
  const edit = useMutation(api.functions.texSets.edit);
  const create = useMutation(api.functions.texSets.create);
  const remove = useMutation(api.functions.texSets.remove);
  const picUploadUrl = useMutation(api.functions.texSets.picUploadUrl);
  const picUrl = useMutation(api.functions.texSets.picUrl);
  const restoreTo = useMutation(api.functions.texSets.restoreTo);
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const home = workspaces?.find((w) => w.slug === TEST_HOME) ?? null;
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const test = useMemo(() => {
    const id = home?.workspaceId;
    return id ? testClient(MCP_ENDPOINT, async (refresh) => (await minting.current({ workspaceId: id as Id<"workspaces"> }, refresh)).accessToken) : testClient(MCP_ENDPOINT, async () => Promise.reject(new Error("Only editors of @context-lc can open the Test Set")));
  }, [home?.workspaceId]);
  const merged = useMemo(() => mergeDrafts(REPO, ((data?.drafts ?? []) as Draft[])), [data]);
  const state = useRef(merged);
  state.current = merged;

  const counts = useRef<{ hidden: HiddenChat[]; stars: number }>({ hidden: [], stars: 0 });
  useEffect(() => {
    let on = true;
    void test
      ?.counts()
      .then((c) => {
        if (!on) return;
        counts.current = c;
        loadConvs(state.current.convs, c.hidden, c.stars);
      })
      .catch(() => undefined);
    return () => void (on = false);
  }, [test]);
  useEffect(() => {
    if (data) loadConvs(merged.convs, counts.current.hidden, counts.current.stars);
  }, [data, merged]);

  /** The revision each of this tab's own edits came back at, so quick edits in a row don't trip over the list. */
  const mine = useRef<Record<string, number>>({});
  useEffect(() => {
    const rev = (id: string) => Math.max(state.current.revs[id] ?? 0, mine.current[id] ?? 0);
    const base = (id: string) => (state.current.repoIds.has(id) && !rev(id) ? REPO.find((c) => c.id === id) : undefined);
    const keep = async (id: string, ops: unknown[]) => {
      const r = (await edit({ id, rev: rev(id), ops, base: base(id) })) as { status: string; rev: number };
      if (typeof r?.rev === "number") mine.current[id] = r.rev;
      if (r?.status === "conflict") throw new Error("Someone else changed the same thing: the chat now shows their change");
    };
    setSetsSink({
      async change(before, after, ops) {
        if (!test && (before.set === "test" || after.set === "test")) throw new Error("The Test Set can't be reached");
        // A row just added has no words yet; the Test Set keeps only sound chats, so it is sent once it has them.
        if (before.set === "test" && after.set === "test") return unfinished(after) ? undefined : test!.put(after);
        if (before.set === "test") {
          await create({ conv: after, repoIds: [...state.current.repoIds] });
          return test!.remove(after.id);
        }
        if (after.set === "test") {
          await test!.put(after);
          await remove({ id: after.id, base: base(after.id) });
          return;
        }
        await keep(after.id, ops);
      },
      async create(c) {
        await create({ conv: c, repoIds: [...state.current.repoIds] });
      },
      readTest: test ? () => test.list() : undefined,
      async remove(c) {
        if (c.set === "test") {
          if (!test) throw new Error("The Test Set can't be reached");
          return test.remove(c.id);
        }
        await remove({ id: c.id, base: base(c.id) });
      },
      async restore(id, to) {
        const r = (await restoreTo({ id, to })) as unknown as { rev: number };
        mine.current[id] = r.rev;
      },
      async upload(file) {
        if (!/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type)) throw new Error("Pictures only: PNG, JPEG, GIF, WebP or HEIC");
        if (file.size > MAX_PIC_BYTES) throw new Error("That picture is over 10 MB");
        const res = await fetch(await picUploadUrl({}), { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!res.ok) throw new Error("That picture did not upload");
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        return { url: await picUrl({ storageId }), type: file.type, ...(file.name ? { name: file.name.slice(0, 120) } : {}) };
      },
    });
    return () => setSetsSink(null);
  }, [edit, create, remove, test, picUploadUrl, picUrl, restoreTo]);
}

export function Testing() {
  const s = useSets();
  const ui = useRunsUi();
  useSetsSync();
  // Try a text runs in the test chat, so the tab reaches the gateway on its own when opened straight from its address.
  useSandboxCall();
  // The chat in the address (`?mode=testing&conv=<id>`) opens once the sets are read; then the address follows you.
  useEffect(() => {
    if (!s.loaded) return;
    const want = lab.setChat;
    if (!s.chat && want && s.convs.some((c) => c.id === want)) setUi({ chat: want });
    else if (!s.chat && s.convs.length) setUi({ chat: s.convs.find((c) => c.set !== "test")?.id ?? null });
  }, [s.loaded, s.chat, s.convs]);
  useEffect(() => {
    if (lab.setChat !== s.chat) set({ setChat: s.chat });
  }, [s.chat]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Z undoes this visit's last change, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redoes it; a box being typed in keeps its own.
      const t = e.target as HTMLElement | null;
      const typing = t && /INPUT|TEXTAREA|SELECT/.test(t.tagName);
      const z = (e.metaKey || e.ctrlKey) && !e.altKey && (e.key.toLowerCase() === "z" || (e.ctrlKey && e.key.toLowerCase() === "y"));
      if (z && !typing) {
        e.preventDefault();
        return undo(e.shiftKey || e.key.toLowerCase() === "y");
      }
      gridKey(e);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  const c = s.convs.find((x) => x.id === s.chat) ?? null;
  // The right panel shows only while there is something to show: a run, a try, or a step's cell picked.
  const step = !!c && !!s.msg && s.msg !== "try" && !!s.col && s.col !== "who" && s.col !== "text" && !c.msgs.find((m) => m.id === s.msg)?.tex;
  const right = ui.open ? <RunsPanel /> : c && s.msg === "try" ? <TryPanel c={c} /> : step ? <Inspector c={c} /> : null;
  return (
    <div className="tst tsx" data-testid="tex-testing">
      <style>{TESTING_CSS}</style>
      <div className="ts-body" style={{ gridTemplateColumns: `${s.fold.sets ? "" : "232px "}minmax(0,1fr)${right ? " 320px" : ""}` }}>
        {s.fold.sets ? null : <SetsList />}
        {c ? (
          <Grid key={c.id} c={c} />
        ) : (
          <div className="ts-mid" id="middle">
            <div className="empty">{s.loaded ? "Pick a chat, or add one with +." : "Reading the sets…"}</div>
          </div>
        )}
        {right ? <div className="ts-det">{right}</div> : null}
      </div>
      {s.problem ? (
        <div className="toast" role="status" onClick={() => setUi({ problem: null })}>
          {s.problem}
        </div>
      ) : null}
    </div>
  );
}
