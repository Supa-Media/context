/** How many characters one read of a chat's ledger returns (`log.js`). The gateway's ledger page reads with the same budget. */
const READ_CHARS = 120_000;

module.exports = { READ_CHARS };
