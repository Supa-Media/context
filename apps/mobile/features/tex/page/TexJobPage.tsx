import { useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text as RNText, TextInput, View } from "react-native";
import { router } from "expo-router";
import { fonts, texPageType } from "../../design/tokens";
import { useFieldFont } from "../../design/fieldFont";
import { onSite } from "./texPageFormat";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { Frame } from "../texComputer";
import { MAX_TYPED } from "../texComputer";
import type { TexComputerState } from "../useTexComputer";
import { Ghost, LinkWord, T, pageStyles, useNow } from "./TexPageParts";
import { MinionFigure } from "./TexMinionFigure";
import { jobFigureOf } from "./minionProps";
import type { ViewProps } from "./TexPageBody";
import { clock, took } from "./texPageFormat";
import type { JobDetail, JobStep } from "./texPageTypes";
import { useTexJob } from "./useTexPage";
import { TexHistoryLines } from "../history/TexHistoryLines";

type LiveFrame = Extract<Frame, { running: true }>;

export interface TexJobPageProps extends ViewProps {
  id: string;
  computer: TexComputerState | null;
  openComputer: () => void;
}

const ENDED_WORD: Record<"done" | "failed" | "stopped", string> = {
  done: "Done",
  failed: "Didn't finish",
  stopped: "Stopped",
};

/** Where a frame's page is, as the mock's address bar writes it: `maritime.sh/docs/agents`. */
function addressOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function liveFrame(frame: Frame | null | undefined): LiveFrame | null {
  return frame && frame.running ? frame : null;
}

/** A result's link: a path inside the app opens in the app, anything else in the browser. */
function openHref(href: string): void {
  if (href.startsWith("/")) router.push(href as never);
  else void Linking.openURL(href);
}

/**
 * One job's page: its figure and title, the live look at Tex's browser when
 * one is running, its steps (a failed one opens to say why and can go to the
 * devs), and the steer and stop row while the job is still going. The mock's
 * `job()` drawn as components; every word is `texPageFormat`'s or the mock's.
 */
export function TexJobPage(props: TexJobPageProps) {
  const { id, computer, openComputer, source, chat, page } = props;
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const now = useNow();
  const read = useTexJob(source, chat, id, page);
  const field = useFieldFont(texPageType.field);
  const [openWhy, setOpenWhy] = useState<Record<number, boolean>>({});
  const [sent, setSent] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState("");

  if (read === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} testID="tex-job-loading" />
      </View>
    );
  }
  if (read.kind === "notYours") {
    return (
      <T size={13} tone="muted" testID="tex-job-not-yours">
        This job isn't in this chat.
      </T>
    );
  }
  if (read.kind === "failed") {
    return (
      <T size={13} tone="muted" testID="tex-job-failed">
        Can't load this job right now.
      </T>
    );
  }

  const job: JobDetail = read.value;
  const live = job.state === "running" || job.state === "waiting";
  // Tex has one browser and several jobs: show it on this job's page only when this job is on that site.
  const frame = live ? liveFrame(computer?.frame) : null;
  const watching = frame !== null && onSite(job, frame.url) ? frame : null;
  const lastIndex = job.steps.length - 1;
  const lastStep: JobStep | undefined = job.steps[lastIndex];

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    void page.act({ type: "steer", job: id, text });
    setDraft("");
  };

  const report = async (index: number) => {
    const answer = await page.act({ type: "report", job: id, step: index });
    if (answer.ok) setSent((was) => ({ ...was, [index]: true }));
  };

  const canSend = draft.trim().length > 0;
  const ended = !live && (job.state === "done" || job.state === "failed" || job.state === "stopped") ? job.state : null;
  const tookMs = (job.endedAt ?? now) - job.startedAt;
  const summary = job.result?.summary ?? `${job.steps.length} step${job.steps.length === 1 ? "" : "s"}`;
  const href = job.result?.href;

  return (
    <View style={styles.head} testID="tex-job">
      <MinionFigure {...jobFigureOf(job)} size={64} testID="tex-job-figure" />
      <View style={styles.detail}>
        <T size={26} serif line={1.25} testID="tex-job-title">
          {job.title}
        </T>
        {job.ranOn ? (
          // Where a machine's job runs (owner, 2026-11-04: a job on their computer looked like a cloud job). A cloud job says nothing.
          <T size={13} tone="muted" testID="tex-job-where">
            {job.tool ? `${job.ranOn} · ${job.tool}` : job.ranOn}
          </T>
        ) : null}

        {watching ? (
          <Pressable accessibilityRole="button" onPress={openComputer} style={styles.mini} testID="tex-computer-mini">
            <View style={styles.scr}>
              <RNText numberOfLines={1} style={styles.url}>
                {addressOf(watching.url)}
              </RNText>
              <Image source={{ uri: `data:image/jpeg;base64,${watching.frame}` }} style={styles.picture} resizeMode="cover" />
            </View>
            <View style={styles.miniText}>
              <T size={13} weight="600">
                On Tex's computer
                <T size={12} weight="600" tone="crit">
                  {" · live"}
                </T>
              </T>
              <T size={13} tone="muted">
                {`${job.now ?? lastStep?.text ?? ""} Tap to watch or take over.`}
              </T>
            </View>
          </Pressable>
        ) : null}

        <View style={styles.steps}>
          {job.steps.map((step, i) => {
            const isNow = live && i === lastIndex;
            const dotTone = step.failed ? colors.crit : isNow ? colors.accent : colors.lineStrong;
            const why = openWhy[i] === true;
            return (
              <View key={i} style={styles.stepRow} testID={`tex-step-${i}`}>
                <View style={[styles.dot, { backgroundColor: dotTone }]} />
                <View style={styles.stepBody}>
                  <T size={14} tone={step.failed ? "crit" : isNow ? "text" : "text2"}>
                    {step.text}
                  </T>
                  {step.failed ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setOpenWhy((was) => ({ ...was, [i]: !why }))}
                        style={styles.whyToggle}
                        testID={`tex-why-${i}`}
                      >
                        <T size={12} tone="muted">
                          Why ›
                        </T>
                      </Pressable>
                      {why ? (
                        <View style={styles.box}>
                          <T size={13}>{step.why ?? ""}</T>
                          {sent[i] === true ? (
                            <T size={12} tone="muted">
                              Sent to the devs
                            </T>
                          ) : (
                            <Ghost label="Send to devs" onPress={() => void report(i)} testID={`tex-report-${i}`} />
                          )}
                        </View>
                      ) : null}
                    </>
                  ) : null}
                </View>
                <T size={12} tone="muted" mono>
                  {clock(step.at, new Date(now))}
                </T>
              </View>
            );
          })}
        </View>

        {live ? (
          <View style={styles.steer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Tell it something"
              placeholderTextColor={colors.muted}
              maxLength={MAX_TYPED}
              style={[pageStyles(colors).input, styles.input, field]}
              testID="tex-steer-input"
            />
            <Pressable
              accessibilityRole="button"
              onPress={send}
              disabled={!canSend}
              style={styles.button}
              testID="tex-steer-send"
            >
              <T size={13} weight="500">
                Send
              </T>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void page.act({ type: "stop", job: id })}
              style={styles.button}
              testID="tex-stop"
            >
              <T size={13} weight="500" tone="crit">
                Stop
              </T>
            </Pressable>
          </View>
        ) : null}

        {ended !== null ? (
          <T size={13} tone="muted" testID="tex-ended">
            {`${ENDED_WORD[ended]} in ${took(tookMs)} · ${summary}`}
            {href ? (
              <>
                {" · "}
                <LinkWord onPress={() => openHref(href)} testID="tex-result-link">
                  {job.result?.label ?? "Open what it made"}
                </LinkWord>
              </>
            ) : null}
          </T>
        ) : null}

        {/* What the job did, from the chat's one history: its own lines only (decided by the owner, 2026-11-02: "In the chat's history, tagged"). */}
        <View style={styles.work} testID="tex-job-work">
          <T size={15} weight="600">
            What it did
          </T>
          <TexHistoryLines source={source} chat={chat} group={props.group !== null} job={id} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    center: { paddingVertical: 24, alignItems: "center" },
    head: { flexDirection: "column", gap: 14 },
    detail: { gap: 14 },
    work: { gap: 8, marginTop: 12 },
    mini: {
      flexDirection: "row",
      gap: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      padding: 8,
    },
    scr: { width: 132, flexShrink: 0, borderRadius: 6, overflow: "hidden", backgroundColor: colors.appSurface },
    url: {
      fontFamily: fonts.mono,
      fontSize: texPageType.miniAddress,
      color: colors.appMuted,
      paddingVertical: 3,
      paddingHorizontal: 6,
    },
    picture: { width: "100%", aspectRatio: 16 / 10 },
    miniText: { flex: 1, minWidth: 0, gap: 2 },
    steps: { flexDirection: "column" },
    stepRow: { flexDirection: "row", gap: 10, paddingVertical: 5 },
    dot: { width: 6, height: 6, borderRadius: 3, marginTop: 8, flexShrink: 0 },
    stepBody: { flex: 1, minWidth: 0 },
    whyToggle: { alignSelf: "flex-start", paddingVertical: 2 },
    box: {
      marginTop: 6,
      backgroundColor: colors.critWash,
      borderRadius: 8,
      paddingVertical: 9,
      paddingHorizontal: 11,
      gap: 8,
    },
    steer: { flexDirection: "row", gap: 8, alignItems: "center" },
    input: { flex: 1, minWidth: 0 },
    button: {
      height: 36,
      borderRadius: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface,
      justifyContent: "center",
    },
  });
