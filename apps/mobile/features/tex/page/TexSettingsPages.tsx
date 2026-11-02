import { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { writeClipboard } from "../../design/clipboard";
import { useColors } from "../../design/theme";
import { DEFAULT_HUMOR, TEX_SETTINGS } from "../../console/settings/panels/TexSettings";
import type { TexComputerState } from "../useTexComputer";
import type { ViewProps } from "./TexPageBody";
import { ListBox, ListRow, SubPage, T } from "./TexPageParts";
import { TexSelect, type SelectOption } from "./TexSelect";
import { useTexList } from "./useTexPage";

type Values = Record<string, string | number>;

/** Tex's dial, 0% to 100% in tens. */
const HUMOR: readonly SelectOption[] = Array.from({ length: 11 }, (_, index) => ({
  key: String(index * 10),
  label: `${index * 10}%`,
}));

const ANSWERS: readonly SelectOption[] = [
  { key: "named", label: "When named or asked" },
  { key: "every", label: "Every message" },
];

const GROUP_TONES: readonly SelectOption[] = [
  { key: "default", label: "Default" },
  { key: "friendly", label: "Friendly" },
  { key: "efficient", label: "Efficient" },
];

/**
 * The values as the list read gave them, with a pick shown at once. A pick the
 * gateway refuses is taken back; the overlay is dropped whenever a new read
 * arrives, so the server's copy is what stays on screen.
 */
function useChoices(server: Values | undefined, save: (key: string, value: string | number) => Promise<{ ok: boolean }>) {
  const [local, setLocal] = useState<Values>({});
  useEffect(() => {
    setLocal((was) => (Object.keys(was).length === 0 ? was : {}));
  }, [server]);
  const pick = (key: string, value: string | number) => {
    setLocal((was) => ({ ...was, [key]: value }));
    void save(key, value).then((answer) => {
      if (answer.ok) return;
      setLocal((was) => {
        const next = { ...was };
        delete next[key];
        return next;
      });
    });
  };
  return { current: { ...(server ?? {}), ...local } as Values, pick };
}

/** Settings › Tex: how Tex talks to this person, its number, and the websites it is signed in to. */
export function SettingsPage({ source, page, chat }: ViewProps) {
  const colors = useColors();
  const { read } = useTexList(source, chat, "settings", page.changes);
  const values = read?.kind === "ok" ? read.value.values : undefined;
  const number = read?.kind === "ok" ? read.value.number : undefined;
  const { current, pick } = useChoices(values, (key, value) => page.act({ type: "settings", values: { [key]: value } }));
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <SubPage title="Tex settings" lead="How Tex talks to you. Changes apply to the next text." testID="tex-settings">
      <ListBox>
        {TEX_SETTINGS.map((row) => (
          <ListRow
            key={row.key}
            title={row.label}
            testID={`tex-settings-row-${row.key}`}
            right={
              <TexSelect
                look="sel"
                label={row.label}
                options={row.options}
                selected={String(current[row.key] ?? row.fallback)}
                onPick={(key) => pick(row.key, key)}
                testID={`tex-settings-${row.key}`}
              />
            }
          />
        ))}
        <ListRow
          title="Humor"
          testID="tex-settings-row-humor"
          right={
            <TexSelect
              look="sel"
              label="Humor"
              options={HUMOR}
              selected={String(current.humor ?? DEFAULT_HUMOR)}
              onPick={(key) => pick("humor", Number(key))}
              testID="tex-settings-humor"
            />
          }
        />
      </ListBox>
      <ListBox>
        {number ? (
          <ListRow
            title="Tex's number"
            sub={`${number} · text or iMessage`}
            testID="tex-settings-number"
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy Tex's number"
                onPress={() => {
                  void writeClipboard(number).then((ok) => {
                    if (ok) setCopied(true);
                  });
                }}
                testID="tex-settings-copy"
              >
                <T size={13} tone="text2" numberOfLines={1}>
                  {copied ? "Copied" : "Copy"}
                </T>
              </Pressable>
            }
          />
        ) : null}
        <ListRow
          title="Sign Tex out of websites"
          sub="Clears the sign-ins Tex keeps"
          testID="tex-settings-signout-row"
          right={
            <Pressable accessibilityRole="button" accessibilityLabel="Sign Tex out of websites" onPress={() => setConfirming(true)} testID="tex-settings-signout">
              <T size={13} tone="crit" numberOfLines={1}>
                Sign out
              </T>
            </Pressable>
          }
        />
        {confirming ? (
          <View style={{ paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <T size={13} tone="text2" testID="tex-settings-signout-confirm">
              {"Text Tex “sign out of websites” and it clears them."}
            </T>
          </View>
        ) : null}
      </ListBox>
    </SubPage>
  );
}

/** Group settings: how Tex behaves in one group chat. Changed here, not in the person's own chat. */
export function GroupSettingsPage({ source, page, chat, group }: ViewProps) {
  const { read } = useTexList(source, chat, "settings", page.changes);
  const values = read?.kind === "ok" ? read.value.values : undefined;
  const approver = read?.kind === "ok" ? read.value.approver : undefined;
  const people = read?.kind === "ok" ? (read.value.people ?? []) : [];
  const { current, pick } = useChoices(values, (key, value) => page.act({ type: "group.settings", values: { [key]: value } }));

  return (
    <SubPage title="Group settings" lead={`How Tex behaves in ${group ?? "this chat"}.`} testID="tex-group-settings">
      <ListBox>
        <ListRow
          title="When Tex answers"
          testID="tex-group-row-answers"
          right={
            <TexSelect
              look="sel"
              label="When Tex answers"
              options={ANSWERS}
              selected={String(current.answers ?? "named")}
              onPick={(key) => pick("answers", key)}
              testID="tex-group-answers"
            />
          }
        />
        <ListRow
          title="Who approves sends"
          sub="Emails and invites wait for their yes"
          testID="tex-group-row-approver"
          right={
            approver ? (
              <T size={13} tone="text2" numberOfLines={1}>
                {approver}
              </T>
            ) : null
          }
        />
        <ListRow
          title="Tone"
          testID="tex-group-row-tone"
          right={
            <TexSelect
              look="sel"
              label="Tone"
              options={GROUP_TONES}
              selected={String(current.tone ?? "default")}
              onPick={(key) => pick("tone", key)}
              testID="tex-group-tone"
            />
          }
        />
      </ListBox>
      <ListBox>
        <ListRow
          title="People here"
          sub={people.length > 0 ? people.join(", ") : undefined}
          testID="tex-group-people"
          right={
            <T size={13} tone="text2" numberOfLines={1}>
              {String(people.length)}
            </T>
          }
        />
      </ListBox>
    </SubPage>
  );
}

/** Tex's computer: the browser Tex drives, watched live, and taken over from here. */
export function ComputerPage({
  computer,
  openComputer,
  go,
}: ViewProps & { computer: TexComputerState | null; openComputer: () => void }) {
  const colors = useColors();
  const frame = computer?.frame ?? null;
  const live = frame !== null && frame.running && computer?.phase === "live" ? frame : null;

  let lead: string;
  if (computer === null || computer.phase === "loading") {
    lead = "Looking for Tex's browser…";
  } else if (live !== null) {
    lead = "Live. Watching doesn't interrupt Tex.";
  } else if (computer.phase === "failed" || computer.phase === "notYours") {
    lead = "Tex's browser can't be reached right now.";
  } else {
    lead = "Nothing running right now. When Tex needs you to sign in somewhere, it texts you this page.";
  }

  return (
    <SubPage title="Tex's computer" lead={lead} testID="tex-computer">
      {live !== null ? (
        <>
          <View style={{ borderRadius: 10, overflow: "hidden", backgroundColor: colors.appSurface }}>
            <T size={11} mono numberOfLines={1} style={{ color: colors.appMuted, paddingVertical: 6, paddingHorizontal: 10 }}>
              {addressOf(live.url, live.title)}
            </T>
            <Pressable accessibilityRole="button" accessibilityLabel="Open Tex's browser" onPress={openComputer} testID="tex-computer-frame">
              <Image
                source={{ uri: `data:image/jpeg;base64,${live.frame}` }}
                resizeMode="contain"
                style={{ width: "100%", aspectRatio: live.width / live.height }}
              />
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <SteerButton label="Take over" onPress={openComputer} testID="tex-take-over" />
            <SteerButton label="Sign-ins Tex keeps" onPress={() => go({ view: "settings" })} testID="tex-computer-signins" />
          </View>
        </>
      ) : null}
    </SubPage>
  );
}

/** `.steer button`: a 36-high outlined button beside its sibling. */
function SteerButton({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={{
        height: 36,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.lineStrong,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T size={13} weight="500" line={1}>
        {label}
      </T>
    </Pressable>
  );
}

/** The address bar's text: the host and path of the page, or its title when it has no address yet. */
function addressOf(url: string, title: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.length > 0 ? url : title;
  }
}
