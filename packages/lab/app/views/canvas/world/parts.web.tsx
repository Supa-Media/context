/**
 * Small pieces the made-up chat's views share (artboards of `group-chat-sim-artboards/`): a person's avatar in the
 * one visual language (on Context filled, not on Context a dashed ring, invited by number purple with a badge, Tex an
 * ink circle), and a "Tex can see" chip.
 */
import type { Account, SeeChip } from "./worldModel";
import { initial } from "./worldModel";

const AV: Record<Account, string> = { on: "on", off: "off", invited: "inv" };

export function Av({ name, account, size }: { name: string; account: Account | "tex"; size?: number }) {
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.43) } : undefined;
  if (account === "tex") {
    return (
      <span className="av tex" style={size ? { ...style, fontSize: Math.round(size * 0.36) } : undefined}>
        Tex
      </span>
    );
  }
  return (
    <span className={"av " + AV[account]} style={style} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/** One chip of "Tex can see": a workspace Tex sees (and how), one kept out (and by whom), or this chat's notes. */
export function WsChip({ c }: { c: SeeChip }) {
  if (c.kind === "home")
    return (
      <span className="wsr home" title="Tex always has this chat's own notes">
        <span className="d" />
        This chat&apos;s notes
      </span>
    );
  if (c.kind === "ok")
    return (
      <span className="wsr" data-ws={c.slug}>
        <span className="d" />
        {c.name}
        <span className="s">· {c.note}</span>
      </span>
    );
  return (
    <span className={"wsr out" + (c.was ? " chg" : "")} data-ws={c.slug}>
      <span className="d" />
      {c.name}
      <span className="s">
        · kept out{c.by.length ? " by " : ""}
        {c.by.length ? <b>{c.by.join(", ")}</b> : null}
      </span>
      {c.was ? <span className="was">was {c.was}</span> : null}
    </span>
  );
}
