// A21 read-leak guard: browse content reads return raw file bytes, so
// secret-bearing paths (gateway state, agent auth profiles, OAuth credential
// stores) resolve to denied for the agent actor — redaction cannot help once
// the bytes are in the transcript. Compare case-insensitively; normalize
// leading "./" and "/" (and backslash separators) before matching.
const kSecretPathPrefixes = [".alphaclaw/", "gogcli/credentials", "credentials/"];
const kAuthProfilesPattern = /^agents\/[^/]+\/agent\/auth-profiles\.json/;

const isSecretBearingPath = (rawPath) => {
  let candidate = String(rawPath || "").replace(/\\/g, "/").trim().toLowerCase();
  while (candidate.startsWith("./") || candidate.startsWith("/")) {
    candidate = candidate.startsWith("./") ? candidate.slice(2) : candidate.slice(1);
  }
  if (kSecretPathPrefixes.some((prefix) => candidate.startsWith(prefix))) return true;
  return kAuthProfilesPattern.test(candidate);
};

const browseReadTierResolver = (req) =>
  isSecretBearingPath(req?.query?.path) ? "denied" : "safe";

module.exports = {
  domain: "browse",
  title: "File Browser",
  ops: [
    {
      id: "browse.tree",
      title: "List workspace file tree",
      method: "GET",
      path: "/api/browse/tree",
      tier: "safe",
      params: {
        fields: [
          {
            name: "path",
            location: "query",
            type: "string",
            required: false,
            description:
              "Folder to list, relative to the workspace root (omit for the root). Non-folder or out-of-root paths are rejected (400).",
          },
          {
            name: "depth",
            location: "query",
            type: "number",
            required: false,
            description:
              "Tree depth (default 3, clamped to the server max of 3). Truncated folders come back with truncated: true — re-request with their path.",
          },
        ],
        example: "GET /api/browse/tree?path=skills&depth=2",
      },
      notes: ".git, .alphaclaw, node_modules, .cache, dist, build are hidden from listings.",
    },
    {
      id: "browse.read",
      title: "Read a workspace file (text, image, audio, or sqlite summary)",
      method: "GET",
      path: "/api/browse/read",
      tier: "safe",
      tierResolver: browseReadTierResolver,
      params: {
        fields: [
          {
            name: "path",
            location: "query",
            type: "string",
            required: true,
            description:
              "File path relative to the workspace root. Non-file paths and non-image/audio binaries are rejected (400); sqlite files return a table summary instead of content.",
          },
        ],
        example: "GET /api/browse/read?path=skills/notes.md",
      },
      hint: "secret-bearing paths are operator-only",
    },
    {
      id: "browse.download",
      title: "Download a workspace file (raw bytes)",
      method: "GET",
      path: "/api/browse/download",
      tier: "safe",
      tierResolver: browseReadTierResolver,
      params: {
        fields: [
          {
            name: "path",
            location: "query",
            type: "string",
            required: true,
            description:
              "File path relative to the workspace root. Non-file or out-of-root paths are rejected (400).",
          },
        ],
        example: "GET /api/browse/download?path=exports/report.pdf",
      },
      hint: "secret-bearing paths are operator-only",
    },
    {
      id: "browse.sqlite-table",
      title: "Read rows from a sqlite table in the workspace",
      method: "GET",
      path: "/api/browse/sqlite-table",
      tier: "safe",
      tierResolver: browseReadTierResolver,
      params: {
        fields: [
          {
            name: "path",
            location: "query",
            type: "string",
            required: true,
            description:
              "Sqlite file path relative to the workspace root (.sqlite/.sqlite3/.db/...). Non-sqlite paths are rejected (400).",
          },
          {
            name: "table",
            location: "query",
            type: "string",
            required: true,
            description: "Table name to read; unknown tables are rejected (400).",
          },
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Rows per page (default 50).",
          },
          {
            name: "offset",
            location: "query",
            type: "number",
            required: false,
            description: "Row offset for paging.",
          },
        ],
        example: "GET /api/browse/sqlite-table?path=data/app.db&table=users&limit=50&offset=0",
      },
      hint: "secret-bearing paths are operator-only",
    },
    {
      id: "browse.git-summary",
      title: "Workspace git status (branch, changed files, recent commits)",
      method: "GET",
      path: "/api/browse/git-summary",
      tier: "safe",
      notes: "isRepo: false (not an error) when the workspace root is not a git repo.",
    },
    {
      id: "browse.git-diff",
      title: "Git diff for one workspace file",
      method: "GET",
      path: "/api/browse/git-diff",
      tier: "safe",
      // Same A21 guard as browse.read: for untracked files the diff is the
      // FULL file content (diff --no-index against /dev/null).
      tierResolver: browseReadTierResolver,
      params: {
        fields: [
          {
            name: "path",
            location: "query",
            type: "string",
            required: true,
            description:
              "File path relative to the workspace root. Untracked files diff against /dev/null (full content); 400 if the root is not a git repo.",
          },
        ],
        example: "GET /api/browse/git-diff?path=skills/notes.md",
      },
      hint: "secret-bearing paths are operator-only",
    },
    {
      id: "browse.write",
      title: "Overwrite a workspace file's content",
      method: "PUT",
      path: "/api/browse/write",
      tier: "write",
      idempotent: true,
      readOp: "browse.read",
      params: {
        fields: [
          {
            name: "path",
            location: "body",
            type: "string",
            required: true,
            description:
              "Existing file to overwrite, relative to the workspace root. Missing files are rejected — use browse.create-file first.",
          },
          {
            name: "content",
            location: "body",
            type: "string",
            required: true,
            description:
              "FULL replacement content (utf8). Non-string content is rejected (400).",
          },
        ],
        example: '{"path":"skills/notes.md","content":"# Notes\\n"}',
      },
      notes: "Locked (AlphaClaw-managed) paths return 403; policy is enforced server-side.",
    },
    {
      id: "browse.create-file",
      title: "Create an empty workspace file",
      method: "POST",
      path: "/api/browse/create-file",
      tier: "write",
      idempotent: false,
      readOp: "browse.tree",
      params: {
        fields: [
          {
            name: "path",
            location: "body",
            type: "string",
            required: true,
            description:
              "New file path relative to the workspace root; parent folders are created. 409 if anything already exists there; locked paths return 403.",
          },
        ],
        example: '{"path":"skills/new-skill/SKILL.md"}',
      },
    },
    {
      id: "browse.create-folder",
      title: "Create a workspace folder",
      method: "POST",
      path: "/api/browse/create-folder",
      tier: "write",
      idempotent: false,
      readOp: "browse.tree",
      params: {
        fields: [
          {
            name: "path",
            location: "body",
            type: "string",
            required: true,
            description:
              "New folder path relative to the workspace root. 409 if anything already exists there; locked paths return 403.",
          },
        ],
        example: '{"path":"exports/2026-08"}',
      },
    },
    {
      id: "browse.move",
      title: "Move/rename a workspace file or folder",
      method: "POST",
      path: "/api/browse/move",
      tier: "write",
      idempotent: false,
      readOp: "browse.tree",
      params: {
        fields: [
          {
            name: "from",
            location: "body",
            type: "string",
            required: true,
            description:
              "Existing source path relative to the workspace root; 404 if missing. Locked/protected sources return 403.",
          },
          {
            name: "to",
            location: "body",
            type: "string",
            required: true,
            description:
              "Destination path; parent folders are created. 409 if the destination exists; locked destinations return 403.",
          },
        ],
        example: '{"from":"drafts/report.md","to":"exports/report.md"}',
      },
      notes: "Locked/protected path policy is enforced server-side.",
    },
    {
      id: "browse.restore",
      title: "Restore a file from git (discard local changes)",
      method: "POST",
      path: "/api/browse/restore",
      tier: "write",
      idempotent: false,
      readOp: "browse.git-diff",
      params: {
        fields: [
          {
            name: "path",
            location: "body",
            type: "string",
            required: true,
            description:
              "File path relative to the workspace root. Discards staged + worktree changes back to HEAD — uncommitted edits are lost.",
          },
        ],
        example: '{"path":"skills/notes.md"}',
      },
      notes: "Check browse.git-diff first — this throws away uncommitted changes.",
    },
    {
      id: "browse.git-sync",
      title: "Commit all workspace changes and push",
      method: "POST",
      path: "/api/browse/git-sync",
      tier: "write",
      idempotent: false,
      readOp: "browse.git-summary",
      params: {
        fields: [
          {
            name: "message",
            location: "body",
            type: "string",
            required: false,
            description:
              'Commit message (defaults to "sync changes"). Stages EVERYTHING (git add -A), commits, then pushes (sets upstream if missing).',
          },
        ],
        example: '{"message":"Update skill notes"}',
      },
      notes: "Push failures still return ok: true with pushError — check committed/pushed flags.",
    },
    {
      id: "browse.delete",
      title: "Delete a workspace file or folder",
      method: "DELETE",
      path: "/api/browse/delete",
      tier: "dangerous",
      idempotent: false,
      readOp: "browse.tree",
      params: {
        fields: [
          {
            name: "path",
            location: "body",
            type: "string",
            required: true,
            description:
              "Path relative to the workspace root, sent in the JSON request body. Folders are deleted recursively; 404 if missing; locked/protected paths return 403.",
          },
        ],
        example: '{"path":"drafts/old-report.md"}',
      },
      hint: "Permanently deletes the file or folder (folders recursively) — there is no trash or undo.",
    },
  ],
};
