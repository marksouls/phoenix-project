const invoke = window.__TAURI__?.core?.invoke;
const id = new URLSearchParams(location.search).get("id");
let zoom = 1;

function viewerPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("phoenix.preferences.v1") || "{}");
    return {
      videoAutoplayViewer: saved.videoAutoplayViewer !== false,
      loopShortVideos: saved.loopShortVideos !== false,
    };
  } catch {
    return { videoAutoplayViewer: true, loopShortVideos: true };
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent && bytes < 10 * 1024 ** exponent ? 1 : 0)} ${units[exponent]}`;
}

function applyZoom() {
  document.querySelector("#stage").style.setProperty("--zoom", zoom);
  document.querySelector("#zoom").textContent = `${Math.round(zoom * 100)}%`;
}

function changeZoom(delta) {
  zoom = Math.min(4, Math.max(0.25, Math.round((zoom + delta) * 4) / 4));
  applyZoom();
}

function isVideoAsset(asset) {
  return String(asset?.mimeType || "").startsWith("video/");
}

async function load() {
  if (!id) throw new Error("No item was selected.");
  const bootstrap = invoke
    ? await invoke("get_bootstrap")
    : await fetch("/dev/bootstrap").then((response) => response.json());
  const asset = [...bootstrap.assets, ...(bootstrap.trashedAssets || [])].find((item) => item.id === id);
  if (!asset) throw new Error("Item not found.");
  const filename = `${asset.name}${asset.extension ? `.${asset.extension}` : ""}`;
  const videoAsset = isVideoAsset(asset);
  document.title = `${filename} — Phoenix`;
  document.querySelector("#name").textContent = filename;
  document.querySelector("#meta").textContent = videoAsset
    ? `Video · ${asset.mimeType} · ${formatBytes(asset.size)}`
    : `${asset.width} × ${asset.height} · ${asset.mimeType} · ${formatBytes(asset.size)}`;
  const image = document.querySelector("#image");
  const video = document.querySelector("#video");
  const source = `http://127.0.0.1:41673/api/v1/assets/${encodeURIComponent(id)}/original`;
  image.hidden = videoAsset;
  video.hidden = !videoAsset;
  document.querySelector(".controls").hidden = videoAsset;
  document.querySelector("#help").textContent = videoAsset
    ? "Use the player controls to play, pause, seek, change volume, or enter fullscreen"
    : "Double-click the image to toggle 100% / 200% · + and − zoom · Ctrl+0 fits";
  if (videoAsset) {
    const preferences = viewerPreferences();
    video.src = source;
    video.addEventListener("loadedmetadata", () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        document.querySelector("#meta").textContent = `${video.videoWidth} × ${video.videoHeight} · ${asset.mimeType} · ${formatBytes(asset.size)}`;
      }
      video.loop = preferences.loopShortVideos && Number.isFinite(video.duration) && video.duration < 30;
      if (preferences.videoAutoplayViewer) video.play().catch(() => {});
    }, { once: true });
    video.autoplay = preferences.videoAutoplayViewer;
    video.load();
  } else {
    image.alt = filename;
    image.src = source;
  }
}

document.querySelector("#zoom-in").addEventListener("click", () => changeZoom(0.25));
document.querySelector("#zoom-out").addEventListener("click", () => changeZoom(-0.25));
document.querySelector("#fit").addEventListener("click", () => { zoom = 1; applyZoom(); });
document.querySelector("#image").addEventListener("dblclick", () => { zoom = zoom === 1 ? 2 : 1; applyZoom(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") changeZoom(0.25);
  if (event.key === "-") changeZoom(-0.25);
  if (event.ctrlKey && event.key === "0") { event.preventDefault(); zoom = 1; applyZoom(); }
});

load().catch((error) => {
  document.querySelector("#name").textContent = "Unable to open item";
  document.querySelector("#meta").textContent = String(error);
});
