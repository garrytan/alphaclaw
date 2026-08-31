# Claude Code TUI fixtures

Raw `tmux capture-pane -p -J` buffers from real `claude` CLI runs. Parsing code
in `lib/server/claude-code-local/tui.js` is tested against these verbatim —
when a claude version bump changes any screen, re-capture here and fix the
detectors in the same commit (the Dockerfile pin and this directory move
together).

Provenance: claude 2.1.237 (Bun single-file build), tmux 3.6a, captured
2026-08-31 via `tmux -S <sock> -f /dev/null new-session … -- env -i … claude …`
with `remain-on-exit on` (T0 spike).

- rc-needs-login.txt — `claude remote-control` with no OAuth login (the gate
  fires before the ANTHROPIC_API_KEY check; both scrubbed and key-present envs
  produce this same screen).
- auth-login-oauth-url.txt — `claude auth login` in a scrubbed env: prints the
  OAuth URL (NOTE: real host is claude.com with a /cai/oauth/ path, not
  claude.ai) and waits at "Paste code here if prompted >". The embedded PKCE
  code_challenge/state are dead single-use values from the spike session.
- rc-url-screen.txt — captured live (T0b, logged-in run): the persistent
  server's banner advertises https://claude.ai/code?environment=env_<id>
  (the environment form), NOT /code/<sessionId> — both shapes are parsed.
- rc-enable-prompt.txt — the "Enable Remote Control? (y/n)" confirm the
  watcher answers with y + Enter.
- rc-workspace-not-trusted.txt — the non-interactive trust refusal (the
  subcommand EXITS instead of prompting; ensureWorkspaceTrust pre-seeds
  projects[cwd].hasTrustDialogAccepted in the rescue .claude.json).
