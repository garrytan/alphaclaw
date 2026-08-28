const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createBuzzSetup,
  kBuzzStateFileName,
} = require("../../lib/server/buzz-setup");
const { createTeamStateStore } = require("../../lib/server/team/state");

const kRoomA = "11111111-2222-3333-4444-555555555555";
const kRoomB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("server/buzz-setup (5.2)", () => {
  let rootDir;
  let openclawDir;
  let stateStore;
  let runCalls;
  let runResult;
  let clawOutput;
  let restartReasons;
  let invalidated;

  const makeService = () =>
    createBuzzSetup({
      openclawDir,
      stateStore,
      runStream: {
        runStreamed: vi.fn(async (opts) => {
          runCalls.push(opts);
          return runResult;
        }),
      },
      clawCmd: vi.fn(async () => ({ ok: true, stdout: clawOutput, stderr: "" })),
      gatewayEnv: () => ({
        PATH: "/usr/bin",
        HOME: "/home/qa",
        OPENCLAW_STATE_DIR: "/data/.openclaw",
        OPENCLAW_GATEWAY_TOKEN: "super-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
      }),
      restartRequiredState: {
        markRequired: (reason) => restartReasons.push(reason),
      },
      openclawCapabilities: {
        invalidate: () => {
          invalidated += 1;
        },
      },
      nowFn: () => 1_000_000,
    });

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-buzz-"));
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { mode: "local" }, agents: { list: [] } }),
    );
    stateStore = createTeamStateStore({ rootDir, fileName: kBuzzStateFileName });
    runCalls = [];
    runResult = { ok: true, code: 0, tail: "", timedOut: false };
    clawOutput = "";
    restartReasons = [];
    invalidated = 0;
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const readConfig = () =>
    JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

  it("installs the plugin with a SECRET-FREE env (E-C12) and flags restart", async () => {
    const service = makeService();
    const result = await service.install();
    expect(result.ok).toBe(true);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args).toEqual(["plugins", "install", "@openclaw/buzz"]);
    // External package code never sees credentials; OpenClaw state path
    // survives so the plugin actually lands on the data volume.
    expect(runCalls[0].env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(runCalls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runCalls[0].env.OPENCLAW_STATE_DIR).toBe("/data/.openclaw");
    // HOME is an ISOLATED tmp dir — not the gateway HOME and not the openclaw
    // data dir — so a compromised postinstall can't do $HOME-relative reads
    // into the data volume (E-C12, mirrors overlay-staging probeEnv).
    const installHome = runCalls[0].env.HOME;
    expect(typeof installHome).toBe("string");
    expect(installHome).not.toBe("/home/qa");
    expect(installHome).not.toBe("/data/.openclaw");
    expect(installHome).not.toBe(openclawDir);
    expect(installHome.startsWith(os.tmpdir())).toBe(true);
    // Belt-and-suspenders: no secret-shaped var leaks into the install env.
    for (const key of Object.keys(runCalls[0].env)) {
      expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE/i);
    }
    expect(service.getState().status).toBe("installed");
    expect(restartReasons).toContain("buzz_plugin_installed");
    expect(invalidated).toBe(1);
  });

  it("surfaces install failures with the CLI tail as the hint", async () => {
    runResult = { ok: false, code: 1, tail: "npm ERR! network timeout", timedOut: false };
    const service = makeService();
    const result = await service.install();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("plugin_install_failed");
    expect(result.hint).toContain("npm ERR! network timeout");
    expect(service.getState().status).toBe("idle");
  });

  it("configure validates wss:// and writes channels.buzz via the locked writer", () => {
    const service = makeService();
    expect(service.configure({ relayUrl: "https://not-a-socket" }).code).toBe(
      "invalid_relay_url",
    );
    const result = service.configure({ relayUrl: "wss://relay.buzz.example" });
    expect(result.ok).toBe(true);
    expect(readConfig().channels.buzz).toEqual({
      enabled: true,
      name: "Buzz",
      relayUrl: "wss://relay.buzz.example",
    });
    expect(service.getState().status).toBe("awaiting-approval");
  });

  it("probe captures the bot public key and NEVER loses it on a retry (C9)", async () => {
    const service = makeService();
    clawOutput = "buzz: awaiting approval\npublic key: BZpubKEY1234567890abcdef";
    const first = await service.probe();
    expect(first.publicKey).toBe("BZpubKEY1234567890abcdef");
    // A later probe with no key in the output keeps the stored identity.
    clawOutput = "buzz: awaiting approval";
    const second = await service.probe();
    expect(second.publicKey).toBe("BZpubKEY1234567890abcdef");
    expect(service.getState().publicKey).toBe("BZpubKEY1234567890abcdef");
    expect(second.connected).toBe(false);

    clawOutput = "buzz: connected as bot";
    const third = await service.probe();
    expect(third.connected).toBe(true);
  });

  it("rooms validates UUIDs and the default room, then writes groups/defaultTo", () => {
    const service = makeService();
    expect(service.rooms({ groups: [] }).code).toBe("no_rooms");
    expect(service.rooms({ groups: ["not-a-uuid"] }).code).toBe(
      "invalid_room_id",
    );
    expect(
      service.rooms({ groups: [kRoomA], defaultTo: kRoomB }).code,
    ).toBe("invalid_default_room");

    const result = service.rooms({ groups: [kRoomA, kRoomB], defaultTo: kRoomB });
    expect(result.ok).toBe(true);
    expect(readConfig().channels.buzz.groups).toEqual([kRoomA, kRoomB]);
    expect(readConfig().channels.buzz.defaultTo).toBe(kRoomB);
    expect(service.getState().status).toBe("done");
  });

  it("is resumable across service instances; pause preserves the step + identity + relay", async () => {
    const service = makeService();
    service.configure({ relayUrl: "wss://relay.buzz.example" });
    clawOutput = "buzz public key: BZresume1234567890";
    await service.probe();

    // A fresh instance over the same store resumes where the wizard left off.
    const resumed = makeService();
    expect(resumed.getState()).toEqual(
      expect.objectContaining({
        status: "awaiting-approval",
        relayUrl: "wss://relay.buzz.example",
        publicKey: "BZresume1234567890",
      }),
    );

    resumed.cancel();
    // Pause must NOT snap the wizard back to idle (which would restart at step
    // 0 and reinstall the plugin) — the step is preserved so Resume continues.
    expect(resumed.getState().status).toBe("awaiting-approval");
    expect(resumed.getState().relayUrl).toBe("wss://relay.buzz.example");
    expect(resumed.getState().publicKey).toBe("BZresume1234567890");
  });

  it("pause after install keeps the installed step so resume never reinstalls (5.2)", async () => {
    const service = makeService();
    await service.install();
    expect(service.getState().status).toBe("installed");

    // The user pauses right after the plugin installed but before the relay.
    service.cancel();
    expect(service.getState().status).toBe("installed");

    // A fresh instance (page reload) resumes at the install step, not step 0.
    const resumed = makeService();
    expect(resumed.getState().status).toBe("installed");
  });
});
