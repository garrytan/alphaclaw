const { runPostDoctorConvergence } = require("../../lib/server/startup");
const { createRepairOperation } = require("../../lib/server/repair-operation");

// eng review F1: boot and Retry upgrade share ONE post-Doctor tail.
const buildDeps = (calls, overrides = {}) => ({
  operation: createRepairOperation(),
  applyResourceAutotuneOnBoot: async () => calls.push("autotune"),
  runBootNativeMaintenance: async () => calls.push("native"),
  ensureManagedExecDefaults: async () => calls.push("exec"),
  ensureUsageTrackerPluginConfig: () => calls.push("usage"),
  ensureWebhookMappingIds: () => calls.push("webhooks"),
  doSyncPromptFiles: () => calls.push("prompts"),
  reloadEnv: () => calls.push("env"),
  readEnvFile: () => [],
  syncChannelConfig: async () => calls.push("channels"),
  resolveSetupUrl: () => "https://x",
  ensureGatewayProxyConfig: () => calls.push("proxy"),
  ...overrides,
});

describe("runPostDoctorConvergence", () => {
  it("runs the boot's post-Doctor steps in boot order", async () => {
    const calls = [];
    const result = await runPostDoctorConvergence({ label: "Retry upgrade", ...buildDeps(calls) });
    expect(result).toEqual({ held: false, heldReason: null });
    expect(calls).toEqual(["native", "autotune", "exec", "usage", "webhooks", "prompts", "env", "channels", "proxy"]);
  });

  it("an unsafe native maintenance holds the gateway and stops there", async () => {
    const calls = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runPostDoctorConvergence({
      label: "Retry upgrade",
      ...buildDeps(calls, { runBootNativeMaintenance: async () => { throw new Error("unsafe"); } }),
    });
    expect(result).toEqual({ held: true, heldReason: "Retry upgrade native maintenance did not complete safely" });
    expect(calls).toEqual([]);
    errors.mockRestore();
  });

  it("every other step is swallow-and-log, and ownership loss skips the rest", async () => {
    const calls = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let owned = true;
    const result = await runPostDoctorConvergence({
      label: "Retry upgrade",
      shouldContinue: () => owned,
      ...buildDeps(calls, {
        ensureManagedExecDefaults: async () => { throw new Error("exec broke"); },
        doSyncPromptFiles: () => { owned = false; calls.push("prompts"); },
      }),
    });
    expect(result.held).toBe(false);
    expect(calls).toEqual(["native", "autotune", "usage", "webhooks", "prompts"]);
    expect(errors).toHaveBeenCalledWith("[alphaclaw] Failed to ensure managed exec defaults after Retry upgrade: exec broke");
    errors.mockRestore();
  });
});
