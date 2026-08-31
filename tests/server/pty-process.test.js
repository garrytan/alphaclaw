const {
  spawnInPty,
  hasScriptCommand,
} = require("../../lib/server/pty-process");

const kFakeChild = { pid: 5150 };
const kLiteralArgv = ["claude", "auth", "login"];

// Tokens the strict allowlist must refuse: script(1) on linux only takes a
// -c STRING, so anything shell-interpretable has to throw instead of being
// quoted.
const kRejectedTokens = [
  "a b",
  "x;rm",
  "$(boom)",
  "`boom`",
  "it's",
  'say"hi"',
];

// process.platform is a getter on the process object; Object.defineProperty
// is the only way to stub it without a child process.
const withPlatform = (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

describe("pty-process spawnInPty", () => {
  it("throws for every shell-interpretable token", () => {
    for (const token of kRejectedTokens) {
      expect(() => spawnInPty([token], { spawnImpl: vi.fn() })).toThrow(
        /refusing token/,
      );
    }
  });

  it("throws when a rejected token hides among safe ones", () => {
    expect(() =>
      spawnInPty(["claude", "auth", "a b"], { spawnImpl: vi.fn() }),
    ).toThrow(/refusing token/);
  });

  it("throws for empty or non-array argv", () => {
    expect(() => spawnInPty([], { spawnImpl: vi.fn() })).toThrow(
      /non-empty array/,
    );
    expect(() => spawnInPty(undefined, { spawnImpl: vi.fn() })).toThrow(
      /non-empty array/,
    );
    expect(() => spawnInPty("claude", { spawnImpl: vi.fn() })).toThrow(
      /non-empty array/,
    );
  });

  it("throws for non-string tokens", () => {
    expect(() => spawnInPty([42], { spawnImpl: vi.fn() })).toThrow(
      /refusing token/,
    );
    expect(() => spawnInPty([null], { spawnImpl: vi.fn() })).toThrow(
      /refusing token/,
    );
    expect(() => spawnInPty(["claude", undefined], { spawnImpl: vi.fn() })).toThrow(
      /refusing token/,
    );
  });

  it("accepts fixed literal argv, including path/flag/env-pair tokens", () => {
    const spawnImpl = vi.fn(() => kFakeChild);
    const child = spawnInPty(
      ["/usr/local/bin/claude", "--verbose", "K=V", "a,b:c@d%e+f"],
      { spawnImpl },
    );
    expect(child).toBe(kFakeChild);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps the argv in util-linux script string form on linux", () => {
    const spawnImpl = vi.fn(() => kFakeChild);
    withPlatform("linux", () => {
      spawnInPty(kLiteralArgv, { spawnImpl, cwd: "/data" });
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "script",
      ["-q", "-f", "-c", "claude auth login", "/dev/null"],
      expect.objectContaining({ cwd: "/data", stdio: "pipe" }),
    );
    // The child must always see a TERM, even when the caller passes none.
    expect(spawnImpl.mock.calls[0][2].env.TERM).toBe("xterm-256color");
  });

  it("uses BSD script real-argv form on darwin and restores the platform", () => {
    const kOriginalPlatform = process.platform;
    const spawnImpl = vi.fn(() => kFakeChild);
    withPlatform("darwin", () => {
      spawnInPty(kLiteralArgv, { spawnImpl });
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "script",
      ["-q", "/dev/null", "claude", "auth", "login"],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(process.platform).toBe(kOriginalPlatform);
  });

  it("preserves a caller-provided TERM", () => {
    const spawnImpl = vi.fn(() => kFakeChild);
    spawnInPty(kLiteralArgv, { spawnImpl, env: { TERM: "vt100" } });
    expect(spawnImpl.mock.calls[0][2].env.TERM).toBe("vt100");
  });
});

describe("pty-process hasScriptCommand", () => {
  it("returns a boolean", () => {
    expect(typeof hasScriptCommand()).toBe("boolean");
  });
});
