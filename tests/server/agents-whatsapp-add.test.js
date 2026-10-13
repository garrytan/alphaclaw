const { createAgentsService } = require("../../lib/server/agents/service");

// `channels add --channel whatsapp` accepts only --account/--agent/--auth-dir/
// --name; OpenClaw 2026.9.8 and 2026.10.2 both refuse anything else with
// `OpenClaw does not recognize option "--token".` (verified against both CLIs).
const kWhatsAppAddFlags = new Set(["--channel", "--account", "--agent", "--auth-dir", "--name"]);

const buildFsMock = (initialConfig) => {
  let currentConfig = JSON.parse(JSON.stringify(initialConfig));
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn((targetPath) => {
      if (String(targetPath || "").endsWith("openclaw.json")) {
        return JSON.stringify(currentConfig);
      }
      throw new Error(`ENOENT: ${targetPath}`);
    }),
    writeFileSync: vi.fn((targetPath, content) => {
      if (String(targetPath || "").endsWith("openclaw.json")) {
        currentConfig = JSON.parse(String(content || "{}"));
      }
    }),
    readConfig: () => currentConfig,
  };
};

describe("server/agents whatsapp channels add", () => {
  it("never passes the owner number as --token; it persists via the env var + allowFrom reference", async () => {
    const fsMock = buildFsMock({ agents: { list: [{ id: "main", default: true }] } });
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const writeEnvFile = vi.fn();
    const service = createAgentsService({
      fs: fsMock,
      OPENCLAW_DIR: "/test/.openclaw",
      readEnvFile: vi.fn(() => []),
      writeEnvFile,
      reloadEnv: vi.fn(),
      restartGateway: vi.fn(async () => {}),
      clawCmd,
    });

    await service.createChannelAccount({
      provider: "whatsapp",
      name: "WhatsApp",
      accountId: "default",
      token: "+15551234567",
      agentId: "main",
    });

    const addCall = clawCmd.mock.calls
      .map(([cmd]) => String(cmd))
      .find((cmd) => cmd.startsWith("channels add"));
    expect(addCall).toBe("channels add --channel whatsapp --name 'WhatsApp'");
    const flags = addCall.split(" ").filter((part) => part.startsWith("--"));
    expect(flags.every((flag) => kWhatsAppAddFlags.has(flag))).toBe(true);
    expect(addCall).not.toContain("+15551234567");

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([{ key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" }]),
    );
    expect(fsMock.readConfig().channels.whatsapp.accounts.default.allowFrom).toEqual([
      "${WHATSAPP_OWNER_NUMBER}",
    ]);
  });
});
