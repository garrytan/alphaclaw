// Thin re-export shim: the chat bridge now lives in lib/server/chat/ (route/
// service decomposition). This file keeps `require("./server/chat-ws")` — the
// lib/server.js import and the existing test imports — working unchanged.
// Cleanup task: remove once every import points at lib/server/chat directly.
module.exports = require("./chat");
