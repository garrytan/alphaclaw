// Terminal and chat WebSockets are authorized once, at upgrade, so a session
// that logout ends could keep using a socket it already holds. Logout emits
// kLogoutEvent on the shared emitter lib/server.js creates (routes/auth.js
// onLogout), and each socket server closes the sockets the ended sessions
// opened. A legacy logout ends every owner session and closes every socket;
// a member logout closes the sockets that member opened. Team admin changes
// emit the same event (routes/team.js onSessionsEnded): "member" for each
// member whose token secret they rotate, and "legacy_lockdown" when the
// legacy-login lockdown arms, which ends the owner's shared-password sessions
// (memberId null) and no member's. The sockets are the watchdog terminal,
// chat, and gateway upgrades a session opened (watchdog-terminal-ws.js).
const kLogoutEvent = "logout";

const isSocketEndedByLogout = (event, memberId) =>
  event?.kind === "legacy" ||
  (event?.kind === "legacy_lockdown" && !memberId) ||
  (event?.kind === "member" && !!memberId && event.memberId === memberId);

const closeLoggedOutSocket = (socket) => {
  try {
    socket.close(1000, "Logged out");
  } catch {}
};

module.exports = { kLogoutEvent, isSocketEndedByLogout, closeLoggedOutSocket };
