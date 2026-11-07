// Apply saved theme before render to prevent flash. Loaded as a blocking
// classic script in <head> of setup.html and login.html (the Setup UI CSP
// runs no inline script).
try {
  var t = localStorage.getItem("alphaclaw.ui.theme");
  if (t === "system") t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  else if (t !== "dark" && t !== "light") t = "dark";
  document.documentElement.dataset.theme = t;
} catch {}
