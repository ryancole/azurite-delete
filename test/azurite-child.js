"use strict";
// Runs Azurite's own blob CLI (node_modules/azurite/dist/src/blob/main.js) with the
// given arguments. Writing anything to stdin triggers its SIGINT handler, which
// closes the server and flushes the LokiJS database: Windows can't deliver a real
// SIGINT to a child process, and a hard kill could lose the last autosave.
process.stdin.once("data", () => {
  process.stdin.pause();
  process.emit("SIGINT");
  setTimeout(() => process.exit(0), 10000).unref();
});
require("azurite/dist/src/blob/main.js");
