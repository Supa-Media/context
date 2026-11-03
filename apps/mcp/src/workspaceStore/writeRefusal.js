/** The refusal a write op throws for a body that is not a write (`serveWrites.js` answers it 422). Its own module, so
 * the op modules (`writeOps.js`, `treeWrites.js`) can share it without importing each other. */
export class WriteOpRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteOpRefused";
  }
}
