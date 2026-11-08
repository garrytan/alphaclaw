const fs = require("fs");
const path = require("path");
const vm = require("vm");

// login.js is a plain page script (login.html), so it runs here in a vm
// context with the few DOM pieces it touches.
const kScript = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "public", "js", "login.js"), "utf8");

const fakeElement = () => {
  const classes = new Set(["hidden"]);
  const listeners = {};
  return {
    value: "",
    textContent: "",
    placeholder: "",
    disabled: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    setAttribute: () => {},
    focus: () => {},
    listeners,
  };
};

const loadLoginPage = (loginAnswer) => {
  const elements = {};
  const fetch = vi.fn(async (url) => {
    if (url === "/api/auth/status") return { status: 200, json: async () => ({ team: { enabled: false } }) };
    return { status: loginAnswer.status, headers: { get: () => null }, json: async () => loginAnswer.body };
  });
  vm.runInNewContext(kScript, {
    document: { getElementById: (id) => (elements[id] ||= fakeElement()) },
    window: { location: { search: "", href: "" } },
    URLSearchParams,
    fetch,
  });
  const submit = async () => {
    await elements["login-form"].listeners.submit({ preventDefault: () => {} });
  };
  return { elements, fetch, submit };
};

const kWrongCredentials = { status: 401, body: { ok: false, error: "Invalid credentials" } };

describe("login page: recovery code field", () => {
  it("after a 401 on a sign-in that sent a recovery code, clears the code and says why", async () => {
    const page = loadLoginPage(kWrongCredentials);
    page.elements.password.value = "typed password";
    page.elements["recovery-code"].value = "a code the owner did not get";
    await page.submit();
    const sent = JSON.parse(page.fetch.mock.calls.at(-1)[1].body);
    expect(sent.recoveryCode).toBe("a code the owner did not get");
    expect(page.elements["recovery-code"].value).toBe("");
    expect(page.elements.error.textContent).toBe(
      "Sign-in failed. The recovery code was cleared; leave it empty unless you were given one.",
    );
    expect(page.elements.error.classList.contains("hidden")).toBe(false);
  });

  it("a 401 without a code keeps the server's message", async () => {
    const page = loadLoginPage(kWrongCredentials);
    page.elements.password.value = "typed password";
    await page.submit();
    expect(page.elements.error.textContent).toBe("Invalid credentials");
  });
});
