// One Gateway RPC over the pinned OpenClaw's own WebSocket client, connected
// with operator.admin (the CLI's `gateway call` asks for the least scope a
// method needs, so its chat.send never carries admin). Prints the response
// payload as one JSON line. Usage:
//   OPENCLAW_GATEWAY_URL=ws://127.0.0.1:<port> OPENCLAW_GATEWAY_TOKEN=<token> \
//     node gateway-admin-call.mjs <method> '<params json>'
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const [method, paramsJson = "{}"] = process.argv.slice(2);
const timer = setTimeout(() => {
  process.stderr.write("gateway-admin-call: timed out\n");
  process.exit(2);
}, 30_000);

const client = new GatewayClient({
  url: process.env.OPENCLAW_GATEWAY_URL,
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  scopes: ["operator.admin"],
  onHelloOk: async () => {
    try {
      const payload = await client.request(method, JSON.parse(paramsJson));
      process.stdout.write(JSON.stringify(payload ?? null) + "\n");
      clearTimeout(timer);
      client.stop();
      process.exit(0);
    } catch (error) {
      process.stderr.write("gateway-admin-call: " + String(error?.message || error) + "\n");
      process.exit(1);
    }
  },
  onConnectError: (error) => {
    process.stderr.write("gateway-admin-call: connect failed: " + String(error?.message || error) + "\n");
    process.exit(1);
  },
});
client.start();
