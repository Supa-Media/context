/**
 * The `source`s of a text Tex sends on its own (`sentOnItsOwn.js`): each has a gateway note beside it, so readers
 * show the note and drop the linked text event. The gateway's conversations page reads the same set.
 */

/** The `source` of a text Tex sent on its own, outside a reply to a text: these have a gateway note beside them. */
const OWN_SOURCES = new Set(["checkin", "routine", "ping", "update", "job", "new_line", "notice"]);

module.exports = { OWN_SOURCES };
