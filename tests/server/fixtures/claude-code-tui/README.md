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
- rc-url-screen.txt — TODO(T0b): capture on a logged-in box: the
  `claude remote-control` screen showing https://claude.ai/code/<sessionId>.
  Until then the URL detector is tested against the binary-verified format
  (see synthetic-rc-url-screen.txt) and MUST be re-verified at T0b.
