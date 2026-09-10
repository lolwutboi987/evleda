import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createKicadToolboxMcpServer } from "./toolbox-server.js";

// The standalone front door supplies verified guidance immediately. CAD is
// composed by an owning host using openKicadToolboxSession; there is deliberately
// no model-selectable runtime, arbitrary configuration loader or implicit editor.
serveStdio(() => createKicadToolboxMcpServer().server, {
  onerror: error => process.stderr.write(`[evleda-toolbox] ${error.message}\n`),
});
