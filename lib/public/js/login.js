// Login and invite-acceptance form for login.html (moved out of the page so
// the Setup UI CSP runs no inline script).
const formEl = document.getElementById("login-form");
const inviteHeadingEl = document.getElementById("invite-heading");
const emailEl = document.getElementById("email");
const displayNameEl = document.getElementById("display-name");
const passwordEl = document.getElementById("password");
const passwordConfirmEl = document.getElementById("password-confirm");
const submitButtonEl = document.getElementById("submit-btn");
const modeToggleEl = document.getElementById("mode-toggle");
const errorEl = document.getElementById("error");
const recoveryEl = document.getElementById("recovery");
const recoveryCodeEl = document.getElementById("recovery-code");
const recoveryToggleEl = document.getElementById("recovery-toggle");

// Where a sign-in may return (?next=): the relay consent page, a delegate's
// change waiting for the owner's confirmation, AlphaClaw's secret drop page and
// OpenClaw's credential prompt. Anything else goes Home.
const kLoginReturnPatterns = [
  /^\/relay\/oauth\/consent\?request=[A-Za-z0-9_-]{20,100}$/,
  /^\/relay\/confirm\/rcl_[a-f0-9]{48}$/,
  /^\/secret\/[A-Za-z0-9_-]{43}$/,
  /^\/openclaw\/ask\/ask_[a-f0-9]{32}$/,
];

const inviteToken = new URLSearchParams(window.location.search).get(
  "invite",
);
// Modes: "password" (shared password), "member" (email + password),
// "invite" (accept an invite and create an account).
let mode = inviteToken ? "invite" : "password";
let legacyLoginDisabled = false;
let teamEnabled = false;

const show = (el, visible) => el.classList.toggle("hidden", !visible);

const applyMode = () => {
  show(inviteHeadingEl, mode === "invite");
  show(emailEl, mode !== "password");
  show(displayNameEl, mode === "invite");
  show(passwordConfirmEl, mode === "invite");
  passwordEl.setAttribute(
    "autocomplete",
    mode === "invite" ? "new-password" : "current-password",
  );
  passwordEl.placeholder =
    mode === "invite" ? "Choose a password (8+ characters)" : "Password";
  submitButtonEl.textContent =
    mode === "invite" ? "Create account" : "Enter";
  if (mode === "invite" || legacyLoginDisabled) {
    show(modeToggleEl, false);
  } else if (teamEnabled) {
    show(modeToggleEl, true);
    modeToggleEl.textContent =
      mode === "member"
        ? "Use the shared setup password instead"
        : "Sign in with your member email";
  } else {
    show(modeToggleEl, false);
  }
  syncButtonState();
};

const syncButtonState = () => {
  let ready = passwordEl.value.length > 0;
  if (mode === "member") ready = ready && emailEl.value.length > 0;
  if (mode === "invite") {
    ready =
      passwordEl.value.length >= 8 &&
      passwordEl.value === passwordConfirmEl.value;
  }
  submitButtonEl.disabled = !ready;
};

[emailEl, displayNameEl, passwordEl, passwordConfirmEl].forEach((el) =>
  el.addEventListener("input", syncButtonState),
);

// The recovery code only matters while sign-in is rate limited, so its
// "Locked out?" link appears after a 429. It goes with the shared password
// or a member sign-in, never with an invite.
recoveryToggleEl.addEventListener("click", () => {
  show(recoveryToggleEl, false);
  show(recoveryEl, true);
  recoveryCodeEl.focus();
});

modeToggleEl.addEventListener("click", () => {
  mode = mode === "member" ? "password" : "member";
  applyMode();
  (mode === "member" ? emailEl : passwordEl).focus();
});

// Team-aware defaults: when member login is the only way in, lead with it.
fetch("/api/auth/status")
  .then((res) => res.json())
  .then((data) => {
    if (data?.notice?.message) showError(data.notice.message);
    teamEnabled = data?.team?.enabled === true;
    legacyLoginDisabled = data?.team?.legacyLoginDisabled === true;
    if (mode === "password" && (legacyLoginDisabled || teamEnabled)) {
      mode = "member";
    }
    applyMode();
  })
  .catch(() => applyMode());

const setPendingState = (isPending) => {
  submitButtonEl.disabled = isPending;
  submitButtonEl.classList.toggle("opacity-70", isPending);
  submitButtonEl.classList.toggle("cursor-not-allowed", isPending);
};

const showError = (message) => {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
};

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.classList.add("hidden");
  setPendingState(true);
  const url =
    mode === "invite" ? "/api/auth/accept-invite" : "/api/auth/login";
  const body =
    mode === "invite"
      ? {
          token: inviteToken,
          email: emailEl.value.trim(),
          displayName: displayNameEl.value.trim(),
          password: passwordEl.value,
        }
      : mode === "member"
        ? { email: emailEl.value.trim(), password: passwordEl.value }
        : { password: passwordEl.value };
  const recoveryCode = recoveryCodeEl.value.trim();
  if (mode !== "invite" && recoveryCode) body.recoveryCode = recoveryCode;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      const next = new URLSearchParams(window.location.search).get("next") || "";
      window.location.href = kLoginReturnPatterns.some((pattern) => pattern.test(next)) ? next : "/";
    } else if (res.status === 429) {
      const retryAfterFromHeader = Number.parseInt(
        res.headers.get("retry-after") || "0",
        10,
      );
      const retryAfterSec =
        Number.isFinite(data.retryAfterSec) && data.retryAfterSec > 0
          ? data.retryAfterSec
          : Number.isFinite(retryAfterFromHeader) &&
              retryAfterFromHeader > 0
            ? retryAfterFromHeader
            : 30;
      showError(`Too many attempts. Try again in ${retryAfterSec}s.`);
      if (mode !== "invite" && recoveryEl.classList.contains("hidden")) {
        show(recoveryToggleEl, true);
      }
    } else if (res.status === 401 && body.recoveryCode) {
      // A code typed by mistake fails every sign-in, so it is cleared.
      recoveryCodeEl.value = "";
      showError(
        "Sign-in failed. The recovery code was cleared; leave it empty unless you were given one.",
      );
    } else {
      showError(data.error || "Login failed");
    }
  } catch {
    showError("Connection error");
  } finally {
    setPendingState(false);
    syncButtonState();
  }
});

applyMode();
