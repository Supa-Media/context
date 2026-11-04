import { TexPageScreen } from "../../../../features/tex/page/TexPageScreen";

/**
 * `/tex/group/<words>`: a group chat's Tex page, addressed by its home's words
 * (`tex/groups/<words>`), the link Tex texts a group asking what it is working
 * on (the owner, 2026-11-03). Signed in, and only for a person in that chat
 * now: the screen finds the group among the chats the gateway lists for them,
 * and words that name none of theirs show the same page as words that name
 * nothing. Its sub-pages are `[...rest].tsx`.
 */
export default function TexGroupPageRoute() {
  return <TexPageScreen />;
}
