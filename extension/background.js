const API_ROOT = "http://127.0.0.1:41673/api/v1";
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: "phoenix-save-media",
    title: "Save to Phoenix Project",
    contexts: ["image", "video"],
  });
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "phoenix-save-media" || !info.srcUrl) return;
  let payload = {
    url: info.srcUrl,
    name: nameFromUrl(info.srcUrl),
    website: info.pageUrl || tab?.url || "",
    mediaType: info.mediaType === "video" ? "video" : "image",
    extension: extensionFromUrl(info.srcUrl),
  };
  if (payload.mediaType === "video" && /^blob:/i.test(payload.url) && tab?.id != null) {
    try {
      const resolved = await browser.tabs.sendMessage(tab.id, { type: "phoenix-read-video", url: payload.url });
      if (!resolved?.ok) return showResult({ ok: false, error: resolved?.error || "Firefox could not read this video." });
      payload = { ...payload, ...resolved, url: "" };
    } catch (error) {
      return showResult({ ok: false, error: readableError(error) });
    }
  }
  showResult(await captureMedia(payload));
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "phoenix-health") return health();
  if (message?.type === "phoenix-capture") return captureMedia(message.payload);
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

async function captureMedia(payload) {
  const { pairingToken = "" } = await browser.storage.local.get("pairingToken");
  if (!pairingToken) return { ok: false, error: "Open the Phoenix extension and enter the pairing token." };

  const url = String(payload?.url || "");
  const mediaType = payload?.mediaType === "video" ? "video" : "image";
  const dataBase64 = String(payload?.dataBase64 || "");
  if (!/^https?:\/\//i.test(url) && !dataBase64) {
    return { ok: false, error: `Phoenix can only capture direct HTTP or HTTPS ${mediaType} links.` };
  }

  const request = {
    token: pairingToken,
    url,
    dataBase64,
    name: String(payload?.name || nameFromUrl(url)).slice(0, 240),
    website: String(payload?.website || "").slice(0, 2048),
    annotation: String(payload?.annotation || "").slice(0, 4000),
    tags: Array.isArray(payload?.tags) ? payload.tags.slice(0, 32) : [],
    mediaType,
    extension: String(payload?.extension || extensionFromUrl(url)).slice(0, 12),
  };

  // Fetch in the extension first so authenticated and hotlink-protected images work.
  // Phoenix falls back to downloading the URL itself when Firefox cannot expose bytes.
  if (mediaType === "image") {
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

function extensionFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase() || "";
  } catch {
    return "";
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
    message: result.ok ? (result.asset?.name || "Item saved") : result.error,
  });
}
