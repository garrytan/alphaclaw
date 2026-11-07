// Agent Relay is on by default, and on an onboarded boot it downloads its
// engine binary from GitHub. A test that boots alphaclaw must not reach the
// network or start a relay engine it did not ask for, so every tier runs with
// ALPHACLAW_RELAY=off unless the caller set it. Relay tests pass their own env
// (tests/server/relay/**, tests/live/relay.e2e.test.js). Runs in the main
// process before any worker forks, so every worker inherits it.
//
// The relay's brain archive runs gbrain when it finds one (/usr/local/bin/gbrain
// or gbrain on PATH); a test must never write to a real brain on the machine
// running it, so ALPHACLAW_RELAY_BRAIN=off unless the caller set it. Archive
// tests point ALPHACLAW_RELAY_BRAIN_BIN at tests/fixtures/fake-gbrain.js.
export default function setup() {
  if (process.env.ALPHACLAW_RELAY === undefined) process.env.ALPHACLAW_RELAY = "off";
  if (process.env.ALPHACLAW_RELAY_BRAIN === undefined) process.env.ALPHACLAW_RELAY_BRAIN = "off";
}
