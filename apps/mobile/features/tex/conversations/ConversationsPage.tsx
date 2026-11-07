import { View } from "react-native";
import { ListBox, ListRow, More, SectionHead, SubPage, T, useNow, useWide } from "../page/TexPageParts";
import { ago } from "../page/texPageFormat";
import type { ViewProps } from "../page/TexPageBody";
import { ConversationsList, useConversations } from "./ConversationsList";

/** The Tex page's Conversations page (`view: "conversations"`): every conversation, open first. */
export function ConversationsPage({ source, chat, group }: ViewProps) {
  const wide = useWide();
  return (
    <SubPage
      title={group ? `Conversations · ${group}` : "Conversations"}
      lead="The chat with Tex, by subject. Tap one to see its texts."
      testID="tex-conversations-page"
    >
      <ConversationsList source={source} chat={chat} group={group !== null} phone={!wide} />
    </SubPage>
  );
}

/** How many open conversations the Tex Hub shows. */
export const PEEK = 3;

/**
 * The Tex Hub's Conversations section: the newest few open ones, and the way to
 * all of them. Draws nothing while it reads or when there are none, so a chat
 * that has not been sorted yet shows the hub as it was.
 */
export function ConversationsPeek({ source, chat, go }: Pick<ViewProps, "source" | "chat" | "go">) {
  const loaded = useConversations(source, chat);
  const now = useNow();
  if (loaded.kind !== "ok" || loaded.list.length === 0) return null;
  const open = loaded.list.filter((c) => c.status === "open");
  const finished = loaded.list.length - open.length;
  return (
    <View testID="tex-conversations-peek">
      <SectionHead>{open.length > 0 ? `Conversations · ${open.length} open` : "Conversations"}</SectionHead>
      {open.length > 0 ? (
        <ListBox>
          {open.slice(0, PEEK).map((c) => (
            <ListRow
              key={c.id}
              title={c.title}
              {...(c.description ? { sub: c.description } : {})}
              right={
                <T size={13} tone="text2" numberOfLines={1}>
                  {`${ago(c.last, now)} ›`}
                </T>
              }
              onPress={() => go({ view: "conversations" })}
              testID={`tex-peek-${c.id}`}
            />
          ))}
        </ListBox>
      ) : (
        <T size={13} tone="muted">
          Nothing open right now.
        </T>
      )}
      <More onPress={() => go({ view: "conversations" })} testID="tex-more-conversations">
        {finished > 0 ? `All conversations · ${finished} finished ›` : "All conversations ›"}
      </More>
    </View>
  );
}
