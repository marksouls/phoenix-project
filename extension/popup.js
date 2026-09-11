const token = document.querySelector("#token");
const save = document.querySelector("#save");
const copy = document.querySelector("#connection-copy");
const light = document.querySelector("#connection-light");

browser.storage.local.get("pairingToken").then(({ pairingToken = "" }) => {
  token.value = pairingToken;
});

document.querySelector("#reveal").addEventListener("click", () => {
  token.type = token.type === "password" ? "text" : "password";
});

save.addEventListener("click", async () => {
  save.disabled = true;
  await browser.storage.local.set({ pairingToken: token.value.trim() });
  await checkConnection();
  save.disabled = false;
});

async function checkConnection() {
  const result = await browser.runtime.sendMessage({ type: "phoenix-health" });
  light.classList.toggle("online", Boolean(result?.ok));
  copy.textContent = result?.ok
    ? "Phoenix is running and ready to receive images."
    : (result?.error || "Phoenix is not reachable.");
}

checkConnection();
