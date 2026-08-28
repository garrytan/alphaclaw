const http = require("http");
const https = require("https");

// Kill HTTP keep-alive for every test.
//
// Node >=19 enables keepAlive on the global agent. Supertest suites spin up
// thousands of throwaway servers on ephemeral ports; a kept-alive socket to
// port P outlives its server's close (close only refuses NEW connections),
// the kernel hands P to the next test's server, and superagent's pool reuses
// the stale socket — so the request is ANSWERED BY THE PREVIOUS TEST'S APP.
// That is the long-standing "1-3 rotating supertest failures" class: 401s
// from apps with no auth, 404s for routes that exist, {} bodies from the
// wrong router. Fresh connections per request make it structurally
// impossible; the per-request cost in tests is noise.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
