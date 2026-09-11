const API_ROOT = "http://127.0.0.1:41673/api/v1";
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: "phoenix-save-image",
    title: "Save image to Phoenix Project",
    contexts: ["image"],
  });
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "phoenix-save-image" || !info.srcUrl) return;
  captureImage({
    url: info.srcUrl,
    name: nameFromUrl(info.srcUrl),
    website: info.pageUrl || tab?.url || "",
  }).then(showResult);
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "phoenix-health") return health();
  if (message?.type === "phoenix-capture") return captureImage(message.payload);
  return undefined;
});

async function health() {
  try {
    const response = await fetch(`${API_ROOT}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Phoenix returned ${response.status}`);
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: readableError(error) };
  }
}

async function captureImage(payload) {
  const { pairingToken = "" } = await browser.storage.local.get("pairingToken");
  if (!pairingToken) return { ok: false, error: "Open the Phoenix extension and enter the pairing token." };

  const url = String(payload?.url || "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Phoenix can only capture HTTP or HTTPS images." };

  const request = {
    token: pairingToken,
    url,
    dataBase64: "",
    name: String(payload?.name || nameFromUrl(url)).slice(0, 240),
    website: String(payload?.website || "").slice(0, 2048),
    annotation: String(payload?.annotation || "").slice(0, 4000),
    tags: Array.isArray(payload?.tags) ? payload.tags.slice(0, 32) : [],
  };

  // Fetch in the extension first so authenticated and hotlink-protected images work.
  // Phoenix falls back to downloading the URL itself when Firefox cannot expose bytes.
  try {
    const image = await fetch(url, { credentials: "include", cache: "no-store" });
    const type = image.headers.get("content-type") || "";
    const declaredLength = Number(image.headers.get("content-length") || 0);
    if (image.ok && type.startsWith("image/") && declaredLength <= MAX_INLINE_BYTES) {
      const blob = await image.blob();
      if (blob.size <= MAX_INLINE_BYTES) request.dataBase64 = await blobToDataUrl(blob);
    }
  } catch {
    // The local API can still retrieve public URLs.
  }

  try {
    const response = await fetch(`${API_ROOT}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Phoenix returned ${response.status}`);
    return { ok: true, asset: body.data };
  } catch (error) {
    return { ok: false, error: readableError(error) };
  }
}

function nameFromUrl(value) {
  try {
    const url = new URL(value);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "Captured image");
    return last.replace(/\.[a-z0-9]{2,5}$/i, "") || "Captured image";
  } catch {
    return "Captured image";
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror/i.test(message)
    ? "Phoenix is not reachable. Start the Phoenix Project desktop app and try again."
    : message;
}

function showResult(result) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/phoenix.svg"),
    title: result.ok ? "Saved to Phoenix" : "Phoenix capture failed",
    message: result.ok ? (result.asset?.name || "Image saved") : result.error,
  });
}
