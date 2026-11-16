import { h, render } from "preact";
import { SecretDropPage } from "./components/secret-drop/index.js";

// Entry for the secret drop page (/secret/<token>, routes/secret-drop.js).
const token = window.location.pathname.split("/")[2] || "";
render(h(SecretDropPage, { token }), document.getElementById("app"));
