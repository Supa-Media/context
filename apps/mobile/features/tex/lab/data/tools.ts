/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/admin/lab): Tex's
 * tool inventory (TOOL_INV): name, read or change, what it does, and its actions.
 */


export const TOOL_INV: Array<[string, "read" | "change", string, string[]]> = [
 ["orient","read","Front page, recent notes, the map",[]],["search","read","Find notes",[]],["fetch","read","Read a note",[]],
 ["write","change","Save and remember",["save","save_many","comment","mail","upload","remember","answer","update_answer","retract_answer","vote","save_session","report_problem"]],
 ["manage","change","Move, share, set up",["move","move_many","move_folder","archive","visibility","folder_visibility","encrypt","suggest_destination","website","share_link","revoke_link","vault_add","vault_share","vault_view","create_workspace","invite","layout","folder_job","connect_google","connect","dream_now","fill_dates","pair_device"]],
 ["send","change","Reach out and change Tex",["api","email","email_draft","notify","slack","app","google_chat","calendar","forward_rule","tex_settings","tex_instructions","chat_mute","chat_status","chat_share_mail","chat_unshare_mail","review_sharing","computers","setting","chat_add_everyone","vault_access","name_guest","ask_personal_tex"]],
 ["search_web","read","Search the web",[]],["open_page","read","Open a web page",[]],["ask_advisor","read","Ask the advisor",[]],["read_skill","read","Read a skill",[]],["say_nothing","read","Stay quiet",[]]];
