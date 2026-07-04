// Code d'accès par défaut : "sommet2026".
// Pour changer le code : python3 scripts/hash_password.py "nouveau-code" puis coller le résultat ci-dessous.
// Rappel : ceci n'est PAS une vraie sécurité (le hash est visible dans le code source),
// juste de quoi tenir à l'écart les curieux et les moteurs de recherche.
const EXPECTED_HASH = "da72e3baaf5a0e05b272c45d000cf02aa2563b2869f1748603e21b2bab86d955";
const SESSION_KEY = "randoUnlocked";

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const form = document.getElementById("gate-form");
const input = document.getElementById("gate-input");
const error = document.getElementById("gate-error");

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unlock() {
  gate.hidden = true;
  app.hidden = false;
  window.dispatchEvent(new CustomEvent("rando:unlocked"));
}

if (sessionStorage.getItem(SESSION_KEY) === "1") {
  unlock();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const hash = await sha256Hex(input.value.trim());
  if (hash === EXPECTED_HASH) {
    sessionStorage.setItem(SESSION_KEY, "1");
    error.hidden = true;
    unlock();
  } else {
    error.hidden = false;
    input.value = "";
    input.focus();
  }
});
