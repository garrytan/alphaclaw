const realFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomicIfChanged } = require("../../lib/server/utils/safe-file");
const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
const { installGogCliSkill } = require("../../lib/server/gog-skill");
const { OPENCLAW_DIR } = require("../../lib/server/constants");

const identity = (filePath) => {
  const stat = realFs.statSync(filePath);
  return { ino: stat.ino, mtimeMs: stat.mtimeMs };
};

// The real fs, except AlphaClaw's own install paths read as missing, so the
// sync never sees (or reconciles) a config outside the test's directory.
const hermeticFs = {
  ...realFs,
  readFileSync: (target, ...rest) => {
    if (String(target).startsWith(OPENCLAW_DIR)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return realFs.readFileSync(target, ...rest);
  },
  existsSync: (target) =>
    String(target).startsWith(OPENCLAW_DIR) ? false : realFs.existsSync(target),
};

describe("generated files are byte-stable", () => {
  let root;
  let savedEnv;
  beforeEach(() => {
    root = realFs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-generated-"));
    savedEnv = {
      ALPHACLAW_GIT_SYNC: process.env.ALPHACLAW_GIT_SYNC,
      ALPHACLAW_GIT_WRITER_COMMAND: process.env.ALPHACLAW_GIT_WRITER_COMMAND,
    };
    delete process.env.ALPHACLAW_GIT_SYNC;
    delete process.env.ALPHACLAW_GIT_WRITER_COMMAND;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    realFs.rmSync(root, { recursive: true, force: true });
  });

  describe("writeFileAtomicIfChanged", () => {
    it("leaves a file holding the same bytes untouched: no write, same inode and mtime", () => {
      const target = path.join(root, "AGENTS.md");
      expect(writeFileAtomicIfChanged(target, "rules\n")).toBe(true);
      const before = identity(target);
      expect(writeFileAtomicIfChanged(target, "rules\n")).toBe(false);
      expect(identity(target)).toEqual(before);
      expect(realFs.readdirSync(root)).toEqual(["AGENTS.md"]);
    });

    it("replaces changed content atomically on a fresh inode", () => {
      const target = path.join(root, "AGENTS.md");
      realFs.writeFileSync(target, "old\n");
      const before = identity(target);
      expect(writeFileAtomicIfChanged(target, "new\n")).toBe(true);
      expect(realFs.readFileSync(target, "utf8")).toBe("new\n");
      expect(identity(target).ino).not.toBe(before.ino);
      expect(realFs.readdirSync(root)).toEqual(["AGENTS.md"]);
    });
  });

  describe("hooks/bootstrap/AGENTS.md", () => {
    const sync = (workspaceDir, gitWriterCommand) =>
      syncBootstrapPromptFiles({
        fs: hermeticFs,
        workspaceDir,
        baseUrl: "https://setup.example.com",
        openclawDir: root,
        rootDir: path.dirname(root),
        envFilePath: path.join(path.dirname(root), ".env"),
        gitWriterCommand,
      });

    it("renders the same bytes from the same inputs", () => {
      const first = path.join(root, "workspace");
      const second = path.join(root, "workspace-copy");
      vi.spyOn(console, "log").mockImplementation(() => {});
      sync(first);
      sync(second);
      for (const relative of ["AGENTS.md", path.join("reference", "AGENTS.md")]) {
        const read = (dir) => realFs.readFileSync(path.join(dir, "hooks", "bootstrap", relative));
        expect(read(first).length).toBeGreaterThan(0);
        expect(read(second).equals(read(first))).toBe(true);
      }
    });

    it("a second boot sync with unchanged inputs keeps the file's inode and mtime", () => {
      const workspaceDir = path.join(root, "workspace");
      const files = [
        path.join(workspaceDir, "hooks", "bootstrap", "AGENTS.md"),
        path.join(workspaceDir, "hooks", "bootstrap", "reference", "AGENTS.md"),
      ];
      vi.spyOn(console, "log").mockImplementation(() => {});
      sync(workspaceDir);
      const before = files.map(identity);
      sync(workspaceDir);
      expect(files.map(identity)).toEqual(before);
    });

    it("with git sync off, names the changed file once and says how to commit it", () => {
      process.env.ALPHACLAW_GIT_SYNC = "off";
      const workspaceDir = path.join(root, "workspace");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const notices = () =>
        log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("git sync is off"));

      sync(workspaceDir);
      const suffix =
        " was regenerated with new content and git sync is off (ALPHACLAW_GIT_SYNC=off); commit it with the tool that owns this repository";
      expect(notices()).toEqual([
        `[alphaclaw] workspace/hooks/bootstrap/AGENTS.md${suffix}`,
        `[alphaclaw] workspace/hooks/bootstrap/reference/AGENTS.md${suffix}`,
      ]);

      sync(workspaceDir);
      expect(notices()).toHaveLength(2);

      process.env.ALPHACLAW_GIT_WRITER_COMMAND = "/srv/ops/guard.sh commit";
      sync(workspaceDir, "/srv/ops/guard.sh commit");
      const writerNotices = notices().slice(2);
      expect(writerNotices).toEqual([
        "[alphaclaw] workspace/hooks/bootstrap/AGENTS.md was regenerated with new content and git sync is off (ALPHACLAW_GIT_SYNC=off); commit it with this repository's writer (ALPHACLAW_GIT_WRITER_COMMAND)",
      ]);
      expect(writerNotices.join("\n")).not.toContain("/srv/ops/guard.sh");
      expect(writerNotices.join("\n")).not.toContain(root);
    });

    it("says nothing about committing while git sync is on", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      sync(path.join(root, "workspace"));
      expect(log.mock.calls.flat().join("\n")).not.toContain("git sync is off");
    });
  });

  describe("skills/gog-cli/SKILL.md", () => {
    it("is not rewritten when the Google accounts are unchanged", () => {
      realFs.mkdirSync(path.join(root, "gogcli"), { recursive: true });
      realFs.writeFileSync(
        path.join(root, "gogcli", "state.json"),
        JSON.stringify({
          version: 2,
          accounts: [
            { id: "a1", email: "ops@example.com", client: "default", authenticated: true, services: ["gmail:read"] },
          ],
          gmailPush: { token: "", topics: {} },
        }),
      );
      const skillPath = path.join(root, "skills", "gog-cli", "SKILL.md");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      installGogCliSkill({ fs: realFs, openclawDir: root });
      const before = identity(skillPath);
      installGogCliSkill({ fs: realFs, openclawDir: root });
      expect(identity(skillPath)).toEqual(before);
      expect(log.mock.calls.filter(([line]) => String(line).includes("gog-cli skill installed"))).toHaveLength(1);
    });
  });
});
