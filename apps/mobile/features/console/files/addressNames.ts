
/**
 * The files whose name is an address rather than a title, which a heading
 * never renames and a rename never retitles: a workspace's front page and
 * to-do list, a folder's `about.md`, `privacy.md`, and every website file —
 * `website/about.md` is the page at `/about`, and its heading is what the page
 * says. Renaming one of those because somebody reworded its heading would
 * take a page off the web or a front note off its folder without a word.
 */
export { nameIsAddress } from "@context/shared/src/linkedHeading";
