/**
 * Comments and Tex on a sheet's cell (Dev, 2026-11-27; artboards in the
 * project's cell-comments-artboards, approved the same day). A cell is treated
 * as a note's highlighted words, and everything else is the note's comment
 * system unchanged:
 *
 *  - **A selected cell shows the selection toolbar**, the same dark bar with
 *    Comment (⌘M) and Tex (⌘L), on the cell's own top-right corner, so it
 *    covers no other row's value.
 *  - **A thread opens in the note's card** (`popoverDom.ts`), 8px under the
 *    cell, its header naming the cell ("In a group · row 2").
 *  - **On a phone** a selected cell shows the note phone's Comment chip on its
 *    own bottom edge, which opens the note's bottom sheet.
 *  - **@Tex in a message starts a run** with the cell as its context; Tex may
 *    change any cell of the sheet, add rows and delete rows, and its answer and
 *    its changes land as one step ⌘Z takes back (`cellNotes.ts`).
 *
 * The grid is React Native; these pieces are the comment system's own DOM
 * (`dom.ts`, `popoverDom.ts`, its stylesheet), kept on `<body>` and placed
 * over the cell, so the grid's scrolling boxes never clip them.
 */

import { useEffect, useRef, useState } from "react";
import type { CommentEvent } from "@context/shared/src/comments.cjs";
import { useColors } from "../../../design/theme";
import { isApplePlatform } from "../../../design/applePlatform";
import { ensureStyles } from "../liveEditorWeb/stylesheet";
import { button, carryOver, composer, el, message, report } from "../comments/dom";
import { buildCard, chatIcon, type CardActions, type CardModel } from "../comments/popoverDom";
import { mayDelete, messages, quoteLabel, resolvedBy } from "../comments/model";
import { TEX_AUTHOR } from "../comments/tex/contract";
import { shouldAskTex, type TexRunLive } from "../comments/tex/runner";
import { texMarkNode } from "../../../chaos/texMarkDom";
import { addCellThread, addToCellThread, applyTexAnswer, deleteCellComment, threadById, threadInText, type CellThread } from "./cellNotes";
import { cellRequest, readCellRun } from "./cellTexRun";
import type { CellCommentsProps, OpenCell } from "./cellCommentsProps";

/** The card's gap under its cell, and how far the bar and the phone chip sit into the cell's edge. */
const CARD_GAP = 8;
const BAR_INSET = 6;
const CARD_WIDTH = 420;
const EDGE = 8;

export function CellComments(props: CellCommentsProps) {
  const colors = useColors();
  useEffect(() => ensureStyles(colors), [colors]);
  const [runs, setRuns] = useState<ReadonlyMap<string, TexRunLive>>(new Map());
  const controllers = useRef(new Map<string, AbortController>());
  const latest = useRef(props);
  latest.current = props;
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    [],
  );

  const setRun = (thread: string, run: TexRunLive | null) =>
    setRuns((map) => {
      const next = new Map(map);
      if (run === null) next.delete(thread);
      else next.set(thread, run);
      return next;
    });

  /** Start Tex on `thread` for the message `ask`, already written to it. */
  const startRun = (thread: string, ask: string, written: string) => {
    const now = latest.current;
    const host = now.tex;
    const note = host?.note() ?? null;
    // From the text just written: the grid has not drawn the new comment yet.
    const found = threadInText(written, thread);
    if (host === null || note === null || found === null) return;
    controllers.current.get(thread)?.abort();
    const controller = new AbortController();
    controllers.current.set(thread, controller);
    setRun(thread, { thread, label: "Reading", steps: [], typing: null, error: null });
    host.onRunning?.(true);
    const request = cellRequest(note, { row: found.row, column: found.column, value: now.valueAt(found.row, found.column) }, found.thread, ask);
    void readCellRun(host, request, controller.signal, (label) => setRun(thread, { thread, label, steps: [], typing: null, error: null })).then((outcome) => {
      if (controllers.current.get(thread) !== controller) return;
      controllers.current.delete(thread);
      if (controllers.current.size === 0) host.onRunning?.(false);
      if ("error" in outcome) {
        setRun(thread, { thread, label: "", steps: [], typing: null, error: outcome.error });
        return;
      }
      let refused = false;
      latest.current.commit((text) => {
        const applied = applyTexAnswer(text, thread, outcome.answer, outcome.changes, TEX_AUTHOR);
        if (applied.error !== undefined) return text;
        refused = applied.refused === true;
        return applied.text;
      });
      setRun(thread, null);
      if (refused) latest.current.say("Tex's change named a column or row this sheet doesn't have, so nothing in the sheet changed.");
      if (outcome.runId !== null) host.onRunDone?.(outcome.runId);
    });
  };

  /** Write a message: a new thread on the open cell, or a reply. Returns an error to show, or null. */
  const send = (open: OpenCell, body: string): string | null => {
    const now = latest.current;
    if (now.viewer === null) return "Sign in to comment.";
    const viewer = now.viewer;
    let error: string | null = null;
    let thread = open.thread;
    let written: string | null = null;
    const before = thread === null ? null : (threadById(now.threads(), thread)?.thread ?? null);
    now.commit((text) => {
      if (thread === null) {
        const added = addCellThread(text, { row: open.row, column: open.column }, viewer, body);
        if ("error" in added) {
          error = added.error;
          return text;
        }
        thread = added.thread;
        written = added.text;
        return added.text;
      }
      const replied = addToCellThread(text, thread, "comment", viewer, body);
      if (replied.error !== undefined) {
        error = replied.error;
        return text;
      }
      written = replied.text;
      return replied.text;
    });
    if (error !== null || thread === null || written === null) return error ?? "That comment could not be written.";
    if (open.thread === null) now.onOpen({ ...open, thread, prefill: "" });
    if (now.tex !== null && shouldAskTex(before, body)) startRun(thread, body, written);
    return null;
  };

  const act = (edit: (text: string) => { text?: string; error?: string }): string | null => {
    let error: string | null = null;
    latest.current.commit((text) => {
      const done = edit(text);
      if (done.error !== undefined || done.text === undefined) {
        error = done.error ?? "That could not be done.";
        return text;
      }
      return done.text;
    });
    return error;
  };

  const actions = (open: OpenCell): CardActions => ({
    send: (body) => send(open, body),
    close: () => latest.current.onOpen(null),
    resolve: (thread, resolve) => act((text) => addToCellThread(text, thread, resolve ? "resolved" : "reopened", latest.current.viewer ?? "@you")),
    keep: () => null,
    undo: () => null,
    remove: (thread, index, event) => {
      const error = act((text) => deleteCellComment(text, thread, index, event));
      if (error === null && index === 0) latest.current.onOpen(null);
      return error;
    },
  });

  return (
    <>
      <Toolbar {...props} />
      {props.compact ? <PhoneSheet {...props} runs={runs} actions={actions} /> : <Card {...props} runs={runs} actions={actions} />}
    </>
  );
}

type Inner = CellCommentsProps & { runs: ReadonlyMap<string, TexRunLive>; actions: (open: OpenCell) => CardActions };

/** A DOM node on `<body>` for as long as the component lives. */
function useLayer(make: () => HTMLElement): HTMLElement {
  const ref = useRef<HTMLElement | null>(null);
  ref.current ??= make();
  useEffect(() => {
    const node = ref.current!;
    document.body.append(node);
    return () => node.remove();
  }, []);
  return ref.current;
}

/** Calls `place` now and again whenever anything scrolls or the window resizes. */
function useFollow(place: () => void, deps: unknown[]) {
  const placeRef = useRef(place);
  placeRef.current = place;
  useEffect(() => {
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => placeRef.current());
    };
    placeRef.current();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    const timer = setInterval(again, 400);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** The wide pane's bar: Comment and Tex, on the selected cell's top-right corner. */
function Toolbar(props: CellCommentsProps) {
  const mac = isApplePlatform();
  const bar = useLayer(() => {
    const node = el("div", "cm-seltool");
    node.setAttribute("role", "toolbar");
    node.setAttribute("aria-label", "Cell");
    node.style.position = "fixed";
    node.hidden = true;
    node.addEventListener("mousedown", (event) => event.preventDefault());
    return node;
  });
  const shown = !props.compact && props.editable && props.selection !== null && !props.editing && props.open === null;
  const withTex = props.tex !== null;
  useEffect(() => {
    const tool = (label: string, shortcut: string, face: Node, run: () => void) => {
      const node = el("button", "cm-seltool-btn");
      node.type = "button";
      node.title = `${label} (${shortcut})`;
      node.setAttribute("aria-label", `${label}, ${shortcut}`);
      node.append(face, el("kbd", undefined, shortcut));
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        run();
      });
      return node;
    };
    const key = (letter: string) => (mac ? `⌘${letter}` : `Ctrl+${letter}`);
    const buttons = [tool("Comment", key("M"), chatIcon(), () => props.onStart(false))];
    if (withTex) buttons.push(tool("Ask Tex", key("L"), texMarkNode("cm-texbtn", 16), () => props.onStart(true)));
    bar.replaceChildren(...buttons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar, withTex, mac]);
  useFollow(() => {
    const cell = shown && props.selection ? props.cellNode(props.selection.row, props.selection.col) : null;
    if (cell === null) {
      bar.hidden = true;
      return;
    }
    const box = cell.getBoundingClientRect();
    bar.hidden = false;
    // Lifted so only its bottom edge sits in the cell's corner: inside the first line it would cover the cell's own value.
    bar.style.top = `${Math.round(box.top + BAR_INSET - bar.offsetHeight)}px`;
    bar.style.left = `${Math.round(box.right - BAR_INSET - bar.offsetWidth)}px`;
  }, [shown, props.selection?.row, props.selection?.col]);
  return null;
}

/** "In a group · row 2": the cell a thread is on. */
function contextOf(props: CellCommentsProps, open: OpenCell): string {
  return `${open.column} · row ${props.rowNumber(open.row)}`;
}

function cardModel(props: Inner, open: OpenCell): { model: CardModel; thread: CellThread | null } {
  const found = open.thread === null ? null : threadById(props.threads(), open.thread);
  const thread = found?.thread ?? null;
  const viewer = props.viewer;
  return {
    thread: found,
    model: {
      draft: thread === null,
      thread,
      prefill: open.prefill,
      viewer,
      editable: props.editable && viewer !== null,
      tex: props.tex !== null,
      people: props.tex?.people() ?? [],
      run: thread === null ? null : (props.runs.get(thread.id) ?? null),
      texStates: (thread?.events ?? []).map(() => null),
      deletable: (thread?.events ?? []).map((event: CommentEvent) => event.kind === "comment" && event.author !== TEX_AUTHOR && mayDelete(event.author, viewer, props.moderator)),
      context: contextOf(props, open),
    },
  };
}

/** The wide pane's card, under the open cell. */
function Card(props: Inner) {
  const host = useLayer(() => {
    const node = el("div");
    node.style.position = "fixed";
    node.style.inset = "0";
    node.style.pointerEvents = "none";
    node.style.zIndex = "1000";
    return node;
  });
  const open = props.open;
  const built = open === null ? null : cardModel(props, open);
  const signature = built === null ? null : JSON.stringify([open, built.model.thread?.events.map((e) => [e.at, e.author, e.kind, e.text]), built.model.thread?.status, built.model.run, built.model.editable, built.model.context, built.model.people.length]);
  useEffect(() => {
    if (open === null || built === null) {
      host.replaceChildren();
      return;
    }
    const card = buildCard(built.model, props.actions(open)).root;
    card.style.pointerEvents = "auto";
    card.style.position = "fixed";
    card.style.width = `${Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2)}px`;
    card.addEventListener("keydown", (event) => event.stopPropagation());
    const previous = host.firstElementChild as HTMLElement | null;
    if (previous) {
      carryInput(previous, card);
      card.style.top = previous.style.top;
      card.style.left = previous.style.left;
      card.style.animation = "none";
    }
    host.replaceChildren(card);
    if (previous === null) queueMicrotask(() => card.querySelector<HTMLInputElement>("input.cm-cwin")?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useFollow(() => {
    const card = host.firstElementChild as HTMLElement | null;
    if (open === null || card === null) return;
    const cell = props.cellNode(open.row, open.column);
    if (cell === null) return;
    const box = cell.getBoundingClientRect();
    const height = card.offsetHeight;
    const below = box.bottom + CARD_GAP;
    const top = below + height > window.innerHeight - EDGE && box.top - CARD_GAP - height > EDGE ? box.top - CARD_GAP - height : below;
    const left = Math.max(EDGE, Math.min(box.left, window.innerWidth - card.offsetWidth - EDGE));
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
  }, [signature]);
  return null;
}

/** Keep a half-typed message, and its focus, across a rebuild of the card. */
function carryInput(from: HTMLElement, to: HTMLElement) {
  const before = from.querySelector<HTMLInputElement>("input.cm-cwin");
  const after = to.querySelector<HTMLInputElement>("input.cm-cwin");
  if (!before || !after) return;
  const focused = document.activeElement === before;
  if (before.value) after.value = before.value;
  if (focused) queueMicrotask(() => after.focus({ preventScroll: true }));
}

/** The phone: a Comment chip on the selected cell's bottom edge, and the note's bottom sheet for the thread. */
function PhoneSheet(props: Inner) {
  const chip = useLayer(() => {
    const node = button("Comment", "cm-cmt-float", () => latest.current.onStart(false));
    node.style.position = "fixed";
    node.hidden = true;
    node.setAttribute("aria-label", "Comment on this cell");
    return node;
  });
  const latest = useRef(props);
  latest.current = props;
  const layer = useLayer(() => {
    const node = el("div", "cm-cmt-sheet-layer cm-cmt-sheet-viewport");
    node.hidden = true;
    const scrim = el("div", "cm-cmt-scrim");
    scrim.addEventListener("click", () => latest.current.onOpen(null));
    const panel = el("div", "cm-cmt-sheet");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Comment thread");
    panel.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") latest.current.onOpen(null);
    });
    node.append(scrim, panel);
    return node;
  });

  const selected = props.selection;
  const onCell = selected === null ? null : props.threadOn(selected.row, selected.col);
  const count = onCell === null ? 0 : messages(onCell.thread).length;
  const chipShown = props.selection !== null && !props.editing && props.open === null && (props.editable || onCell !== null);
  useFollow(() => {
    const cell = chipShown && selected ? props.cellNode(selected.row, selected.col) : null;
    if (cell === null) {
      chip.hidden = true;
      return;
    }
    chip.textContent = count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : "Comment";
    chip.hidden = false;
    const box = cell.getBoundingClientRect();
    // Under the cell, not over it: the cell's own words stay readable (a full cell has no room at its foot).
    chip.style.top = `${Math.round(box.bottom + BAR_INSET)}px`;
    chip.style.left = `${Math.round(box.left + (box.width - chip.offsetWidth) / 2)}px`;
  }, [chipShown, selected?.row, selected?.col, count]);

  const open = props.open;
  const built = open === null ? null : cardModel(props, open);
  const signature = built === null ? null : JSON.stringify([open, built.model.thread?.events.map((e) => [e.at, e.author, e.kind, e.text]), built.model.thread?.status, built.model.run, built.model.editable]);
  useEffect(() => {
    const panel = layer.lastElementChild as HTMLElement;
    if (open === null || built === null) {
      layer.hidden = true;
      panel.replaceChildren();
      return;
    }
    const next = el("div", "cm-cmt-sheet-body");
    fillSheet(next, props, open, built.model, props.actions(open));
    const previous = panel.firstElementChild as HTMLElement | null;
    if (previous) carryOver(previous, next);
    panel.replaceChildren(next);
    const opening = layer.hidden;
    layer.hidden = false;
    if (opening && built.model.draft) queueMicrotask(() => panel.querySelector("textarea")?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return null;
}

/** The note's phone sheet for a cell's thread: the cell's value as its title, the cell under it, the messages, a reply. */
function fillSheet(body: HTMLElement, props: Inner, open: OpenCell, model: CardModel, actions: CardActions) {
  body.append(el("div", "cm-cmt-grab"));
  const head = el("div", "cm-cmt-sheet-head");
  const titles = el("div");
  titles.style.flex = "1";
  titles.style.minWidth = "0";
  const title = el("h3", "cm-cmt-sheet-title", `On “${quoteLabel(props.valueAt(open.row, open.column).trim().replace(/^["“'](.*)["”']$/s, "$1"))}”`);
  title.style.whiteSpace = "nowrap";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  const where = el("div", "cm-cmt-when", contextOf(props, open));
  titles.append(title, where);
  head.append(titles);
  const thread = model.thread;
  if (thread !== null && thread.status === "resolved") head.append(el("span", "cm-cmt-badge", "Resolved"));
  const close = button("×", "cm-cmt-close", () => actions.close());
  close.setAttribute("aria-label", "Close");
  head.append(close);
  body.append(head);

  const placeholder = "Reply, or @Tex to ask Tex";
  if (thread === null) {
    if (!model.editable) return;
    const { root, input } = composer("Comment, or @Tex to ask Tex", (text) => actions.send(text), () => actions.close());
    if (model.prefill) input.value = model.prefill;
    const row = el("div", "cm-cmt-actions");
    row.append(
      button("Cancel", "cm-cmt-link", () => actions.close()),
      button("Comment", "cm-cmt-primary", () => {
        const text = input.value.trim();
        if (!text) return input.focus();
        const error = actions.send(text);
        // Cleared before the thread is drawn, so the sent words are not carried into its reply box.
        if (error === null) input.value = "";
        report(body, error);
      }),
    );
    body.append(root, row);
    return;
  }

  const list = el("div", "cm-cmt-sheet-list");
  messages(thread).forEach((event) => {
    const index = thread.events.filter((e) => e.kind === "comment").indexOf(event);
    const at = thread.events.indexOf(event);
    const deletion = model.deletable[at] ? { thread: index === 0, run: () => actions.remove(thread.id, index, event) } : undefined;
    list.append(message(event.author, event.at, event.text, deletion));
  });
  if (model.run !== null) list.append(el("div", model.run.error === null ? "cm-cmt-detached" : "cm-cmt-problem", model.run.error ?? `Tex · ${model.run.label || "Working"}…`));
  body.append(list);

  const closed = resolvedBy(thread);
  if (closed) {
    const line = el("div", "cm-cmt-resolved", `Resolved by ${closed.author}`);
    if (model.editable) line.append(button("Reopen", "cm-cmt-link", () => report(body, actions.resolve(thread.id, false))));
    body.append(line);
    return;
  }
  if (!model.editable) return;
  const { root, input } = composer(placeholder, (text) => actions.send(text), () => actions.close());
  const row = el("div", "cm-cmt-actions");
  row.append(
    button("Resolve", "cm-cmt-resolve", () => report(body, actions.resolve(thread.id, true))),
    button("Reply", "cm-cmt-primary", () => {
      const text = input.value.trim();
      if (!text) return input.focus();
      const error = actions.send(text);
      if (error === null) input.value = "";
      report(body, error);
    }),
  );
  body.append(root, row);
}

export type { OpenCell };
