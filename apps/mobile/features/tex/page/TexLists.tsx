import { Fragment, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { useColors } from "../../design/theme";
import type { Read } from "./texPageSource";
import type { ViewProps } from "./TexPageBody";
import { JobRow, LinkWord, ListBox, More, SubPage, T, ThinkBlock, useNow } from "./TexPageParts";
import { actionPieces, clock, draftReason, endedLine, turnHead, turnTail, VERDICT_LABEL } from "./texPageFormat";
import type { AdvisorAsk, ListItems, ListKind, ListPage, MailCheck, Turn, TurnAction, Verdict } from "./texPageTypes";
import { useTexList } from "./useTexPage";

/** Where a turn's action link leads: the advisor's or email check's view, or the job's page. */
function openAction(action: TurnAction, go: ViewProps["go"]): void {
  if (action.kind === "advisor") go({ view: "advisor" });
  else if (action.kind === "mailcheck") go({ view: "mailcheck" });
  else if (action.ref) go({ job: action.ref });
}

function actionNode(action: TurnAction, go: ViewProps["go"], testID: string): ReactNode {
  const piece = actionPieces(action);
  if (!piece.link) return piece.before;
  return (
    <>
      {piece.before}
      <LinkWord testID={testID} onPress={() => openAction(action, go)}>
        {`${piece.link} ›`}
      </LinkWord>
      {piece.after}
    </>
  );
}

/** One text Tex got and what it did with it. Shared with the home feed's thinking list. */
export function TurnBlock({ turn, go }: { turn: Turn; go: ViewProps["go"] }) {
  const now = useNow();
  const segments: { key: string; node: ReactNode }[] = [
    ...turn.did.map((action, i) => ({ key: `a${i}`, node: actionNode(action, go, `tex-think-${turn.at}-link-${i}`) })),
    ...turnTail(turn).map((text, i) => ({ key: `t${i}`, node: text })),
  ];
  return (
    <ThinkBlock testID={`tex-think-${turn.at}`}>
      <T size={13} tone="muted">
        {turnHead(turn, new Date(now))}
      </T>
      <T size={15} serif line={1.55}>
        {turn.thought}
      </T>
      <T size={13} tone="muted">
        {segments.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 ? " · " : null}
            {s.node}
          </Fragment>
        ))}
      </T>
      {(turn.drafts ?? []).map((draft, i) => (
        <T key={`d${i}`} size={13} tone="muted" testID={`tex-think-${turn.at}-draft-${i}`}>
          {`${draftReason(draft)}: “${draft.text}”${draft.notice ? ` (${draft.notice})` : ""}`}
        </T>
      ))}
    </ThinkBlock>
  );
}

function AdvisorBlock({ ask }: { ask: AdvisorAsk }) {
  const now = useNow();
  return (
    <ThinkBlock testID={`tex-advisor-${ask.id}`}>
      <T size={13} tone="muted">
        {`${clock(ask.at, new Date(now))} · ${ask.job ?? "Your texts"} · Tex asked`}
      </T>
      <T>{`“${ask.question}”`}</T>
      <T size={15} serif line={1.55}>
        {ask.answer}
      </T>
      <T size={12} mono tone="muted">
        {`${ask.read} · ${Math.round(ask.ms / 1000)} s`}
      </T>
    </ThinkBlock>
  );
}

const TAGS: Record<Verdict, { tone: "ok" | "warn" | "crit"; wash: "okWash" | "warnWash" | "critWash" }> = {
  sent: { tone: "ok", wash: "okWash" },
  waiting: { tone: "warn", wash: "warnWash" },
  stopped: { tone: "crit", wash: "critWash" },
};

function MailCheckBlock({ check }: { check: MailCheck }) {
  const colors = useColors();
  const now = useNow();
  const tag = TAGS[check.verdict];
  return (
    <ThinkBlock testID={`tex-mailcheck-${check.id}`}>
      <View style={{ alignSelf: "flex-start", paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, backgroundColor: colors[tag.wash] }}>
        <T size={11} weight="600" tone={tag.tone} style={{ letterSpacing: 0.33 }}>
          {VERDICT_LABEL[check.verdict]}
        </T>
      </View>
      <T>{`To ${check.to} · “${check.subject}”`}</T>
      <T size={15} serif line={1.55}>
        {check.why}
      </T>
      <T size={12} mono tone="muted">
        {`${clock(check.at, new Date(now))} · from ${check.from}`}
      </T>
    </ThinkBlock>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <T size={13} tone="muted">
      {children}
    </T>
  );
}

/** A list's body: a spinner until it is read, a quiet line when it cannot be or is empty, else its rows and "Show more". */
function ListBody<K extends ListKind>({
  kind,
  read,
  more,
  empty,
  open = false,
  render,
}: {
  kind: K;
  read: Read<ListPage<K>> | null;
  more: () => Promise<void>;
  empty: string;
  open?: boolean;
  render: (item: ListItems[K]) => ReactNode;
}) {
  if (read === null) return <ActivityIndicator size="small" />;
  if (read.kind !== "ok") return <Quiet>Couldn&apos;t load this right now.</Quiet>;
  const { items, cursor } = read.value;
  if (items.length === 0) return <Quiet>{empty}</Quiet>;
  return (
    <>
      <ListBox open={open}>
        {items.map((item, i) => (
          <Fragment key={i}>{render(item)}</Fragment>
        ))}
      </ListBox>
      {cursor ? (
        <More testID={`tex-more-${kind}`} onPress={() => void more()}>
          Show more
        </More>
      ) : null}
    </>
  );
}

export function ThinkingPage(props: ViewProps) {
  const { read, more } = useTexList(props.source, props.chat, "thinking", props.page.changes);
  const lead = props.group
    ? "For each text in this chat: what Tex thought, what it did, and what it sent back."
    : "For each of your texts: what Tex thought, what it did, and what it sent back.";
  return (
    <SubPage title="Tex's thinking" lead={lead} testID="tex-thinking-page">
      <ListBody
        kind="thinking"
        read={read}
        more={more}
        empty="No texts yet."
        open
        render={(turn) => <TurnBlock turn={turn} go={props.go} />}
      />
    </SubPage>
  );
}

export function JobsPage(props: ViewProps) {
  const { read, more } = useTexList(props.source, props.chat, "jobs", props.page.changes);
  const now = useNow();
  return (
    <SubPage title="This week" lead="What Tex finished in the last 7 days. Tap one to see its steps." testID="tex-jobs-page">
      <ListBody
        kind="jobs"
        read={read}
        more={more}
        empty="Nothing finished in the last 7 days."
        render={(job) => (
          <JobRow
            testID={`tex-job-${job.id}`}
            title={job.title}
            right={endedLine(job, now)}
            onPress={() => props.go({ job: job.id })}
          />
        )}
      />
    </SubPage>
  );
}

export function AdvisorPage(props: ViewProps) {
  const { read, more } = useTexList(props.source, props.chat, "advisor", props.page.changes);
  return (
    <SubPage
      title="Advisor"
      lead="The deeper thinker Tex asks when a job gets hard. Each ask, and what it said back."
      testID="tex-advisor-page"
    >
      <ListBody
        kind="advisor"
        read={read}
        more={more}
        empty="No asks this week."
        open
        render={(ask) => <AdvisorBlock ask={ask} />}
      />
    </SubPage>
  );
}

export function MailcheckPage(props: ViewProps) {
  const { read, more } = useTexList(props.source, props.chat, "mailcheck", props.page.changes);
  return (
    <SubPage
      title="Email check"
      lead="Every email Tex writes is read here before it goes. Its verdict and why."
      testID="tex-mailcheck-page"
    >
      <ListBody
        kind="mailcheck"
        read={read}
        more={more}
        empty="No emails checked this week."
        open
        render={(check) => <MailCheckBlock check={check} />}
      />
    </SubPage>
  );
}
