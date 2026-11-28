/**
 * Import this from a test that runs Tex's code without loading the gateway itself: it loads the gateway's MCP
 * dispatcher, which connects the parts Tex takes from the gateway (`texContract/contextGateway.cjs`), as the Worker
 * does when it starts. Without it, Tex's `contextMcp.js` refuses loudly rather than answer for a gateway that is not there.
 */
import "../src/tools/session.js";
