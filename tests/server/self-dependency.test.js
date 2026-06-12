const fs = require("fs");

const {
  looksLikeGitDependency,
  resolveSelfDependency,
} = require("../../lib/server/self-dependency");

describe("server/self-dependency", () => {
  describe("looksLikeGitDependency", () => {
    it("flags git URL specs", () => {
      for (const spec of [
        "git+https://github.com/garrytan/alphaclaw.git#main",
        "github:garrytan/alphaclaw#main",
        "git+ssh://git@github.com/garrytan/alphaclaw.git",
        "https://github.com/garrytan/alphaclaw",
        "git://example.com/alphaclaw.git",
      ]) {
        expect(looksLikeGitDependency(spec)).toBe(true);
      }
    });

    it("does not flag npm version specs", () => {
      for (const spec of ["0.9.18", "^0.9.0", "latest", "~1.2.3", ""]) {
        expect(looksLikeGitDependency(spec)).toBe(false);
      }
    });
  });

  describe("resolveSelfDependency", () => {
    const makeFs = (pkgByPath) => ({
      ...fs,
      existsSync: (p) => Object.prototype.hasOwnProperty.call(pkgByPath, p),
      readFileSync: (p) => {
        if (!pkgByPath[p]) throw new Error(`no such file: ${p}`);
        return JSON.stringify(pkgByPath[p]);
      },
    });

    it("resolves a git-pinned consumer dependency under the alphaclaw alias", () => {
      const fsImpl = makeFs({
        "/app/package.json": {
          dependencies: {
            alphaclaw: "git+https://github.com/garrytan/alphaclaw.git#main",
          },
        },
      });
      const result = resolveSelfDependency({
        fsImpl,
        startDir: "/app/node_modules/alphaclaw/lib/server",
      });
      expect(result).toEqual({
        installDir: "/app",
        key: "alphaclaw",
        spec: "git+https://github.com/garrytan/alphaclaw.git#main",
        isGit: true,
      });
    });

    it("resolves a legacy npm-pinned @chrysb/alphaclaw dependency", () => {
      const fsImpl = makeFs({
        "/app/package.json": {
          dependencies: { "@chrysb/alphaclaw": "0.9.18" },
        },
      });
      const result = resolveSelfDependency({
        fsImpl,
        startDir: "/app/node_modules/@chrysb/alphaclaw/lib/server",
      });
      expect(result.key).toBe("@chrysb/alphaclaw");
      expect(result.spec).toBe("0.9.18");
      expect(result.isGit).toBe(false);
      expect(result.installDir).toBe("/app");
    });

    it("returns no dependency when none is declared", () => {
      const fsImpl = makeFs({
        "/app/package.json": { dependencies: { express: "^4.0.0" } },
      });
      const result = resolveSelfDependency({
        fsImpl,
        startDir: "/app/node_modules/alphaclaw/lib/server",
      });
      expect(result.key).toBeNull();
      expect(result.spec).toBeNull();
      expect(result.isGit).toBe(false);
    });
  });
});
