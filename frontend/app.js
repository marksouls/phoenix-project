import { applyAnimatedTheme, isAnimatedTheme } from "./theme-effects.js";

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

const PREFERENCES_KEY = "phoenix.preferences.v1";
const FIRST_LAUNCH_READY_KEY = "phoenix.firstLaunchReady.v1";
const DEFAULT_PREFERENCES = Object.freeze({
  gifHoverPlayback: true,
  reverseMouseViewerNavigation: false,
  reverseArrowViewerNavigation: false,
  theme: "retrowave-embers",
  videoHoverPreview: true,
  videoAutoplayViewer: true,
  loopShortVideos: true,
  showUnfiledSection: true,
  showUntaggedSection: true,
  showRecentSection: true,
});

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    const preferences = { ...DEFAULT_PREFERENCES };
    for (const key of Object.keys(DEFAULT_PREFERENCES).filter((name) => name !== "theme")) {
      if (typeof saved[key] === "boolean") preferences[key] = saved[key];
    }
    preferences.theme = ["system", "dark", "light"].includes(saved.theme) || isAnimatedTheme(saved.theme)
      ? saved.theme
      : DEFAULT_PREFERENCES.theme;
    return preferences;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

const state = {
  assets: [],
  trashedAssets: [],
  folders: [],
  searchResults: null,
  selectedId: null,
  selectedIds: new Set(),
  selectionAnchor: null,
  collection: "all",
  folderId: null,
  bootstrap: null,
  rating: 0,
  tags: [],
  sortMode: "newest",
  wideSearch: false,
  tileSize: 205,
  tileSnapIndex: 3,
  viewMode: "grid",
  internalDrag: false,
  nativeDragActive: false,
  nativeDragStarted: false,
  nativeDragIds: [],
  recentNativeDragIds: [],
  nativeDragArmPromise: null,
  nativeDragWatchdog: null,
  internalDragGuardUntil: 0,
  assignAfterCreate: false,
  folderContextId: null,
  folderDeleteCandidate: null,
  permanentDeleteCandidate: null,
  externalDragFiles: new Map(),
  externalDragRequests: new Map(),
  inspectorAssetId: null,
  viewerId: null,
  preferences: readPreferences(),
  navigationHistory: [{ collection: "all", folderId: null, title: "All items" }],
  navigationIndex: 0,
};

const $ = (selector) => document.querySelector(selector);
const gallery = $("#gallery");
const welcome = $("#welcome-panel");
const inspectorEmpty = $("#inspector-empty");
const inspectorContent = $("#inspector-content");
const contextMenu = $("#asset-context-menu");
const folderContextMenu = $("#folder-context-menu");
const trashContextMenu = $("#trash-context-menu");
const galleryContextMenu = $("#gallery-context-menu");
const startupScreen = $("#startup-screen");
const PHOENIX_DRAG_TYPE = "application/x-phoenix-assets";
const TILE_SNAPS = [80, 110, 150, 205, 270, 350, 440];
const TILE_SNAP_LABELS = ["Min", "Tiny", "Small", "Medium", "Large", "XL", "Max"];
const firstLaunchPending = (() => {
  try { return localStorage.getItem(FIRST_LAUNCH_READY_KEY) !== "1"; }
  catch { return true; }
})();

if (firstLaunchPending) {
  startupScreen.hidden = false;
  $("#startup-progress-bar").style.width = "6%";
  $("#startup-progress-label").textContent = "6%";
}

function updateStartupProgress(percent, message) {
  if (!firstLaunchPending) return;
  const bounded = Math.max(0, Math.min(100, Math.round(percent)));
  $("#startup-progress-bar").style.width = `${bounded}%`;
  $("#startup-progress-label").textContent = `${bounded}%`;
  $("#startup-message").textContent = message;
}

function waitForRenderedFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function finishFirstLaunch() {
  if (!firstLaunchPending) return;
  try { localStorage.setItem(FIRST_LAUNCH_READY_KEY, "1"); } catch { /* The gate will reappear next launch. */ }
  updateStartupProgress(100, "Phoenix is ready");
  startupScreen.classList.add("ready");
  setTimeout(() => {
    startupScreen.hidden = true;
    startupScreen.classList.remove("ready");
  }, 300);
}

function applyPreferences() {
  const preferences = state.preferences;
  if (preferences.theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = preferences.theme;
  applyAnimatedTheme(preferences.theme);
  document.documentElement.classList.toggle("video-hover-preview", preferences.videoHoverPreview);

  const controls = {
    "#setting-gif-hover": preferences.gifHoverPlayback,
    "#setting-video-hover": preferences.videoHoverPreview,
    "#setting-video-autoplay": preferences.videoAutoplayViewer,
    "#setting-video-loop-short": preferences.loopShortVideos,
    "#setting-show-unfiled": preferences.showUnfiledSection,
    "#setting-show-untagged": preferences.showUntaggedSection,
    "#setting-show-recent": preferences.showRecentSection,
  };
  for (const [selector, checked] of Object.entries(controls)) {
    const control = $(selector);
    if (control) control.checked = checked;
  }
  const theme = $("#setting-theme");
  if (theme) theme.value = preferences.theme;
  const sidebarSections = {
    unfiled: preferences.showUnfiledSection,
    untagged: preferences.showUntaggedSection,
    recent: preferences.showRecentSection,
  };
  for (const [collection, visible] of Object.entries(sidebarSections)) {
    const section = document.querySelector(`.nav-item[data-collection="${collection}"]`);
    if (section) section.hidden = !visible;
  }

  const mouseDirection = $("#setting-mouse-direction");
  if (mouseDirection) {
    mouseDirection.setAttribute("aria-pressed", String(preferences.reverseMouseViewerNavigation));
    mouseDirection.querySelector("span").textContent = preferences.reverseMouseViewerNavigation ? "Reversed" : "Normal";
    mouseDirection.querySelector("b").textContent = preferences.reverseMouseViewerNavigation
      ? "Back → · ← Forward"
      : "Back ← · → Forward";
  }
  const arrowDirection = $("#setting-arrow-direction");
  if (arrowDirection) {
    arrowDirection.setAttribute("aria-pressed", String(preferences.reverseArrowViewerNavigation));
    arrowDirection.querySelector("span").textContent = preferences.reverseArrowViewerNavigation ? "Reversed" : "Normal";
    arrowDirection.querySelector("b").textContent = preferences.reverseArrowViewerNavigation
      ? "← Next · Previous →"
      : "← Previous · Next →";
  }
}

function updatePreferences(patch, { rerender = false } = {}) {
  state.preferences = { ...state.preferences, ...patch };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
  } catch {
    toast("Could not save settings", "Phoenix could not access local preference storage.", true);
  }
  applyPreferences();
  if (rerender) render();
}

async function command(name, args = {}) {
  if (invoke) return invoke(name, args);
  const routes = {
    get_bootstrap: ["/dev/bootstrap", "GET"],
    get_download_progress: ["/dev/download-progress", "GET"],
    import_directory: ["/dev/import", "POST"],
    import_url: ["/dev/capture-url", "POST"],
    search_assets: [`/dev/search?q=${encodeURIComponent(args.query || "")}&wide=${args.wide ? "1" : "0"}`, "GET"],
    update_asset: ["/dev/update", "POST"],
    create_text_asset: ["/dev/text/create", "POST"],
    read_text_asset: [`/dev/text/read?id=${encodeURIComponent(args.id || "")}`, "GET"],
    update_text_asset: ["/dev/text/update", "POST"],
    crop_asset: ["/dev/crop", "POST"],
    create_folder: ["/dev/folders", "POST"],
    update_folder_color: ["/dev/folder-color", "POST"],
    delete_folder: ["/dev/delete-folder", "POST"],
    add_assets_to_folder: ["/dev/folder-assets", "POST"],
    remove_assets_from_folder: ["/dev/remove-folder-assets", "POST"],
    move_assets_to_trash: ["/dev/trash", "POST"],
    restore_assets: ["/dev/restore", "POST"],
    delete_assets_permanently: ["/dev/delete-permanently", "POST"],
    empty_trash: ["/dev/empty-trash", "POST"],
    choose_directory: ["/dev/choose-directory", "GET"],
    export_assets: ["/dev/export", "POST"],
    get_external_drag_files: ["/dev/external-drag", "POST"],
  };
  const route = routes[name];
  if (!route) throw new Error(`Unsupported preview command: ${name}`);
  const response = await fetch(route[0], {
    method: route[1],
    headers: { "Content-Type": "application/json" },
    body: route[1] === "POST" ? JSON.stringify(args) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function assetById(id) {
  return [...state.assets, ...state.trashedAssets].find((asset) => asset.id === id);
}

function fullAssetName(asset) {
  return `${asset.name}${asset.extension ? `.${asset.extension}` : ""}`;
}

function isTextAsset(asset) {
  return String(asset?.extension || "").toLocaleLowerCase() === "txt" || asset?.mimeType === "text/plain";
}

function isGifAsset(asset) {
  return String(asset?.extension || "").toLocaleLowerCase() === "gif" || asset?.mimeType === "image/gif";
}

function isVideoAsset(asset) {
  const extension = String(asset?.extension || "").toLocaleLowerCase();
  return String(asset?.mimeType || "").startsWith("video/")
    || ["mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi"].includes(extension);
}

function isImageAsset(asset) {
  return String(asset?.mimeType || "").startsWith("image/");
}

function safeFolderColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#efb84c";
}

function filenamePatch(value, fallbackExtension) {
  const cleaned = String(value || "").trim();
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && dot < cleaned.length - 1) {
    return { name: cleaned.slice(0, dot), extension: cleaned.slice(dot + 1).toLocaleLowerCase() };
  }
  return { name: cleaned, extension: fallbackExtension };
}

function filteredAssets() {
  let result = state.collection === "trash"
    ? [...state.trashedAssets]
    : [...(state.searchResults || state.assets)];
  if (state.collection === "folder") result = result.filter((asset) => asset.folderIds?.includes(state.folderId));
  if (state.collection === "unfiled") result = result.filter((asset) => !(asset.folderIds?.length));
  if (state.collection === "untagged") result = result.filter((asset) => asset.tags.length === 0);
  const created = (asset) => Number(asset.createdAt || asset.importedAt || 0);
  if (state.sortMode === "oldest") result.sort((a, b) => created(a) - created(b));
  else if (state.sortMode === "name-asc") result.sort((a, b) => a.name.localeCompare(b.name));
  else if (state.sortMode === "name-desc") result.sort((a, b) => b.name.localeCompare(a.name));
  else if (state.sortMode === "size-desc") result.sort((a, b) => b.size - a.size);
  else if (state.sortMode === "size-asc") result.sort((a, b) => a.size - b.size);
  else result.sort((a, b) => created(b) - created(a));
  return result;
}

function emptyCollectionMessage() {
  if (state.collection === "trash") return "Trash is empty";
  if (state.collection === "folder") return "This folder is empty — drag items here to add them";
  if (state.collection === "unfiled") return "Every item is assigned to a folder";
  return "No matching items";
}

function assetLayoutStyle(asset) {
  const ratio = isTextAsset(asset) ? 0.78
    : Number(asset.width) > 0 && Number(asset.height) > 0 ? asset.width / asset.height
      : isVideoAsset(asset) ? 16 / 9 : 4 / 3;
  return cardLayoutStyle(ratio);
}

function assetCardMarkup(asset) {
  const text = isTextAsset(asset);
  const video = isVideoAsset(asset);
  const thumbnail = text
    ? `<div class="text-thumb-icon" aria-hidden="true"><span>TXT</span><i></i><i></i><i></i><i></i></div>`
    : video
      ? `<video data-id="${asset.id}" muted playsinline preload="auto" draggable="false"></video><span class="video-play-badge" aria-hidden="true">▶</span>`
      : `<img data-id="${asset.id}" alt="${escapeHtml(asset.name)}" draggable="false" />`;
  const details = text ? "Text file"
    : video && !(Number(asset.width) > 0 && Number(asset.height) > 0) ? "Video"
      : `${asset.width} × ${asset.height}`;
  return `
    <button class="asset-card${text ? " text-asset" : ""}${video ? " video-asset" : ""}${state.selectedIds.has(asset.id) ? " selected" : ""}" data-id="${asset.id}" draggable="false" style="${assetLayoutStyle(asset)}">
      <div class="asset-thumb">
        ${thumbnail}
        <span class="format-badge">${escapeHtml(asset.extension)}</span>
        <span class="quick-view-trigger" data-view-id="${asset.id}" title="Open item" tabindex="-1">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="5.5"/><path d="m14.5 14.5 5 5M10 7v6M7 10h6"/></svg>
        </span>
      </div>
      <div class="asset-copy">
        <span class="asset-title"><span class="asset-name">${escapeHtml(fullAssetName(asset))}</span></span>
        <span class="asset-meta"><span>${details}</span><span>${formatBytes(asset.size)}</span></span>
      </div>
    </button>`;
}

function cardLayoutStyle(ratio) {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3;
  return `--asset-ratio:${safeRatio.toFixed(5)}`;
}

let galleryLayoutFrame = 0;

function scheduleGalleryLayout() {
  cancelAnimationFrame(galleryLayoutFrame);
  galleryLayoutFrame = requestAnimationFrame(layoutGallery);
}

function layoutGallery() {
  if (state.viewMode !== "grid") return;
  const cards = [...gallery.querySelectorAll(".asset-card")];
  if (!cards.length) return;
  const availableWidth = Math.max(0, gallery.clientWidth);
  if (!availableWidth) return;
  const gap = 12;
  const targetHeight = state.tileSize;
  const rows = [];
  let row = [];

  const rowHeight = (items) => (availableWidth - gap * Math.max(0, items.length - 1))
    / items.reduce((sum, item) => sum + item.ratio, 0);
  const finishRow = (items, isLast = false) => {
    if (!items.length) return;
    const exactHeight = rowHeight(items);
    const height = isLast && exactHeight > targetHeight * 1.28 ? targetHeight : exactHeight;
    rows.push({ items, height });
  };

  for (const card of cards) {
    const asset = assetById(card.dataset.id);
    const styledRatio = Number(card.style.getPropertyValue("--asset-ratio"));
    const ratio = styledRatio > 0 ? styledRatio
      : Number(asset?.width) > 0 && Number(asset?.height) > 0 ? asset.width / asset.height : 4 / 3;
    const item = { card, ratio: Math.max(0.35, Math.min(3.6, ratio)) };
    row.push(item);
    if (rowHeight(row) <= targetHeight) {
      const withoutLast = row.slice(0, -1);
      if (withoutLast.length >= 2 && Math.abs(rowHeight(withoutLast) - targetHeight) < Math.abs(rowHeight(row) - targetHeight)) {
        finishRow(withoutLast);
        row = [item];
      } else {
        finishRow(row);
        row = [];
      }
    }
  }
  finishRow(row, true);

  for (const { items, height } of rows) {
    for (const { card, ratio } of items) {
      card.style.setProperty("--asset-width", `${Math.max(44, height * ratio)}px`);
      card.style.setProperty("--asset-ratio", ratio.toFixed(5));
    }
  }
}

function setTileSnap(nextIndex) {
  const index = Math.max(0, Math.min(TILE_SNAPS.length - 1, nextIndex));
  state.tileSnapIndex = index;
  state.tileSize = TILE_SNAPS[index];
  document.documentElement.style.setProperty("--tile", `${state.tileSize}px`);
  $("#tile-size-label").textContent = TILE_SNAP_LABELS[index];
  $("#tile-smaller").disabled = index === 0;
  $("#tile-larger").disabled = index === TILE_SNAPS.length - 1;
  scheduleGalleryLayout();
}

function updateViewModeButton() {
  const button = $("#view-mode");
  const gridMode = state.viewMode === "grid";
  button.innerHTML = gridMode ? "<span>◫</span> Grid" : "<span>☷</span> List";
  button.title = gridMode ? "Switch to list view" : "Switch to grid view";
  button.setAttribute("aria-pressed", String(!gridMode));
}

function render() {
  const assets = filteredAssets();
  const libraryIsCompletelyEmpty = state.assets.length === 0 && state.trashedAssets.length === 0;
  gallery.classList.toggle("grid-mode", state.viewMode === "grid");
  gallery.classList.toggle("list-mode", state.viewMode === "list");
  gallery.innerHTML = assets.length ? assets.map(assetCardMarkup).join("") : libraryIsCompletelyEmpty ? "" : `
      <div class="collection-empty"><span>${state.collection === "trash" ? "⌫" : "◇"}</span>${escapeHtml(emptyCollectionMessage())}</div>`;

  welcome.hidden = !libraryIsCompletelyEmpty;
  $("#all-count").textContent = state.assets.length;
  $("#trash-count").textContent = state.trashedAssets.length;
  $("#untagged-count").textContent = state.assets.filter((asset) => asset.tags.length === 0).length;
  $("#unfiled-count").textContent = state.assets.filter((asset) => !(asset.folderIds?.length)).length;
  $("#result-count").textContent = state.collection === "settings"
    ? "Saved automatically"
    : `${assets.length} ${assets.length === 1 ? "item" : "items"}`;
  $("#storage-size").textContent = formatBytes(state.assets.reduce((sum, asset) => sum + asset.size, 0));
  $("#storage-meter").style.width = `${Math.min(100, state.assets.length / 2)}%`;
  $("#empty-trash").hidden = state.collection !== "trash";
  $("#empty-trash").disabled = state.trashedAssets.length === 0;

  gallery.querySelectorAll(".asset-card").forEach((card) => {
    card.addEventListener("pointerdown", (event) => {
      startManualDragCandidate(event, card);
    });
    card.addEventListener("click", (event) => {
      if (Date.now() < suppressAssetClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      selectAsset(card.dataset.id, event);
    });
    card.addEventListener("dblclick", () => openViewer(card.dataset.id));
    card.addEventListener("contextmenu", (event) => openContextMenu(event, card.dataset.id));
  });
  gallery.querySelectorAll(".quick-view-trigger").forEach((trigger) => {
    trigger.addEventListener("pointerenter", () => scheduleQuickPreview(trigger.dataset.viewId));
    trigger.addEventListener("pointerleave", hideQuickPreview);
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      hideQuickPreview();
      openViewer(trigger.dataset.viewId);
    });
  });
  observeThumbnails();
  wireGifPlayback();
  wireVideoPlayback();
  syncSelectionUi();
  scheduleGalleryLayout();
}

function renderFolders() {
  $("#folder-list").innerHTML = state.folders.map((folder) => `
    <button class="nav-item${state.collection === "folder" && state.folderId === folder.id ? " active" : ""}" data-folder-id="${folder.id}" title="${escapeHtml(folder.name)}">
      <span class="folder-dot" style="--folder-color:${safeFolderColor(folder.color)}"></span><span>${escapeHtml(folder.name)}</span><b>${folder.itemCount}</b>
    </button>`).join("");
  $("#folder-list").querySelectorAll("[data-folder-id]").forEach((button) => {
    button.addEventListener("click", () => activateCollection("folder", button.querySelector("span:nth-child(2)").textContent, button.dataset.folderId));
    button.addEventListener("contextmenu", (event) => openFolderContextMenu(event, button.dataset.folderId));
    button.addEventListener("dragover", (event) => {
      if (!internalDragActive(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    button.addEventListener("drop", async (event) => {
      if (!internalDragActive(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      clearSidebarDropTarget();
      const draggedIds = phoenixDragIds(event.dataTransfer);
      const ids = draggedIds.length ? draggedIds : (state.nativeDragIds.length ? state.nativeDragIds : selectedAssetIds());
      if (ids.length) await addToFolder(button.dataset.folderId, ids);
    });
  });
}

function thumbnailUrl(id, original = false) {
  const version = assetById(id)?.modifiedAt || 0;
  return `http://127.0.0.1:41673/api/v1/assets/${encodeURIComponent(id)}/${original ? "original" : "thumbnail"}?v=${version}`;
}

function fileUri(path) {
  return `file://${String(path).split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function prepareExternalDragFiles(assetIds = state.assets.map((asset) => asset.id)) {
  const requested = [...new Set(assetIds)].filter((id) => !state.externalDragRequests.has(id));
  if (!requested.length) return;
  const request = command("get_external_drag_files", { assetIds: requested });
  requested.forEach((id) => state.externalDragRequests.set(id, request));
  try {
    const files = await request;
    for (const file of files || []) state.externalDragFiles.set(file.id, file);
  } catch {
    // Browser URLs remain available as a fallback if native paths cannot be prepared.
  } finally {
    requested.forEach((id) => {
      if (state.externalDragRequests.get(id) === request) state.externalDragRequests.delete(id);
    });
  }
}

function observeThumbnails() {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      image.src = thumbnailUrl(image.dataset.id);
      image.addEventListener("load", () => {
        image.classList.add("loaded");
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          const card = image.closest(".asset-card");
          card?.style.setProperty("--asset-ratio", (image.naturalWidth / image.naturalHeight).toFixed(5));
          scheduleGalleryLayout();
        }
      }, { once: true });
      observer.unobserve(image);
    }
  }, { root: $("#gallery-wrap"), rootMargin: "350px" });
  gallery.querySelectorAll("img[data-id]").forEach((image) => observer.observe(image));

  const videoObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target;
      video.src = thumbnailUrl(video.dataset.id, true);
      video.addEventListener("loadedmetadata", () => {
        video.classList.add("loaded");
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          video.closest(".asset-card")?.style.setProperty("--asset-ratio", (video.videoWidth / video.videoHeight).toFixed(5));
          scheduleGalleryLayout();
        }
      }, { once: true });
      videoObserver.unobserve(video);
    }
  }, { root: $("#gallery-wrap"), rootMargin: "350px" });
  gallery.querySelectorAll("video[data-id]").forEach((video) => videoObserver.observe(video));
}

function wireGifPlayback() {
  if (!state.preferences.gifHoverPlayback) return;
  gallery.querySelectorAll(".asset-card").forEach((card) => {
    const asset = assetById(card.dataset.id);
    const image = card.querySelector("img[data-id]");
    if (!image || !isGifAsset(asset)) return;
    card.addEventListener("pointerenter", () => {
      image.src = thumbnailUrl(asset.id, true);
      image.classList.add("loaded");
    });
    card.addEventListener("pointerleave", () => {
      image.src = thumbnailUrl(asset.id);
    });
  });
}

function wireVideoPlayback() {
  if (!state.preferences.videoHoverPreview) return;
  gallery.querySelectorAll(".video-asset").forEach((card) => {
    const video = card.querySelector("video[data-id]");
    if (!video) return;
    let hovered = false;
    let restartGeneration = 0;
    const playIfHovered = (generation = restartGeneration) => {
      if (!hovered || generation !== restartGeneration) return;
      video.play().catch(() => {});
    };
    const restartPreview = () => {
      const generation = ++restartGeneration;
      video.pause();
      try { video.currentTime = 0; } catch { /* The decoder will reset during load. */ }
      video.addEventListener("canplay", () => playIfHovered(generation), { once: true });
      // Recreate the media pipeline at the loop boundary. WebKit/GStreamer can
      // otherwise retain stale decoder state when a ranged video loops in place.
      video.load();
    };
    card.addEventListener("pointerenter", () => {
      hovered = true;
      if (video.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration - .05)) restartPreview();
      else playIfHovered();
    });
    card.addEventListener("pointerleave", () => {
      hovered = false;
      restartGeneration += 1;
      video.pause();
      try { video.currentTime = 0; } catch { /* Metadata may not be loaded yet. */ }
    });
    video.addEventListener("ended", () => {
      if (hovered) restartPreview();
    });
  });
}

function suspendVideoThumbnails() {
  gallery.querySelectorAll("video[data-id][src]").forEach((video) => {
    video.pause();
    try { video.currentTime = 0; } catch { /* The thumbnail may still be loading. */ }
  });
}

function restoreVideoThumbnailFrames() {
  gallery.querySelectorAll("video[data-id][src]").forEach((video) => {
    const id = video.dataset.id;
    if (!id) return;
    video.pause();
    video.classList.remove("loaded");
    video.removeAttribute("src");
    video.load();
    video.src = thumbnailUrl(id, true);
    video.addEventListener("loadeddata", () => {
      if (!video.isConnected) return;
      video.pause();
      try { video.currentTime = 0; } catch { /* The first decoded frame is already usable. */ }
      video.classList.add("loaded");
    }, { once: true });
    video.load();
  });
}

function setSingleSelection(id) {
  state.selectedIds = new Set(id ? [id] : []);
  state.selectedId = id;
  state.selectionAnchor = id;
  syncSelectionUi();
  if (id) prepareExternalDragFiles([id]);
}

function selectAsset(id, event = {}) {
  const visible = filteredAssets();
  if (event.shiftKey && state.selectionAnchor) {
    const start = visible.findIndex((asset) => asset.id === state.selectionAnchor);
    const end = visible.findIndex((asset) => asset.id === id);
    if (start >= 0 && end >= 0) {
      if (!event.ctrlKey && !event.metaKey) state.selectedIds.clear();
      visible.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((asset) => state.selectedIds.add(asset.id));
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.selectionAnchor = id;
  } else {
    state.selectedIds = new Set([id]);
    state.selectionAnchor = id;
  }
  state.selectedId = state.selectedIds.has(id) ? id : [...state.selectedIds][0] || null;
  syncSelectionUi();
  prepareExternalDragFiles(selectedAssetIds());
}

function syncSelectionUi() {
  if (state.viewerId && assetById(state.viewerId)) {
    state.selectedIds = new Set([state.viewerId]);
    state.selectedId = state.viewerId;
  }
  gallery.querySelectorAll(".asset-card").forEach((card) => card.classList.toggle("selected", state.selectedIds.has(card.dataset.id)));
  $("#export-button").hidden = state.selectedIds.size === 0;
  if (state.selectedIds.size !== 1) {
    state.inspectorAssetId = null;
    const inspectorVideo = $("#inspector-video");
    inspectorVideo.pause();
    inspectorVideo.removeAttribute("src");
    delete inspectorVideo.dataset.assetId;
    $("#tag-input").value = "";
    updateTagSuggestion();
    inspectorContent.hidden = true;
    inspectorEmpty.hidden = false;
    $("#inspector-empty-message").textContent = state.selectedIds.size > 1
      ? `${state.selectedIds.size} items selected`
      : "Select an item to inspect it";
    return;
  }
  const id = [...state.selectedIds][0];
  const asset = assetById(id);
  if (!asset) return;
  const changedAsset = state.inspectorAssetId !== id;
  state.inspectorAssetId = id;
  state.selectedId = id;
  inspectorEmpty.hidden = true;
  inspectorContent.hidden = false;
  const text = isTextAsset(asset);
  const video = isVideoAsset(asset);
  const inspectorVideo = $("#inspector-video");
  $("#inspector-image").hidden = text || video;
  inspectorVideo.hidden = !video;
  $("#inspector-text-icon").hidden = !text;
  if (!text && !video) {
    $("#inspector-image").src = thumbnailUrl(id, true);
    $("#inspector-image").alt = asset.name;
  } else {
    $("#inspector-image").removeAttribute("src");
  }
  if (video) {
    if (inspectorVideo.dataset.assetId !== id) {
      inspectorVideo.dataset.assetId = id;
      inspectorVideo.src = thumbnailUrl(id, true);
      inspectorVideo.addEventListener("loadedmetadata", () => {
        if (state.inspectorAssetId === id && inspectorVideo.videoWidth > 0 && inspectorVideo.videoHeight > 0) {
          $("#asset-dimensions").textContent = `${inspectorVideo.videoWidth} × ${inspectorVideo.videoHeight}`;
        }
      }, { once: true });
      inspectorVideo.load();
    }
  } else {
    inspectorVideo.pause();
    inspectorVideo.removeAttribute("src");
    delete inspectorVideo.dataset.assetId;
  }
  $("#asset-name").value = fullAssetName(asset);
  $("#asset-notes").value = asset.annotation || "";
  $("#asset-format").textContent = asset.mimeType;
  $("#asset-extension").textContent = asset.extension ? `.${String(asset.extension).toLocaleLowerCase()}` : "—";
  $("#asset-dimensions").textContent = text ? "—"
    : Number(asset.width) > 0 && Number(asset.height) > 0 ? `${asset.width} × ${asset.height}`
      : video ? "Read from video" : "—";
  $("#asset-size").textContent = formatBytes(asset.size);
  $("#asset-imported").textContent = formatDate(asset.importedAt);
  $("#asset-created").textContent = formatDate(asset.createdAt);
  $("#asset-modified").textContent = formatDate(asset.modifiedAt);
  const source = asset.website || asset.sourceUrl;
  $("#asset-source").textContent = source || "—";
  $("#asset-source").href = source || "#";
  state.rating = asset.rating;
  state.tags = [...asset.tags];
  if (changedAsset) {
    $("#tag-input").value = "";
    updateTagSuggestion();
    setMetadataAutosaveStatus("Changes save automatically");
  }
  renderRating();
  renderTags();
  renderComfyUi(asset.comfyui);
}

function labeledValues(label, values) {
  if (!values?.length) return "";
  return `<div class="comfyui-detail"><span>${escapeHtml(label)}</span><strong>${values.map(escapeHtml).join("<br>")}</strong></div>`;
}

function renderComfyUi(metadata) {
  const section = $("#comfyui-section");
  if (!metadata) {
    section.hidden = true;
    $("#comfyui-data").innerHTML = "";
    return;
  }
  const prompt = (label, value, className) => value
    ? `<div class="comfyui-prompt ${className}"><div class="comfyui-prompt-heading"><span>${label}</span><button type="button" class="comfyui-copy" data-copy-prompt="${className}" title="Copy ${label.toLocaleLowerCase()}" aria-label="Copy ${label.toLocaleLowerCase()}"><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="5" width="8" height="9" rx="1.5"/><path d="M4 12H3.5A1.5 1.5 0 0 1 2 10.5v-7A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5V4"/></svg></button></div><pre>${escapeHtml(value)}</pre></div>`
    : "";
  const samplerList = metadata.samplers || [];
  const samplers = samplerList.map((sampler, index) => {
    const fields = [
      ["Seed", sampler.seed], ["Steps", sampler.steps], ["CFG", sampler.cfg],
      ["Sampler", sampler.sampler], ["Scheduler", sampler.scheduler], ["Denoise", sampler.denoise],
    ].filter(([, value]) => value !== "" && value !== null && value !== undefined);
    if (!fields.length) return "";
    return `<div class="comfyui-sampler"><span>Sampler${samplerList.length > 1 ? ` ${index + 1}` : ""}</span><div>${fields.map(([label, value]) => `<p><small>${label}</small><strong>${escapeHtml(value)}</strong></p>`).join("")}</div></div>`;
  }).join("");
  const workflow = [metadata.nodeCount ? `${metadata.nodeCount} nodes` : "", metadata.workflowId, metadata.frontendVersion ? `ComfyUI ${metadata.frontendVersion}` : ""].filter(Boolean);
  $("#comfyui-data").innerHTML = [
    prompt("Positive prompt", metadata.positivePrompt, "positive"),
    prompt("Negative prompt", metadata.negativePrompt, "negative"),
    samplers,
    labeledValues("Models", metadata.models),
    labeledValues("LoRAs", metadata.loras),
    labeledValues("VAE", metadata.vaes),
    labeledValues("CLIP", metadata.clips),
    labeledValues("Workflow", workflow),
  ].join("");
  section.hidden = false;
}

async function copyComfyPrompt(kind) {
  const metadata = assetById(state.selectedId)?.comfyui;
  const value = kind === "negative" ? metadata?.negativePrompt : metadata?.positivePrompt;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(`${kind === "negative" ? "Negative" : "Positive"} prompt copied`, "Ready to paste");
  } catch (error) {
    toast("Could not copy prompt", String(error), true);
  }
}

let quickPreviewTimer;
function scheduleQuickPreview(id) {
  if (isTextAsset(assetById(id)) || isVideoAsset(assetById(id))) return;
  clearTimeout(quickPreviewTimer);
  quickPreviewTimer = setTimeout(() => showQuickPreview(id), 475);
}

function showQuickPreview(id) {
  const asset = assetById(id);
  if (!asset || isTextAsset(asset) || isVideoAsset(asset)) return;
  $("#quick-preview-image").src = thumbnailUrl(id, true);
  $("#quick-preview-image").alt = asset.name;
  $("#quick-preview-name").textContent = `${fullAssetName(asset)} · ${asset.width} × ${asset.height}`;
  $("#quick-preview").hidden = false;
}

function hideQuickPreview() {
  clearTimeout(quickPreviewTimer);
  $("#quick-preview").hidden = true;
  $("#quick-preview-image").removeAttribute("src");
}

let viewerZoom = 1;
let viewerPanX = 0;
let viewerPanY = 0;
let viewerPanSession = null;
let viewerTextPairId = null;
let viewerTextSplit = false;

function matchingImageForText(asset) {
  if (!isTextAsset(asset)) return null;
  const name = String(asset.name || "").trim().toLocaleLowerCase();
  if (!name) return null;
  return [...state.assets, ...state.trashedAssets].find((candidate) => candidate.id !== asset.id
    && isImageAsset(candidate)
    && String(candidate.name || "").trim().toLocaleLowerCase() === name) || null;
}

function resetViewerTransform() {
  viewerZoom = 1;
  viewerPanX = 0;
  viewerPanY = 0;
  applyViewerZoom();
}

async function openViewer(id) {
  const asset = assetById(id);
  if (!asset) return;
  const assets = filteredAssets();
  const index = assets.findIndex((item) => item.id === id);
  // The viewer, selection outline, and inspector always describe one item.
  // Reasserting the single selection also fixes stale inspector content after
  // keyboard navigation followed by Enter.
  state.selectedId = id;
  state.viewerId = id;
  setSingleSelection(id);
  const text = isTextAsset(asset);
  const video = isVideoAsset(asset);
  const textPair = text ? matchingImageForText(asset) : null;
  viewerTextPairId = textPair?.id || null;
  suspendVideoThumbnails();
  viewerTextSplit = false;
  $("#viewer-stage").classList.remove("text-split");
  viewerZoom = 1;
  viewerPanX = 0;
  viewerPanY = 0;
  $("#viewer-name").textContent = fullAssetName(asset);
  $("#viewer-meta").textContent = text
    ? `Text file · ${formatBytes(asset.size)}`
    : video
      ? `Video · ${asset.mimeType} · ${formatBytes(asset.size)}`
      : `${asset.width} × ${asset.height} · ${asset.mimeType} · ${formatBytes(asset.size)}`;
  $("#viewer-position").textContent = `${Math.max(0, index) + 1} / ${assets.length}`;
  const viewerVideo = $("#viewer-video");
  viewerVideo.pause();
  viewerVideo.autoplay = false;
  viewerVideo.loop = false;
  viewerVideo.removeAttribute("src");
  viewerVideo.load();
  $("#viewer-image").hidden = text || video;
  viewerVideo.hidden = !video;
  $("#viewer-media-pane").hidden = text;
  $("#viewer-text-editor").hidden = !text;
  $("#viewer-save-text").hidden = !text;
  $("#viewer-split").hidden = !textPair;
  $("#viewer-split").textContent = "⇳ Split";
  $("#viewer-split").setAttribute("aria-pressed", "false");
  ["#viewer-zoom-out", "#viewer-zoom-in", "#viewer-fit", "#viewer-crop", "#viewer-zoom"].forEach((selector) => {
    $(selector).hidden = text || video;
  });
  $("#viewer-footer-help").textContent = video
    ? "Use the player controls to play, pause, seek, change volume, or enter fullscreen"
    : text ? "Edit the text and press Save to keep your changes"
      : "Scroll to zoom · drag a zoomed image to pan";
  $("#viewer-trash").title = state.collection === "trash" ? "Delete permanently" : "Move item to Trash";
  if (text) {
    $("#viewer-image").removeAttribute("src");
    $("#viewer-image").alt = "";
    $("#viewer-text-editor").value = "Loading…";
    $("#viewer-text-editor").disabled = true;
  } else if (video) {
    $("#viewer-image").removeAttribute("src");
    $("#viewer-image").alt = "";
    viewerVideo.src = thumbnailUrl(id, true);
    viewerVideo.addEventListener("loadedmetadata", () => {
      if (state.viewerId === id && viewerVideo.videoWidth > 0 && viewerVideo.videoHeight > 0) {
        $("#viewer-meta").textContent = `${viewerVideo.videoWidth} × ${viewerVideo.videoHeight} · ${asset.mimeType} · ${formatBytes(asset.size)}`;
      }
      if (state.viewerId !== id) return;
      viewerVideo.loop = state.preferences.loopShortVideos
        && Number.isFinite(viewerVideo.duration)
        && viewerVideo.duration < 30;
      if (state.preferences.videoAutoplayViewer) viewerVideo.play().catch(() => {});
    }, { once: true });
    viewerVideo.autoplay = state.preferences.videoAutoplayViewer;
    viewerVideo.load();
  } else {
    $("#viewer-image").src = thumbnailUrl(id, true);
    $("#viewer-image").alt = asset.name;
  }
  applyViewerZoom();
  $("#gallery-wrap").hidden = true;
  $("#image-viewer").hidden = false;
  document.querySelector(".workspace").classList.add("viewer-active");
  if (text) {
    try {
      const content = await command("read_text_asset", { id });
      if (state.viewerId !== id || $("#image-viewer").hidden) return;
      $("#viewer-text-editor").value = content;
      $("#viewer-text-editor").disabled = false;
      $("#viewer-text-editor").focus();
    } catch (error) {
      if (state.viewerId !== id) return;
      $("#viewer-text-editor").value = "";
      $("#viewer-text-editor").disabled = false;
      toast("Could not read text file", String(error), true);
    }
  }
}

function closeViewer() {
  const wasOpen = !$("#image-viewer").hidden;
  const video = $("#viewer-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  state.viewerId = null;
  viewerTextPairId = null;
  viewerTextSplit = false;
  $("#viewer-stage").classList.remove("text-split");
  $("#image-viewer").hidden = true;
  $("#gallery-wrap").hidden = false;
  document.querySelector(".workspace").classList.remove("viewer-active");
  resetViewerTransform();
  if (wasOpen) requestAnimationFrame(restoreVideoThumbnailFrames);
}

function toggleViewerTextSplit() {
  const asset = assetById(state.viewerId);
  const pair = assetById(viewerTextPairId);
  if (!isTextAsset(asset) || !pair) return;
  viewerTextSplit = !viewerTextSplit;
  const image = $("#viewer-image");
  $("#viewer-stage").classList.toggle("text-split", viewerTextSplit);
  $("#viewer-media-pane").hidden = !viewerTextSplit;
  image.hidden = !viewerTextSplit;
  if (viewerTextSplit) {
    image.src = thumbnailUrl(pair.id, true);
    image.alt = pair.name;
  } else {
    image.removeAttribute("src");
    image.alt = "";
  }
  $("#viewer-split").textContent = viewerTextSplit ? "Text only" : "⇳ Split";
  $("#viewer-split").setAttribute("aria-pressed", String(viewerTextSplit));
}

function applyViewerZoom() {
  const stage = $("#viewer-stage");
  if (viewerZoom <= 1) {
    viewerPanX = 0;
    viewerPanY = 0;
  } else {
    const maxX = stage.clientWidth * (viewerZoom - 1) / 2;
    const maxY = stage.clientHeight * (viewerZoom - 1) / 2;
    viewerPanX = Math.max(-maxX, Math.min(maxX, viewerPanX));
    viewerPanY = Math.max(-maxY, Math.min(maxY, viewerPanY));
  }
  stage.style.setProperty("--viewer-zoom", viewerZoom);
  stage.style.setProperty("--viewer-pan-x", `${viewerPanX}px`);
  stage.style.setProperty("--viewer-pan-y", `${viewerPanY}px`);
  stage.classList.toggle("zoomed", viewerZoom > 1);
  $("#viewer-zoom").textContent = viewerZoom === 1 ? "Fit" : `${Math.round(viewerZoom * 100)}%`;
  $("#viewer-zoom-out").disabled = viewerZoom <= 0.25;
  $("#viewer-zoom-in").disabled = viewerZoom >= 8;
}

function changeViewerZoom(delta, clientX, clientY) {
  if (isTextAsset(assetById(state.viewerId)) || isVideoAsset(assetById(state.viewerId))) return;
  const previousZoom = viewerZoom;
  viewerZoom = Math.min(8, Math.max(0.25, Math.round((viewerZoom + delta) * 4) / 4));
  if (viewerZoom > 1 && previousZoom > 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = $("#viewer-stage").getBoundingClientRect();
    const offsetX = clientX - (rect.left + rect.width / 2);
    const offsetY = clientY - (rect.top + rect.height / 2);
    const scaleChange = viewerZoom / previousZoom;
    viewerPanX = offsetX - (offsetX - viewerPanX) * scaleChange;
    viewerPanY = offsetY - (offsetY - viewerPanY) * scaleChange;
  }
  applyViewerZoom();
}

function navigateViewer(direction) {
  const assets = filteredAssets();
  if (!assets.length) return;
  const index = Math.max(0, assets.findIndex((asset) => asset.id === state.viewerId));
  const nextIndex = index + direction;
  if (nextIndex < 0) {
    toast("Already at the first item", `Viewing 1 / ${assets.length}`);
    return;
  }
  if (nextIndex >= assets.length) {
    toast("Already at the last item", `Viewing ${assets.length} / ${assets.length}`);
    return;
  }
  openViewer(assets[nextIndex].id);
}

async function saveViewerText() {
  const id = state.viewerId;
  if (!id || !isTextAsset(assetById(id))) return;
  const button = $("#viewer-save-text");
  button.disabled = true;
  try {
    const asset = await command("update_text_asset", { id, content: $("#viewer-text-editor").value });
    replaceAsset(asset);
    $("#viewer-meta").textContent = `Text file · ${formatBytes(asset.size)}`;
    syncSelectionUi();
    toast("Text file saved", fullAssetName(asset));
  } catch (error) {
    toast("Could not save text file", String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function deleteViewerItem() {
  const id = state.viewerId;
  if (!id) return;
  if (state.collection === "trash") {
    closeViewer();
    setSingleSelection(id);
    requestPermanentDeletion([id]);
    return;
  }
  const visible = filteredAssets();
  const index = visible.findIndex((asset) => asset.id === id);
  const adjacentId = visible[index + 1]?.id || visible[index - 1]?.id || null;
  try {
    await command("move_assets_to_trash", { assetIds: [id] });
    state.selectedIds.clear();
    state.selectedId = null;
    await loadBootstrap();
    if (adjacentId && filteredAssets().some((asset) => asset.id === adjacentId)) {
      setSingleSelection(adjacentId);
      await openViewer(adjacentId);
    } else {
      closeViewer();
    }
    toast("Moved to Trash", "1 item");
  } catch (error) {
    toast("Could not move to Trash", String(error), true);
  }
}

async function openAssetWindow(id = state.selectedId) {
  if (!id) return;
  try {
    if (invoke) await command("open_asset_window", { id });
    else window.open(`viewer-window.html?id=${encodeURIComponent(id)}`, "_blank", "popup,width=1100,height=780");
  } catch (error) {
    toast("Could not open viewer window", String(error), true);
  }
}

async function openAssetExternally(id = state.selectedId) {
  if (!id) return;
  try {
    if (invoke) await command("open_asset_externally", { id });
    else window.open(mediaUrl(id, true), "_blank");
  } catch (error) {
    toast("Could not open item", String(error), true);
  }
}

function renderRating() {
  $("#rating-row").innerHTML = Array.from({ length: 5 }, (_, index) =>
    `<button class="${index < state.rating ? "on" : ""}" data-rating="${index + 1}" aria-label="${index + 1} stars">★</button>`
  ).join("");
  $("#rating-row").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    const rating = Number(button.dataset.rating);
    state.rating = state.rating === rating ? 0 : rating;
    renderRating();
    scheduleMetadataAutosave(0);
  }));
}

function renderTags() {
  $("#tag-editor").innerHTML = state.tags.map((tag, index) =>
    `<span class="tag">${escapeHtml(tag)}<button data-index="${index}" aria-label="Remove ${escapeHtml(tag)}">×</button></span>`
  ).join("");
  $("#tag-editor").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    state.tags.splice(Number(button.dataset.index), 1);
    renderTags();
    scheduleMetadataAutosave(0);
  }));
}

function pendingTags() {
  return $("#tag-input").value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function updateTagSuggestion() {
  const tags = pendingTags();
  const suggestion = $("#tag-create");
  suggestion.hidden = tags.length === 0 || state.selectedIds.size !== 1;
  $("#tag-create-label").textContent = tags.join(", ");
}

function commitTagInput() {
  const tags = pendingTags();
  if (!tags.length || state.selectedIds.size !== 1) {
    $("#tag-input").focus();
    return;
  }
  const known = new Set(state.tags.map((tag) => tag.toLocaleLowerCase()));
  for (const tag of tags) {
    const key = tag.toLocaleLowerCase();
    if (!known.has(key)) {
      state.tags.push(tag);
      known.add(key);
    }
  }
  $("#tag-input").value = "";
  updateTagSuggestion();
  renderTags();
  scheduleMetadataAutosave(0);
}

let metadataAutosaveTimer = null;
let metadataSaveChain = Promise.resolve();
let metadataAutosaveRevision = 0;

function setMetadataAutosaveStatus(message, mode = "") {
  const status = $("#autosave-status");
  status.classList.toggle("saving", mode === "saving");
  status.classList.toggle("error", mode === "error");
  status.innerHTML = `<span>${mode === "saving" ? "↻" : mode === "error" ? "!" : "✓"}</span> ${escapeHtml(message)}`;
}

function metadataSnapshot() {
  if (state.selectedIds.size !== 1 || !state.selectedId) return null;
  const current = assetById(state.selectedId);
  if (!current) return null;
  const filename = filenamePatch($("#asset-name").value, current.extension);
  if (!filename.name) return null;
  if (isTextAsset(current) && filename.extension !== "txt") return null;
  if (isVideoAsset(current) && filename.extension !== current.extension) return null;
  if (isImageAsset(current) && !["jpg", "jpeg", "png", "webp", "gif"].includes(filename.extension)) return null;
  return {
    id: current.id,
    previousName: fullAssetName(current),
    previousExtension: current.extension,
    patch: {
      id: current.id,
      name: filename.name,
      extension: filename.extension,
      annotation: $("#asset-notes").value,
      rating: state.rating,
      tags: [...state.tags],
    },
  };
}

function scheduleMetadataAutosave(delay = 500) {
  const snapshot = metadataSnapshot();
  clearTimeout(metadataAutosaveTimer);
  if (!snapshot) {
    setMetadataAutosaveStatus("Finish the filename to save", "error");
    return;
  }
  const revision = ++metadataAutosaveRevision;
  setMetadataAutosaveStatus("Saving…", "saving");
  metadataAutosaveTimer = setTimeout(() => {
    metadataAutosaveTimer = null;
    metadataSaveChain = metadataSaveChain
      .catch(() => {})
      .then(() => saveMetadata(snapshot, revision));
  }, delay);
}

async function saveMetadata(snapshot = metadataSnapshot(), revision = ++metadataAutosaveRevision) {
  if (!snapshot) return;
  try {
    const asset = await command("update_asset", { patch: snapshot.patch });
    const filenameChanged = snapshot.previousName !== fullAssetName(asset);
    const extensionChanged = snapshot.previousExtension !== asset.extension;
    replaceAsset(asset, { refreshExternalDrag: filenameChanged });
    if (extensionChanged) {
      render();
    } else {
      const card = gallery.querySelector(`.asset-card[data-id="${CSS.escape(asset.id)}"]`);
      if (card) card.querySelector(".asset-name").textContent = fullAssetName(asset);
    }
    if (state.inspectorAssetId === asset.id && revision === metadataAutosaveRevision) {
      setMetadataAutosaveStatus("Saved");
    }
  } catch (error) {
    if (state.inspectorAssetId === snapshot.id && revision === metadataAutosaveRevision) {
      setMetadataAutosaveStatus("Could not save", "error");
    }
    toast("Could not save changes", String(error), true);
  }
}

function replaceAsset(asset, { refreshExternalDrag = true } = {}) {
  state.assets = state.assets.map((item) => item.id === asset.id ? asset : item);
  state.trashedAssets = state.trashedAssets.map((item) => item.id === asset.id ? asset : item);
  if (state.searchResults) state.searchResults = state.searchResults.map((item) => item.id === asset.id ? asset : item);
  if (refreshExternalDrag) {
    state.externalDragFiles.delete(asset.id);
    prepareExternalDragFiles([asset.id]);
  }
}

function nameFromUrl(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).pop() || "Browser item")
      .replace(/\.[a-z0-9]{2,5}$/i, "");
  } catch {
    return "Browser item";
  }
}

async function importUrl(url) {
  toast("Browser import started", "Downloading the original item into Phoenix.");
  try {
    const asset = await command("import_url", { url, name: nameFromUrl(url) });
    await loadBootstrap();
    setSingleSelection(asset.id);
    toast("Browser item imported", asset.name);
  } catch (error) {
    toast("Browser import failed", String(error), true);
  }
}

async function importDroppedValue(value) {
  if (/^https?:\/\//i.test(value)) return importUrl(value);
  return importLocalPath(value);
}

async function importLocalPath(path) {
  try {
    const summary = await command("import_directory", { path });
    await loadBootstrap();
    const imported = Number(summary.imported || 0);
    const duplicates = Number(summary.duplicates || 0);
    const failures = summary.failed || [];
    if (imported) toast("Import complete", `${imported} ${imported === 1 ? "item" : "items"} added${duplicates ? ` · ${duplicates} already present` : ""}`);
    else if (duplicates) toast("Already in Phoenix", `${duplicates} ${duplicates === 1 ? "item is" : "items are"} already in this library`);
    else if (failures.length) toast("Import failed", failures[0], true);
    else toast("Nothing to import", "Phoenix supports PNG, JPG, WebP, GIF, MP4, M4V, MOV, WebM, MKV, OGV, AVI, and TXT files.");
  } catch (error) {
    toast("Import failed", String(error), true);
  }
}

function applyBootstrap(bootstrap) {
  state.bootstrap = bootstrap;
  state.assets = bootstrap.assets || [];
  state.trashedAssets = bootstrap.trashedAssets || [];
  state.folders = bootstrap.folders || [];
  for (const file of bootstrap.externalDragFiles || []) state.externalDragFiles.set(file.id, file);
  const allIds = new Set([...state.assets, ...state.trashedAssets].map((asset) => asset.id));
  for (const id of state.externalDragFiles.keys()) {
    if (!allIds.has(id)) state.externalDragFiles.delete(id);
  }
  state.selectedIds = new Set([...state.selectedIds].filter((id) => allIds.has(id)));
  if (!allIds.has(state.selectedId)) state.selectedId = [...state.selectedIds][0] || null;
  $("#pairing-token").textContent = bootstrap.pairingToken;
  $("#library-location").textContent = bootstrap.libraryPath;
  renderFolders();
  render();
}

async function loadBootstrap() {
  state.searchResults = null;
  applyBootstrap(await command("get_bootstrap"));
}

function bootstrapSignature(bootstrap) {
  const assets = [...(bootstrap.assets || []), ...(bootstrap.trashedAssets || [])]
    .map((asset) => `${asset.id}:${asset.name}.${asset.extension}:${asset.size}:${asset.createdAt}:${asset.modifiedAt}:${asset.importedAt}:${asset.rating}:${asset.tags.join(",")}:${(asset.folderIds || []).join(",")}`)
    .join("|");
  const folders = (bootstrap.folders || []).map((folder) => `${folder.id}:${folder.name}:${folder.color}:${folder.itemCount}`).join("|");
  return `${assets}--${folders}`;
}

let refreshingLibrary = false;
let applicationInitialized = false;
async function refreshLibrarySilently() {
  if (!applicationInitialized || refreshingLibrary || document.hidden || state.searchResults) return;
  refreshingLibrary = true;
  try {
    const bootstrap = await command("get_bootstrap");
    if (bootstrapSignature(bootstrap) !== bootstrapSignature(state.bootstrap || {})) applyBootstrap(bootstrap);
  } catch {
    // The desktop service may be restarting; normal commands surface actionable errors.
  } finally {
    refreshingLibrary = false;
  }
}

function toast(title, message, isError = false) {
  const element = document.createElement("div");
  element.className = `toast${isError ? " error" : ""}`;
  element.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  $("#toast-stack").append(element);
  setTimeout(() => element.remove(), 4800);
}

const completedDownloadIds = new Set();
let refreshingDownloadProgress = false;

function renderDownloadProgress(downloads) {
  const container = $("#download-progress-stack");
  const liveIds = new Set(downloads.map((download) => String(download.id)));

  container.querySelectorAll(".download-progress").forEach((element) => {
    if (liveIds.has(element.dataset.downloadId)) return;
    element.classList.add("leaving");
    setTimeout(() => element.remove(), 220);
  });

  downloads.forEach((download) => {
    const id = String(download.id);
    const received = Number(download.receivedBytes || 0);
    const total = Number(download.totalBytes || 0);
    const determined = total > 0;
    const percent = determined ? Math.max(0, Math.min(100, received / total * 100)) : 0;
    const terminal = download.state === "complete" || download.state === "error";
    const progressState = ["downloading", "processing", "complete", "error"].includes(download.state)
      ? download.state
      : "downloading";
    const detail = download.state === "processing"
      ? download.message
      : download.state === "complete"
        ? download.message
        : download.state === "error"
          ? download.message
          : determined
            ? `${formatBytes(received)} of ${formatBytes(total)} · ${Math.round(percent)}%`
            : `${formatBytes(received)} downloaded`;
    let element = [...container.children].find((child) => child.dataset.downloadId === id);
    if (!element) {
      element = document.createElement("section");
      element.className = "download-progress entering";
      element.dataset.downloadId = id;
      element.innerHTML = "<header><strong></strong><small></small></header><div class=\"download-progress-track\" aria-hidden=\"true\"><i></i></div>";
      container.append(element);
      requestAnimationFrame(() => element.classList.remove("entering"));
    }
    element.classList.remove("downloading", "processing", "complete", "error", "indeterminate", "leaving");
    element.classList.add(progressState);
    if (!determined && !terminal) element.classList.add("indeterminate");
    element.style.setProperty("--download-percent", `${percent}%`);
    element.querySelector("strong").textContent = download.name || "Video download";
    element.querySelector("small").textContent = detail || "Downloading video…";
  });
}

async function refreshDownloadProgress() {
  if (!applicationInitialized || refreshingDownloadProgress) return;
  refreshingDownloadProgress = true;
  try {
    const downloads = await command("get_download_progress");
    const list = Array.isArray(downloads) ? downloads : (downloads?.data || []);
    renderDownloadProgress(list);
    if (list.some((download) => download.state === "complete" && !completedDownloadIds.has(download.id))) {
      list.filter((download) => download.state === "complete")
        .forEach((download) => completedDownloadIds.add(download.id));
      await refreshLibrarySilently();
    }
  } catch {
    // Progress is supplemental; normal import errors remain visible as notifications.
  } finally {
    refreshingDownloadProgress = false;
  }
}

function clearSelection() {
  setSingleSelection(null);
}

function updateHistoryButtons() {
  $("#history-back").disabled = state.navigationIndex <= 0;
  $("#history-forward").disabled = state.navigationIndex >= state.navigationHistory.length - 1;
}

function applyCollection(collection, title, folderId = null) {
  closeViewer();
  state.collection = collection;
  state.folderId = folderId;
  const settingsOpen = collection === "settings";
  $("#settings-page").hidden = !settingsOpen;
  $("#gallery-wrap").hidden = settingsOpen;
  document.querySelector(".content-area").classList.toggle("settings-open", settingsOpen);
  document.querySelector(".workspace").classList.toggle("settings-active", settingsOpen);
  clearSelection();
  document.querySelectorAll(".nav-item[data-collection]").forEach((item) => item.classList.toggle("active", item.dataset.collection === collection));
  renderFolders();
  $("#collection-title").textContent = title;
  render();
  if (settingsOpen) $("#result-count").textContent = "Saved automatically";
  updateHistoryButtons();
}

function activateCollection(collection, title, folderId = null, recordHistory = true) {
  const current = state.navigationHistory[state.navigationIndex];
  const isSame = current?.collection === collection && current?.folderId === folderId;
  if (recordHistory && !isSame) {
    state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
    state.navigationHistory.push({ collection, folderId, title });
    state.navigationIndex = state.navigationHistory.length - 1;
  }
  applyCollection(collection, title, folderId);
}

function navigateHistory(direction) {
  const nextIndex = state.navigationIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.navigationHistory.length) return;
  state.navigationIndex = nextIndex;
  const destination = state.navigationHistory[nextIndex];
  applyCollection(destination.collection, destination.title, destination.folderId);
}

function selectedAssetIds() {
  return [...state.selectedIds];
}

function moveGallerySelection(key) {
  const cards = [...gallery.querySelectorAll(".asset-card")];
  if (!cards.length) return;
  const selectedCard = cards.find((card) => card.dataset.id === state.selectedId);
  if (!selectedCard) {
    setSingleSelection(cards[0].dataset.id);
    cards[0].scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const current = selectedCard;
  let next = current;
  const index = cards.indexOf(current);
  if (key === "ArrowLeft") next = cards[Math.max(0, index - 1)];
  if (key === "ArrowRight") next = cards[Math.min(cards.length - 1, index + 1)];
  if (key === "ArrowUp" || key === "ArrowDown") {
    const currentRect = current.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    const direction = key === "ArrowUp" ? -1 : 1;
    const candidates = cards
      .filter((card) => card !== current)
      .map((card) => {
        const rect = card.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return { card, dx: Math.abs(x - currentX), dy: (y - currentY) * direction };
      })
      .filter((candidate) => candidate.dy > 4)
      .sort((a, b) => a.dy * 4 + a.dx - (b.dy * 4 + b.dx));
    if (candidates[0]) next = candidates[0].card;
  }
  setSingleSelection(next.dataset.id);
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function moveSelectionToTrash(assetIds = selectedAssetIds()) {
  if (!assetIds.length || state.collection === "trash") return;
  try {
    await command("move_assets_to_trash", { assetIds });
    clearSelection();
    await loadBootstrap();
    toast("Moved to Trash", `${assetIds.length} ${assetIds.length === 1 ? "item" : "items"}`);
  } catch (error) {
    toast("Could not move to Trash", String(error), true);
  }
}

async function restoreSelection() {
  const assetIds = selectedAssetIds();
  if (!assetIds.length) return;
  try {
    await command("restore_assets", { assetIds });
    clearSelection();
    await loadBootstrap();
    toast("Restored", `${assetIds.length} ${assetIds.length === 1 ? "item" : "items"}`);
  } catch (error) {
    toast("Could not restore items", String(error), true);
  }
}

function requestPermanentDeletion(assetIds = selectedAssetIds(), emptyAll = false) {
  const ids = emptyAll ? state.trashedAssets.map((asset) => asset.id) : assetIds;
  if (!ids.length || (!emptyAll && state.collection !== "trash")) return;
  state.permanentDeleteCandidate = { assetIds: [...ids], emptyAll };
  $("#permanent-delete-title").textContent = emptyAll ? "Empty Trash?" : "Delete permanently?";
  $("#permanent-delete-warning").textContent = emptyAll
    ? `All ${ids.length} ${ids.length === 1 ? "item" : "items"} in Trash will be permanently deleted from disk. This cannot be undone.`
    : `${ids.length} selected ${ids.length === 1 ? "item" : "items"} will be permanently deleted from disk. This cannot be undone.`;
  $("#permanent-delete-dialog").showModal();
}

async function confirmPermanentDeletion(candidate) {
  if (!candidate?.assetIds?.length) return;
  try {
    const deleted = candidate.emptyAll
      ? await command("empty_trash")
      : await command("delete_assets_permanently", { assetIds: candidate.assetIds });
    clearSelection();
    await loadBootstrap();
    toast(candidate.emptyAll ? "Trash emptied" : "Deleted permanently", `${deleted} ${deleted === 1 ? "item" : "items"} removed`);
  } catch (error) {
    await loadBootstrap().catch(() => {});
    toast("Could not delete permanently", String(error), true);
  }
}

function openRenameDialog() {
  if (state.selectedIds.size !== 1) return;
  const asset = assetById(state.selectedId);
  if (!asset) return;
  $("#rename-input").value = fullAssetName(asset);
  $("#rename-dialog").showModal();
  requestAnimationFrame(() => $("#rename-input").select());
}

let cropAssetId = null;
let cropRect = { x: 0, y: 0, width: 1, height: 1 };
let cropPointerSession = null;

function cropImageBox() {
  const imageRect = $("#crop-image").getBoundingClientRect();
  const workspaceRect = $("#crop-workspace").getBoundingClientRect();
  return {
    left: imageRect.left - workspaceRect.left,
    top: imageRect.top - workspaceRect.top,
    width: imageRect.width,
    height: imageRect.height,
    clientLeft: imageRect.left,
    clientTop: imageRect.top,
  };
}

function renderCropSelection() {
  const asset = assetById(cropAssetId);
  const box = cropImageBox();
  if (!asset || !box.width || !box.height) return;
  const selection = $("#crop-selection");
  selection.style.left = `${box.left + cropRect.x * box.width}px`;
  selection.style.top = `${box.top + cropRect.y * box.height}px`;
  selection.style.width = `${cropRect.width * box.width}px`;
  selection.style.height = `${cropRect.height * box.height}px`;
  const width = Math.max(1, Math.round(asset.width * cropRect.width));
  const height = Math.max(1, Math.round(asset.height * cropRect.height));
  $("#crop-size").textContent = `${width} × ${height} px`;
}

function openCropDialog(id = state.selectedId) {
  const asset = assetById(id);
  if (!asset || state.collection === "trash") return;
  cropAssetId = id;
  cropRect = { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
  const image = $("#crop-image");
  image.alt = asset.name;
  image.onload = () => requestAnimationFrame(renderCropSelection);
  image.src = thumbnailUrl(id, true);
  $("#crop-dialog").showModal();
  requestAnimationFrame(renderCropSelection);
}

function cropPoint(event) {
  const box = cropImageBox();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - box.clientLeft) / box.width)),
    y: Math.max(0, Math.min(1, (event.clientY - box.clientTop) / box.height)),
  };
}

function clampCropRect(rect, minimumX, minimumY) {
  const width = Math.max(minimumX, Math.min(1, rect.width));
  const height = Math.max(minimumY, Math.min(1, rect.height));
  return {
    x: Math.max(0, Math.min(1 - width, rect.x)),
    y: Math.max(0, Math.min(1 - height, rect.y)),
    width,
    height,
  };
}

$("#crop-workspace").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !cropAssetId) return;
  const point = cropPoint(event);
  const handle = event.target.closest("[data-crop-handle]")?.dataset.cropHandle;
  const inside = event.target.closest("#crop-selection");
  cropPointerSession = {
    pointerId: event.pointerId,
    mode: handle || (inside ? "move" : "new"),
    start: point,
    original: { ...cropRect },
  };
  if (!inside) cropRect = { x: point.x, y: point.y, width: 0.001, height: 0.001 };
  $("#crop-workspace").setPointerCapture(event.pointerId);
  event.preventDefault();
});

$("#crop-workspace").addEventListener("pointermove", (event) => {
  if (!cropPointerSession || cropPointerSession.pointerId !== event.pointerId) return;
  const asset = assetById(cropAssetId);
  if (!asset) return;
  const point = cropPoint(event);
  const original = cropPointerSession.original;
  const minimumX = Math.min(1, 8 / Math.max(8, asset.width));
  const minimumY = Math.min(1, 8 / Math.max(8, asset.height));
  if (cropPointerSession.mode === "move") {
    cropRect = clampCropRect({
      ...original,
      x: original.x + point.x - cropPointerSession.start.x,
      y: original.y + point.y - cropPointerSession.start.y,
    }, minimumX, minimumY);
  } else if (cropPointerSession.mode === "new") {
    cropRect = clampCropRect({
      x: Math.min(cropPointerSession.start.x, point.x),
      y: Math.min(cropPointerSession.start.y, point.y),
      width: Math.abs(point.x - cropPointerSession.start.x),
      height: Math.abs(point.y - cropPointerSession.start.y),
    }, minimumX, minimumY);
  } else {
    let left = original.x;
    let top = original.y;
    let right = original.x + original.width;
    let bottom = original.y + original.height;
    if (cropPointerSession.mode.includes("w")) left = Math.min(point.x, right - minimumX);
    if (cropPointerSession.mode.includes("e")) right = Math.max(point.x, left + minimumX);
    if (cropPointerSession.mode.includes("n")) top = Math.min(point.y, bottom - minimumY);
    if (cropPointerSession.mode.includes("s")) bottom = Math.max(point.y, top + minimumY);
    cropRect = clampCropRect({ x: left, y: top, width: right - left, height: bottom - top }, minimumX, minimumY);
  }
  renderCropSelection();
});

function finishCropPointer(event) {
  if (!cropPointerSession || cropPointerSession.pointerId !== event.pointerId) return;
  cropPointerSession = null;
}

$("#crop-workspace").addEventListener("pointerup", finishCropPointer);
$("#crop-workspace").addEventListener("pointercancel", finishCropPointer);
$("#crop-reset").addEventListener("click", () => {
  cropRect = { x: 0, y: 0, width: 1, height: 1 };
  renderCropSelection();
});

$("#crop-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const asset = assetById(cropAssetId);
  if (!asset) return;
  const x = Math.max(0, Math.floor(asset.width * cropRect.x));
  const y = Math.max(0, Math.floor(asset.height * cropRect.y));
  const width = Math.max(1, Math.min(asset.width - x, Math.round(asset.width * cropRect.width)));
  const height = Math.max(1, Math.min(asset.height - y, Math.round(asset.height * cropRect.height)));
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const cropped = await command("crop_asset", { id: asset.id, x, y, width, height });
    $("#crop-dialog").close("applied");
    await loadBootstrap();
    setSingleSelection(cropped.id);
    if (!$("#image-viewer").hidden) openViewer(cropped.id);
    toast("Image cropped", `${cropped.width} × ${cropped.height} px`);
  } catch (error) {
    toast("Could not crop image", String(error), true);
  } finally {
    if (submit) submit.disabled = false;
  }
});

window.addEventListener("resize", () => {
  if ($("#crop-dialog").open) renderCropSelection();
});

function openFolderDialog() {
  if (!state.selectedIds.size) return;
  if (!state.folders.length) {
    state.assignAfterCreate = true;
    openNewFolderDialog();
    return;
  }
  $("#folder-selection-count").textContent = `${state.selectedIds.size} ${state.selectedIds.size === 1 ? "item" : "items"} selected`;
  $("#folder-select").innerHTML = state.folders.map((folder) => `<option value="${folder.id}">${escapeHtml(folder.name)}</option>`).join("");
  $("#folder-dialog").showModal();
}

function openNewFolderDialog() {
  $("#new-folder-name").value = "";
  $("#new-folder-dialog").showModal();
  requestAnimationFrame(() => $("#new-folder-name").focus());
}

async function addToFolder(folderId, assetIds = selectedAssetIds()) {
  if (!folderId || !assetIds.length) return;
  try {
    await command("add_assets_to_folder", { folderId, assetIds });
    await loadBootstrap();
    const folder = state.folders.find((item) => item.id === folderId);
    toast("Added to folder", `${assetIds.length} ${assetIds.length === 1 ? "item" : "items"} · ${folder?.name || "Folder"}`);
  } catch (error) {
    toast("Could not add to folder", String(error), true);
  }
}

async function removeFromCurrentFolder(assetIds = selectedAssetIds()) {
  if (state.collection !== "folder" || !state.folderId || !assetIds.length) return;
  const folderId = state.folderId;
  const folderName = state.folders.find((folder) => folder.id === folderId)?.name || "folder";
  try {
    await command("remove_assets_from_folder", { folderId, assetIds });
    clearSelection();
    await loadBootstrap();
    toast("Removed from folder", `${assetIds.length} ${assetIds.length === 1 ? "item" : "items"} · ${folderName}`);
  } catch (error) {
    toast("Could not remove from folder", String(error), true);
  }
}

async function exportSelection() {
  const assetIds = selectedAssetIds();
  if (!assetIds.length) return;
  await exportAssetIds(assetIds, "selection");
}

async function exportAssetIds(assetIds, label) {
  try {
    const destination = await command("choose_directory");
    if (!destination) return;
    const summary = await command("export_assets", { assetIds, destination });
    toast("Export complete", `${summary.exported} ${summary.exported === 1 ? "item" : "items"} from ${label} exported to ${destination}${summary.failed.length ? ` · ${summary.failed.length} failed` : ""}`, summary.failed.length > 0);
  } catch (error) {
    toast("Export failed", String(error), true);
  }
}

async function exportFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) return;
  const assetIds = state.assets
    .filter((asset) => asset.folderIds?.includes(folderId))
    .map((asset) => asset.id);
  if (!assetIds.length) {
    toast("Folder is empty", `${folder.name} has no items to export`);
    return;
  }
  await exportAssetIds(assetIds, `“${folder.name}”`);
}

function openContextMenu(event, id) {
  event.preventDefault();
  hideQuickPreview();
  if (!state.selectedIds.has(id)) setSingleSelection(id);
  state.selectedId = id;
  const isMultiSelection = state.selectedIds.size > 1;
  const text = isTextAsset(assetById(id));
  const video = isVideoAsset(assetById(id));
  contextMenu.querySelector('[data-action="view"]').hidden = isMultiSelection;
  contextMenu.querySelector('[data-action="new-window"]').hidden = isMultiSelection || text;
  contextMenu.querySelector('[data-action="external-app"]').hidden = isMultiSelection;
  contextMenu.querySelector('[data-action="rename"]').disabled = state.selectedIds.size !== 1 || state.collection === "trash";
  contextMenu.querySelector('[data-action="crop"]').hidden = text || video;
  contextMenu.querySelector('[data-action="crop"]').disabled = state.selectedIds.size !== 1 || state.collection === "trash" || text || video;
  contextMenu.querySelector('[data-action="folder"]').disabled = state.collection === "trash";
  contextMenu.querySelector('[data-action="remove-folder"]').hidden = state.collection !== "folder";
  contextMenu.querySelector('[data-action="trash"]').hidden = state.collection === "trash";
  contextMenu.querySelector('[data-action="restore"]').hidden = state.collection !== "trash";
  contextMenu.querySelector('[data-action="delete-permanently"]').hidden = state.collection !== "trash";
  contextMenu.hidden = false;
  const width = contextMenu.offsetWidth;
  const height = contextMenu.offsetHeight;
  contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - width - 8))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - height - 8))}px`;
}

function closeContextMenu() {
  contextMenu.hidden = true;
}

function openFolderContextMenu(event, folderId) {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();
  state.folderContextId = folderId;
  const folder = state.folders.find((item) => item.id === folderId);
  folderContextMenu.querySelector('[data-folder-action="export"]').disabled = !folder?.itemCount;
  folderContextMenu.hidden = false;
  const width = folderContextMenu.offsetWidth;
  const height = folderContextMenu.offsetHeight;
  folderContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - width - 8))}px`;
  folderContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - height - 8))}px`;
}

function closeFolderContextMenu() {
  folderContextMenu.hidden = true;
  state.folderContextId = null;
}

function openTrashContextMenu(event) {
  event.preventDefault();
  closeContextMenu();
  closeFolderContextMenu();
  trashContextMenu.querySelector('[data-trash-action="empty"]').disabled = state.trashedAssets.length === 0;
  trashContextMenu.hidden = false;
  const width = trashContextMenu.offsetWidth;
  const height = trashContextMenu.offsetHeight;
  trashContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - width - 8))}px`;
  trashContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - height - 8))}px`;
}

function closeTrashContextMenu() {
  trashContextMenu.hidden = true;
}

function openGalleryContextMenu(event) {
  if (event.target.closest(".asset-card") || !$("#image-viewer").hidden || state.collection === "trash") return;
  event.preventDefault();
  closeContextMenu();
  closeFolderContextMenu();
  closeTrashContextMenu();
  galleryContextMenu.hidden = false;
  const width = galleryContextMenu.offsetWidth;
  const height = galleryContextMenu.offsetHeight;
  galleryContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - width - 8))}px`;
  galleryContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - height - 8))}px`;
}

function closeGalleryContextMenu() {
  galleryContextMenu.hidden = true;
}

function openTextFileDialog() {
  $("#text-file-name").value = "Untitled.txt";
  $("#text-file-content").value = "";
  $("#text-file-dialog").showModal();
  requestAnimationFrame(() => $("#text-file-name").select());
}

function requestFolderDeletion(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) return;
  state.folderDeleteCandidate = folder.id;
  $("#delete-folder-name").textContent = folder.name;
  $("#delete-folder-warning").textContent = folder.itemCount > 0
    ? `This folder contains ${folder.itemCount} ${folder.itemCount === 1 ? "item" : "items"}. Deleting it will move ${folder.itemCount === 1 ? "that item" : "those items"} to Trash.`
    : "The empty folder will be removed from your library.";
  $("#delete-folder-dialog").showModal();
}

async function deleteFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) return;
  try {
    const trashed = await command("delete_folder", { folderId });
    const deletingActiveFolder = state.collection === "folder" && state.folderId === folderId;
    const currentDestination = deletingActiveFolder
      ? { collection: "all", folderId: null, title: "All items" }
      : state.navigationHistory[state.navigationIndex];
    state.navigationHistory = state.navigationHistory.filter((entry) => !(entry.collection === "folder" && entry.folderId === folderId));
    let destinationIndex = state.navigationHistory.findIndex((entry) => entry.collection === currentDestination?.collection && entry.folderId === currentDestination?.folderId);
    if (destinationIndex < 0) {
      state.navigationHistory.push(currentDestination || { collection: "all", folderId: null, title: "All items" });
      destinationIndex = state.navigationHistory.length - 1;
    }
    state.navigationIndex = destinationIndex;
    if (deletingActiveFolder) applyCollection("all", "All items");
    else updateHistoryButtons();
    await loadBootstrap();
    toast("Folder deleted", `${folder.name}${trashed ? ` · ${trashed} ${trashed === 1 ? "item" : "items"} moved to Trash` : ""}`);
  } catch (error) {
    toast("Could not delete folder", String(error), true);
  }
}

function isEditableTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

let searchTimer;
$("#search-input").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      state.searchResults = event.target.value.trim()
        ? await command("search_assets", { query: event.target.value.trim(), wide: state.wideSearch })
        : null;
      clearSelection();
      render();
    } catch (error) {
      toast("Search failed", String(error), true);
    }
  }, 180);
});
$("#search-scope").addEventListener("click", () => {
  state.wideSearch = !state.wideSearch;
  const button = $("#search-scope");
  button.textContent = state.wideSearch ? "All" : "Name";
  button.title = state.wideSearch ? "Search filenames, URLs, notes, and tags" : "Search filenames only";
  button.setAttribute("aria-pressed", String(state.wideSearch));
  $("#search-input").placeholder = state.wideSearch ? "Search all fields" : "Search filenames";
  $("#search-input").setAttribute("aria-label", $("#search-input").placeholder);
  $("#search-input").dispatchEvent(new Event("input"));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeContextMenu();
    closeFolderContextMenu();
    closeTrashContextMenu();
    closeGalleryContextMenu();
  }
  if (!$("#image-viewer").hidden) {
    const editingText = event.target === $("#viewer-text-editor");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editingText) {
      event.preventDefault();
      saveViewerText();
    } else if (!editingText && event.key === "ArrowLeft") navigateViewer(state.preferences.reverseArrowViewerNavigation ? 1 : -1);
    else if (!editingText && event.key === "ArrowRight") navigateViewer(state.preferences.reverseArrowViewerNavigation ? -1 : 1);
    else if (!editingText && (event.key === "+" || event.key === "=")) changeViewerZoom(0.25);
    else if (!editingText && event.key === "-") changeViewerZoom(-0.25);
    else if (!editingText && event.key === "Delete") {
      event.preventDefault();
      deleteViewerItem();
    } else if (event.key === "Escape") closeViewer();
    return;
  }
  if (isEditableTarget(event.target) || document.querySelector("dialog[open]")) return;
  if (state.collection === "settings") return;
  if (event.key === "/") {
    event.preventDefault();
    $("#search-input").focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    state.selectedIds = new Set(filteredAssets().map((asset) => asset.id));
    state.selectedId = [...state.selectedIds][0] || null;
    syncSelectionUi();
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    moveGallerySelection(event.key);
  }
  if (event.key === "Delete" && state.collection !== "trash") {
    event.preventDefault();
    moveSelectionToTrash();
  }
  if (event.key === "Delete" && state.collection === "trash") {
    event.preventDefault();
    requestPermanentDeletion();
  }
  if (event.key === "F2") {
    event.preventDefault();
    openRenameDialog();
  }
  if (event.key === "Enter" && state.selectedId) openViewer(state.selectedId);
  if (/^[1-5]$/.test(event.key) && state.selectedIds.size === 1) {
    state.rating = Number(event.key);
    renderRating();
    scheduleMetadataAutosave(0);
  }
});

$("#tile-smaller").addEventListener("click", () => setTileSnap(state.tileSnapIndex - 1));
$("#tile-larger").addEventListener("click", () => setTileSnap(state.tileSnapIndex + 1));
$("#view-mode").addEventListener("click", () => {
  state.viewMode = state.viewMode === "grid" ? "list" : "grid";
  updateViewModeButton();
  render();
});
$("#gallery-wrap").addEventListener("wheel", (event) => {
  if (!event.ctrlKey || !$("#image-viewer").hidden) return;
  event.preventDefault();
  setTileSnap(state.tileSnapIndex + (event.deltaY < 0 ? 1 : -1));
}, { passive: false });
new ResizeObserver(scheduleGalleryLayout).observe($("#gallery-wrap"));
$("#sort-select").addEventListener("change", (event) => {
  state.sortMode = event.target.value;
  render();
});
$("#asset-name").addEventListener("input", () => scheduleMetadataAutosave(700));
$("#asset-name").addEventListener("change", () => scheduleMetadataAutosave(0));
$("#asset-notes").addEventListener("input", () => scheduleMetadataAutosave(500));
$("#export-button").addEventListener("click", exportSelection);
$("#empty-trash").addEventListener("click", () => requestPermanentDeletion([], true));
$("#tag-input").addEventListener("input", updateTagSuggestion);
$("#tag-input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  commitTagInput();
});
$("#tag-add").addEventListener("click", commitTagInput);
$("#tag-create").addEventListener("click", commitTagInput);
$("#comfyui-data").addEventListener("click", (event) => {
  const kind = event.target.closest("[data-copy-prompt]")?.dataset.copyPrompt;
  if (kind) copyComfyPrompt(kind);
});
$("#asset-source").addEventListener("click", async (event) => {
  event.preventDefault();
  const source = assetById(state.inspectorAssetId)?.website || assetById(state.inspectorAssetId)?.sourceUrl;
  if (!source) return;
  try {
    if (invoke) await invoke("open_external_url", { url: source });
    else window.open(source, "_blank", "noopener,noreferrer");
  } catch (error) {
    toast("Could not open source", String(error), true);
  }
});
$("#viewer-close").addEventListener("click", closeViewer);
$("#viewer-save-text").addEventListener("click", saveViewerText);
$("#viewer-split").addEventListener("click", toggleViewerTextSplit);
$("#viewer-trash").addEventListener("click", deleteViewerItem);
$("#viewer-zoom-in").addEventListener("click", () => changeViewerZoom(0.25));
$("#viewer-zoom-out").addEventListener("click", () => changeViewerZoom(-0.25));
$("#viewer-fit").addEventListener("click", resetViewerTransform);
$("#viewer-crop").addEventListener("click", () => openCropDialog(state.selectedId));
$("#viewer-previous").addEventListener("click", () => navigateViewer(-1));
$("#viewer-next").addEventListener("click", () => navigateViewer(1));
$("#viewer-image").addEventListener("dblclick", (event) => {
  if (viewerZoom === 1) changeViewerZoom(1, event.clientX, event.clientY);
  else resetViewerTransform();
});
$("#viewer-stage").addEventListener("wheel", (event) => {
  if ($("#image-viewer").hidden || isTextAsset(assetById(state.viewerId)) || isVideoAsset(assetById(state.viewerId))) return;
  event.preventDefault();
  changeViewerZoom(event.deltaY < 0 ? 0.25 : -0.25, event.clientX, event.clientY);
}, { passive: false });
$("#viewer-stage").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || viewerZoom <= 1 || event.target.closest("button") || isTextAsset(assetById(state.viewerId)) || isVideoAsset(assetById(state.viewerId))) return;
  viewerPanSession = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: viewerPanX, panY: viewerPanY };
  $("#viewer-stage").setPointerCapture(event.pointerId);
  $("#viewer-stage").classList.add("panning");
  event.preventDefault();
});
$("#viewer-stage").addEventListener("pointermove", (event) => {
  if (!viewerPanSession || viewerPanSession.pointerId !== event.pointerId) return;
  viewerPanX = viewerPanSession.panX + event.clientX - viewerPanSession.startX;
  viewerPanY = viewerPanSession.panY + event.clientY - viewerPanSession.startY;
  applyViewerZoom();
});
function endViewerPan(event) {
  if (!viewerPanSession || viewerPanSession.pointerId !== event.pointerId) return;
  viewerPanSession = null;
  $("#viewer-stage").classList.remove("panning");
}
$("#viewer-stage").addEventListener("pointerup", endViewerPan);
$("#viewer-stage").addEventListener("pointercancel", endViewerPan);
$("#sidebar-toggle").addEventListener("click", () => {
  const collapsed = document.querySelector(".app-shell").classList.toggle("sidebar-collapsed");
  const button = $("#sidebar-toggle");
  button.textContent = collapsed ? "›" : "‹";
  button.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(!collapsed));
});
$("#open-settings").addEventListener("click", () => activateCollection("settings", "Settings"));
$("#setting-theme").addEventListener("change", (event) => {
  updatePreferences({ theme: event.target.value });
});
$("#setting-gif-hover").addEventListener("change", (event) => {
  updatePreferences({ gifHoverPlayback: event.target.checked }, { rerender: true });
});
$("#setting-video-hover").addEventListener("change", (event) => {
  updatePreferences({ videoHoverPreview: event.target.checked }, { rerender: true });
});
$("#setting-video-autoplay").addEventListener("change", (event) => {
  updatePreferences({ videoAutoplayViewer: event.target.checked });
});
$("#setting-video-loop-short").addEventListener("change", (event) => {
  updatePreferences({ loopShortVideos: event.target.checked });
});
$("#setting-show-unfiled").addEventListener("change", (event) => {
  updatePreferences({ showUnfiledSection: event.target.checked });
});
$("#setting-show-untagged").addEventListener("change", (event) => {
  updatePreferences({ showUntaggedSection: event.target.checked });
});
$("#setting-show-recent").addEventListener("change", (event) => {
  updatePreferences({ showRecentSection: event.target.checked });
});
$("#setting-mouse-direction").addEventListener("click", () => {
  updatePreferences({ reverseMouseViewerNavigation: !state.preferences.reverseMouseViewerNavigation });
});
$("#setting-arrow-direction").addEventListener("click", () => {
  updatePreferences({ reverseArrowViewerNavigation: !state.preferences.reverseArrowViewerNavigation });
});
$("#inspector-toggle").addEventListener("click", () => {
  const collapsed = document.querySelector(".content-area").classList.toggle("inspector-collapsed");
  const button = $("#inspector-toggle");
  button.textContent = collapsed ? "‹" : "›";
  button.title = collapsed ? "Expand inspector" : "Collapse inspector";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(!collapsed));
});
$("#history-back").addEventListener("click", () => navigateHistory(-1));
$("#history-forward").addEventListener("click", () => navigateHistory(1));
$("#show-pairing").addEventListener("click", () => $("#pairing-dialog").showModal());
$("#copy-token").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.bootstrap.pairingToken);
  toast("Token copied", "Paste it into the Phoenix Firefox extension.");
});
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#rename-dialog").close();
  try {
    const current = assetById(state.selectedId);
    const filename = filenamePatch($("#rename-input").value, current?.extension);
    const asset = await command("update_asset", { patch: { id: state.selectedId, name: filename.name, extension: filename.extension } });
    replaceAsset(asset);
    render();
    toast("Item renamed", fullAssetName(asset));
  } catch (error) {
    toast("Could not rename item", String(error), true);
  }
});
$("#text-file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const filename = filenamePatch($("#text-file-name").value, "txt");
  if (!filename.name) return;
  const folderId = state.collection === "folder" ? state.folderId : null;
  const submit = $("#text-file-form .primary-button");
  submit.disabled = true;
  try {
    const asset = await command("create_text_asset", {
      name: `${filename.name}.txt`,
      content: $("#text-file-content").value,
    });
    if (folderId) await command("add_assets_to_folder", { folderId, assetIds: [asset.id] });
    $("#text-file-dialog").close();
    await loadBootstrap();
    setSingleSelection(asset.id);
    openViewer(asset.id);
    toast("Text file created", `${filename.name}.txt`);
  } catch (error) {
    toast("Could not create text file", String(error), true);
  } finally {
    submit.disabled = false;
  }
});
$("#folder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("#folder-dialog").close();
  addToFolder($("#folder-select").value);
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
  const dialog = button.closest("dialog");
  if (dialog?.id === "new-folder-dialog") state.assignAfterCreate = false;
  if (dialog?.id === "delete-folder-dialog") state.folderDeleteCandidate = null;
  if (dialog?.id === "permanent-delete-dialog") state.permanentDeleteCandidate = null;
  dialog?.close("cancel");
}));
$("#new-folder-dialog").addEventListener("cancel", () => { state.assignAfterCreate = false; });
$("#new-folder").addEventListener("click", () => { state.assignAfterCreate = false; openNewFolderDialog(); });
$("#create-folder-from-assign").addEventListener("click", () => {
  $("#folder-dialog").close();
  state.assignAfterCreate = true;
  openNewFolderDialog();
});
$("#new-folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#new-folder-dialog").close();
  const shouldAssign = state.assignAfterCreate;
  state.assignAfterCreate = false;
  try {
    const folder = await command("create_folder", { name: $("#new-folder-name").value.trim() });
    if (shouldAssign && state.selectedIds.size) await command("add_assets_to_folder", { folderId: folder.id, assetIds: selectedAssetIds() });
    await loadBootstrap();
    toast("Folder created", shouldAssign ? `${folder.name} · selected items added` : folder.name);
  } catch (error) {
    toast("Could not create folder", String(error), true);
  }
});
$("#delete-folder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const folderId = state.folderDeleteCandidate;
  state.folderDeleteCandidate = null;
  $("#delete-folder-dialog").close();
  if (folderId) deleteFolder(folderId);
});
$("#delete-folder-dialog").addEventListener("cancel", () => { state.folderDeleteCandidate = null; });
$("#permanent-delete-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const candidate = state.permanentDeleteCandidate;
  state.permanentDeleteCandidate = null;
  $("#permanent-delete-dialog").close();
  confirmPermanentDeletion(candidate);
});
$("#permanent-delete-dialog").addEventListener("cancel", () => { state.permanentDeleteCandidate = null; });

document.querySelectorAll(".nav-item[data-collection]").forEach((button) => button.addEventListener("click", () => {
  activateCollection(button.dataset.collection, button.querySelector("span:nth-child(2)").textContent);
}));
document.querySelectorAll(".nav-item[data-collection]").forEach((button) => {
  button.title = button.querySelector("span:nth-child(2)")?.textContent || "Library section";
});
document.querySelector('.nav-item[data-collection="trash"]').addEventListener("contextmenu", openTrashContextMenu);
$("#gallery-wrap").addEventListener("contextmenu", openGalleryContextMenu);

let marqueeSession = null;
let suppressBackgroundClick = false;
const selectionMarquee = $("#selection-marquee");

function marqueeRect(session, clientX, clientY) {
  return {
    left: Math.min(session.startX, clientX),
    top: Math.min(session.startY, clientY),
    right: Math.max(session.startX, clientX),
    bottom: Math.max(session.startY, clientY),
  };
}

$("#gallery-wrap").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".asset-card") || !$("#image-viewer").hidden) return;
  hideQuickPreview();
  closeContextMenu();
  closeFolderContextMenu();
  const additive = event.ctrlKey || event.metaKey;
  marqueeSession = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    baseSelection: new Set(additive ? state.selectedIds : []),
  };
  if (!additive) clearSelection();
  $("#gallery-wrap").setPointerCapture(event.pointerId);
  event.preventDefault();
});

$("#gallery-wrap").addEventListener("pointermove", (event) => {
  if (!marqueeSession || marqueeSession.pointerId !== event.pointerId) return;
  if (!marqueeSession.moved && Math.hypot(event.clientX - marqueeSession.startX, event.clientY - marqueeSession.startY) < 4) return;
  marqueeSession.moved = true;
  const rect = marqueeRect(marqueeSession, event.clientX, event.clientY);
  selectionMarquee.hidden = false;
  selectionMarquee.style.left = `${rect.left}px`;
  selectionMarquee.style.top = `${rect.top}px`;
  selectionMarquee.style.width = `${rect.right - rect.left}px`;
  selectionMarquee.style.height = `${rect.bottom - rect.top}px`;
  const selected = new Set(marqueeSession.baseSelection);
  gallery.querySelectorAll(".asset-card").forEach((card) => {
    const cardRect = card.getBoundingClientRect();
    const intersects = cardRect.left < rect.right && cardRect.right > rect.left
      && cardRect.top < rect.bottom && cardRect.bottom > rect.top;
    if (intersects) selected.add(card.dataset.id);
  });
  state.selectedIds = selected;
  state.selectedId = selected.has(state.selectedId) ? state.selectedId : [...selected][0] || null;
  syncSelectionUi();
});

function finishMarquee(event) {
  if (!marqueeSession || marqueeSession.pointerId !== event.pointerId) return;
  suppressBackgroundClick = marqueeSession.moved;
  marqueeSession = null;
  selectionMarquee.hidden = true;
}

$("#gallery-wrap").addEventListener("pointerup", finishMarquee);
$("#gallery-wrap").addEventListener("pointercancel", finishMarquee);
$("#gallery-wrap").addEventListener("click", (event) => {
  if (suppressBackgroundClick) {
    suppressBackgroundClick = false;
    return;
  }
  if (!event.target.closest(".asset-card") && !event.target.closest(".quick-view-trigger")) clearSelection();
});

window.addEventListener("mousedown", (event) => {
  if (event.button === 3 || event.button === 4) event.preventDefault();
}, true);
window.addEventListener("mouseup", (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  if (event.button === 3) {
    if (!$("#image-viewer").hidden) navigateViewer(state.preferences.reverseMouseViewerNavigation ? 1 : -1);
    else navigateHistory(-1);
  } else {
    if (!$("#image-viewer").hidden) navigateViewer(state.preferences.reverseMouseViewerNavigation ? -1 : 1);
    else navigateHistory(1);
  }
}, true);

const trashDropTarget = document.querySelector('[data-collection="trash"]');
trashDropTarget.addEventListener("dragover", (event) => {
  if (!internalDragActive(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
trashDropTarget.addEventListener("drop", async (event) => {
  if (!internalDragActive(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  clearSidebarDropTarget();
  const draggedIds = phoenixDragIds(event.dataTransfer);
  const ids = draggedIds.length ? draggedIds : (state.nativeDragIds.length ? state.nativeDragIds : selectedAssetIds());
  if (ids.length) await moveSelectionToTrash(ids);
});

contextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  if (!action) return;
  closeContextMenu();
  if (action === "view") openViewer(state.selectedId);
  if (action === "new-window") openAssetWindow(state.selectedId);
  if (action === "external-app") openAssetExternally(state.selectedId);
  if (action === "rename") openRenameDialog();
  if (action === "crop") openCropDialog(state.selectedId);
  if (action === "folder") openFolderDialog();
  if (action === "remove-folder") removeFromCurrentFolder();
  if (action === "export") exportSelection();
  if (action === "trash") moveSelectionToTrash();
  if (action === "restore") restoreSelection();
  if (action === "delete-permanently") requestPermanentDeletion();
});
trashContextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.trashAction;
  if (!action) return;
  closeTrashContextMenu();
  if (action === "empty") requestPermanentDeletion([], true);
});
folderContextMenu.addEventListener("click", (event) => {
  const color = event.target.closest("[data-folder-color]")?.dataset.folderColor;
  const action = event.target.closest("button")?.dataset.folderAction;
  const folderId = state.folderContextId;
  if (color && folderId) {
    command("update_folder_color", { folderId, color })
      .then(loadBootstrap)
      .catch((error) => toast("Could not change folder color", String(error), true));
    closeFolderContextMenu();
    return;
  }
  if (!action) return;
  closeFolderContextMenu();
  if (action === "export" && folderId) exportFolder(folderId);
  if (action === "delete" && folderId) requestFolderDeletion(folderId);
});
galleryContextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.galleryAction;
  if (!action) return;
  closeGalleryContextMenu();
  if (action === "new-text") openTextFileDialog();
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#asset-context-menu")) closeContextMenu();
  if (!event.target.closest("#folder-context-menu")) closeFolderContextMenu();
  if (!event.target.closest("#trash-context-menu")) closeTrashContextMenu();
  if (!event.target.closest("#gallery-context-menu")) closeGalleryContextMenu();
});
window.addEventListener("blur", () => {
  closeContextMenu();
  closeFolderContextMenu();
  closeTrashContextMenu();
  closeGalleryContextMenu();
  cancelManualDrag();
});

function isPhoenixDrag(dataTransfer) {
  return [...(dataTransfer?.types || [])].includes(PHOENIX_DRAG_TYPE);
}

function phoenixDragIds(dataTransfer) {
  try {
    const ids = JSON.parse(dataTransfer?.getData(PHOENIX_DRAG_TYPE) || "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

let activeSidebarDropTarget = null;

function setSidebarDropTarget(target) {
  if (target === activeSidebarDropTarget) return;
  clearSidebarDropTarget();
  activeSidebarDropTarget = target;
  if (!target) return;
  target.classList.add(target.dataset.collection === "trash" ? "trash-drop-target" : "folder-drop-target");
}

function clearSidebarDropTarget() {
  if (activeSidebarDropTarget) {
    activeSidebarDropTarget.classList.remove("folder-drop-target", "trash-drop-target");
    activeSidebarDropTarget = null;
  }
  document.querySelectorAll(".folder-drop-target, .trash-drop-target").forEach((target) => {
    target.classList.remove("folder-drop-target", "trash-drop-target");
  });
}

function updateSidebarDropTarget(event) {
  updateSidebarDropTargetAt(event.clientX, event.clientY);
}

function updateSidebarDropTargetAt(clientX, clientY) {
  const target = findSidebarDropTargetAt(clientX, clientY);
  setSidebarDropTarget(target);
  return target;
}

function findSidebarDropTargetAt(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  let target = element?.closest?.('[data-folder-id], [data-collection="trash"]') || null;
  if (!target) {
    target = [...document.querySelectorAll('[data-folder-id], [data-collection="trash"]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return clientX >= rect.left - 10 && clientX <= rect.right + 10
        && clientY >= rect.top - 11 && clientY <= rect.bottom + 11;
    }) || null;
  }
  return target;
}

function beginDragUi(card) {
  state.internalDrag = true;
  state.internalDragGuardUntil = Number.POSITIVE_INFINITY;
  document.body.classList.add("phoenix-dragging");
  card.classList.add("dragging");
}

function finishDragUi() {
  if (state.nativeDragStarted && state.nativeDragIds.length) {
    state.recentNativeDragIds = [...state.nativeDragIds];
  }
  clearTimeout(state.nativeDragWatchdog);
  state.nativeDragWatchdog = null;
  state.internalDrag = false;
  state.nativeDragActive = false;
  state.nativeDragStarted = false;
  state.nativeDragIds = [];
  state.nativeDragArmPromise = null;
  state.internalDragGuardUntil = Date.now() + 2500;
  document.body.classList.remove("phoenix-dragging");
  gallery.querySelectorAll(".dragging").forEach((card) => card.classList.remove("dragging"));
  clearSidebarDropTarget();
  document.querySelector(".drag-ghost")?.remove();
  $("#drop-overlay").classList.remove("visible");
}

let manualDragSession = null;
let suppressAssetClickUntil = 0;
const MANUAL_DRAG_DISTANCE = 6;

function showManualDragGhost(count, clientX, clientY) {
  let ghost = document.querySelector(".drag-ghost.manual");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "drag-ghost manual";
    ghost.innerHTML = `<i>▧</i><strong>${count}</strong>`;
    document.body.append(ghost);
  }
  ghost.style.transform = `translate(${clientX + 14}px, ${clientY + 14}px)`;
}

function releaseManualPointer(session) {
  try {
    if (session.card.hasPointerCapture(session.pointerId)) session.card.releasePointerCapture(session.pointerId);
  } catch {
    // The native compositor may already own the pointer after an external handoff.
  }
}

function startManualDragCandidate(event, card) {
  if (event.button !== 0 || state.collection === "trash" || event.target.closest(".quick-view-trigger")) return;
  if (manualDragSession || state.nativeDragActive) return;
  const id = card.dataset.id;
  const ids = state.selectedIds.has(id) ? selectedAssetIds() : [id];
  manualDragSession = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    card,
    id,
    ids,
    dragging: false,
    nativeArmed: false,
  };
  const nativeFiles = ids.map((assetId) => state.externalDragFiles.get(assetId)).filter(Boolean);
  if (nativeFiles.length === ids.length) {
    manualDragSession.nativeArmed = startNativeFileDrag(ids, nativeFiles, card, false, {
      x: event.clientX,
      y: event.clientY,
    });
  } else {
    prepareExternalDragFiles(ids);
  }
  try {
    card.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is an enhancement; window listeners still complete the drag.
  }
}

function armNativeDrag(session) {
  if (session.nativeArmed) return true;
  const nativeFiles = session.ids.map((id) => state.externalDragFiles.get(id)).filter(Boolean);
  if (nativeFiles.length !== session.ids.length) {
    prepareExternalDragFiles(session.ids);
    return false;
  }
  const started = startNativeFileDrag(session.ids, nativeFiles, session.card, true, {
    x: session.startX,
    y: session.startY,
  });
  if (!started) return false;
  session.nativeArmed = true;
  return true;
}

function cancelArmedNativeDrag(session) {
  if (!session?.nativeArmed || !invoke) return;
  const armPromise = state.nativeDragArmPromise;
  Promise.resolve(armPromise).catch(() => {}).then(() => {
    invoke("plugin:drag-and-drop-wayland|cancel_drag").catch(() => {
      // A drag that already crossed the window edge is owned by the compositor.
    });
  });
}

function updateManualDrag(event) {
  const session = manualDragSession;
  if (!session || session.pointerId !== event.pointerId) return;
  session.clientX = event.clientX;
  session.clientY = event.clientY;
  if (!session.dragging) {
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (distance < MANUAL_DRAG_DISTANCE) return;
    if (!state.selectedIds.has(session.id)) setSingleSelection(session.id);
    session.ids = state.selectedIds.has(session.id) ? selectedAssetIds() : [session.id];
    session.dragging = true;
    beginDragUi(session.card);
  }
  event.preventDefault();
  hideQuickPreview();
  showManualDragGhost(session.ids.length, event.clientX, event.clientY);
  updateSidebarDropTargetAt(event.clientX, event.clientY);
  armNativeDrag(session);
}

function cancelManualDrag(event) {
  const session = manualDragSession;
  if (!session || (event?.pointerId != null && session.pointerId !== event.pointerId)) return;
  releaseManualPointer(session);
  manualDragSession = null;
  cancelArmedNativeDrag(session);
  if (session.dragging) {
    suppressAssetClickUntil = Date.now() + 350;
    finishDragUi();
  }
}

function finishManualDrag(event) {
  const session = manualDragSession;
  if (!session || session.pointerId !== event.pointerId) return;
  releaseManualPointer(session);
  manualDragSession = null;
  if (!session.dragging) {
    if (session.nativeArmed) {
      cancelArmedNativeDrag(session);
      finishDragUi();
    }
    return;
  }
  suppressAssetClickUntil = Date.now() + 350;
  const target = updateSidebarDropTargetAt(event.clientX, event.clientY);
  const folderId = target?.dataset.folderId;
  const moveToTrash = target?.dataset.collection === "trash";
  const ids = [...session.ids];
  cancelArmedNativeDrag(session);
  finishDragUi();
  if (folderId) addToFolder(folderId, ids);
  else if (moveToTrash) moveSelectionToTrash(ids);
}

window.addEventListener("pointermove", updateManualDrag, true);
window.addEventListener("pointerup", finishManualDrag, true);
window.addEventListener("pointercancel", cancelManualDrag, true);

function dragBadgeBase64(count) {
  const canvas = document.createElement("canvas");
  canvas.width = 76;
  canvas.height = 52;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(24, 26, 30, .96)";
  context.beginPath();
  context.roundRect(0.5, 0.5, 75, 51, 11);
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, .24)";
  context.stroke();
  context.fillStyle = "#f06438";
  context.beginPath();
  context.roundRect(7, 8, 36, 36, 7);
  context.fill();
  context.strokeStyle = "#fff";
  context.lineWidth = 2;
  context.strokeRect(17, 17, 16, 16);
  context.fillStyle = "#fff";
  context.font = "700 17px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(count), 59, 27);
  return canvas.toDataURL("image/png").split(",")[1];
}

function startNativeFileDrag(ids, nativeFiles, card, showUi = true, startPosition = null) {
  const Channel = tauri?.core?.Channel;
  if (!invoke || !Channel || !nativeFiles.length) return false;
  const onEvent = new Channel();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishDragUi();
  };
  onEvent.onmessage = (payload) => {
    if (payload?.result === "Started") {
      state.nativeDragActive = true;
      state.nativeDragStarted = true;
      state.nativeDragIds = [...ids];
      state.recentNativeDragIds = [...ids];
      state.internalDrag = true;
      state.internalDragGuardUntil = Number.POSITIVE_INFINITY;
      if (manualDragSession) {
        releaseManualPointer(manualDragSession);
        manualDragSession = null;
      }
      document.querySelector(".drag-ghost.manual")?.remove();
      gallery.querySelectorAll(".dragging").forEach((item) => item.classList.remove("dragging"));
      document.body.classList.remove("phoenix-dragging");
      clearSidebarDropTarget();
      return;
    }
    finish();
  };
  state.nativeDragActive = true;
  state.nativeDragStarted = false;
  state.nativeDragIds = [...ids];
  state.internalDrag = true;
  state.internalDragGuardUntil = Number.POSITIVE_INFINITY;
  if (showUi) beginDragUi(card);
  state.nativeDragWatchdog = setTimeout(finish, 35000);
  state.nativeDragArmPromise = invoke("plugin:drag-and-drop-wayland|start_drag", {
    item: nativeFiles.map((file) => file.path),
    image: dragBadgeBase64(ids.length),
    options: {
      mode: "copy",
      startX: startPosition?.x,
      startY: startPosition?.y,
    },
    onEvent,
  }).catch((error) => {
    finish();
    toast("Could not start file drag", String(error), true);
  });
  return true;
}

function internalDragActive(dataTransfer) {
  return state.internalDrag || Date.now() < state.internalDragGuardUntil || isPhoenixDrag(dataTransfer);
}

function preparedDragIdsForPaths(paths) {
  const droppedPaths = new Set((paths || []).filter(Boolean));
  if (!droppedPaths.size) return [];
  const candidates = [...new Set([...state.nativeDragIds, ...state.recentNativeDragIds])];
  return candidates.filter((id) => {
    const dragFile = state.externalDragFiles.get(id);
    return dragFile?.path && droppedPaths.has(dragFile.path);
  });
}

function dataTransferPaths(dataTransfer) {
  return [...(dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
}

function hasImportPayload(dataTransfer) {
  const types = [...(dataTransfer?.types || [])];
  if (isPhoenixDrag(dataTransfer)) return false;
  if (types.includes("Files")) return preparedDragIdsForPaths(dataTransferPaths(dataTransfer)).length === 0;
  if (internalDragActive(dataTransfer)) return false;
  return types.some((type) => ["Files", "text/uri-list", "text/x-moz-url", "text/plain"].includes(type));
}

function droppedUrl(dataTransfer) {
  for (const type of ["text/uri-list", "text/x-moz-url", "text/plain"]) {
    const value = dataTransfer?.getData(type) || "";
    const candidate = value.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line));
    if (candidate) return candidate;
  }
  return "";
}

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!hasImportPayload(event.dataTransfer)) return;
  event.preventDefault();
  dragDepth += 1;
  $("#drop-overlay").classList.add("visible");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("#drop-overlay").classList.remove("visible");
});
window.addEventListener("dragover", (event) => {
  if (isPhoenixDrag(event.dataTransfer) || preparedDragIdsForPaths(dataTransferPaths(event.dataTransfer)).length) {
    event.preventDefault();
    updateSidebarDropTarget(event);
    return;
  }
  if (hasImportPayload(event.dataTransfer)) event.preventDefault();
});
window.addEventListener("drop", async (event) => {
  const paths = dataTransferPaths(event.dataTransfer);
  if (isPhoenixDrag(event.dataTransfer) || preparedDragIdsForPaths(paths).length) {
    event.preventDefault();
    event.stopPropagation();
    clearSidebarDropTarget();
    dragDepth = 0;
    $("#drop-overlay").classList.remove("visible");
    return;
  }
  if (!hasImportPayload(event.dataTransfer)) return;
  event.preventDefault();
  if (state.internalDrag || state.nativeDragActive) finishDragUi();
  dragDepth = 0;
  $("#drop-overlay").classList.remove("visible");
  if (paths.length) {
    for (const path of paths) await importDroppedValue(path);
    return;
  }
  const url = droppedUrl(event.dataTransfer);
  if (url) await importUrl(url);
});

if (tauri?.event?.listen) {
  const nativeIdsForDrop = (payload = null, allowActiveFallback = false) => {
    const matched = preparedDragIdsForPaths(payload?.paths || []);
    if (matched.length) return matched;
    if (allowActiveFallback && state.nativeDragStarted && state.nativeDragIds.length) return [...state.nativeDragIds];
    return [];
  };
  const updateNativeDropTarget = (payload, allowActiveFallback = true) => {
    if (!nativeIdsForDrop(payload, allowActiveFallback).length) return null;
    const x = Number(payload?.position?.x || 0);
    const y = Number(payload?.position?.y || 0);
    const target = findSidebarDropTargetAt(x, y);
    setSidebarDropTarget(target);
    return target;
  };

  tauri.event.listen("tauri://drag-enter", ({ payload }) => {
    if (nativeIdsForDrop(payload, state.nativeDragStarted).length) updateNativeDropTarget(payload, state.nativeDragStarted);
    else {
      if (state.internalDrag || state.nativeDragActive) finishDragUi();
      $("#drop-overlay").classList.add("visible");
    }
  });
  tauri.event.listen("tauri://drag-over", ({ payload }) => {
    updateNativeDropTarget(payload);
  });
  tauri.event.listen("tauri://drag-leave", () => {
    $("#drop-overlay").classList.remove("visible");
    clearSidebarDropTarget();
  });
  tauri.event.listen("tauri://drag-drop", async ({ payload }) => {
    $("#drop-overlay").classList.remove("visible");
    const nativeIds = nativeIdsForDrop(payload, state.nativeDragStarted);
    if (nativeIds.length) {
      const target = updateNativeDropTarget(payload, state.nativeDragStarted);
      const folderId = target?.dataset.folderId;
      const moveToTrash = target?.dataset.collection === "trash";
      clearSidebarDropTarget();
      if (folderId) await addToFolder(folderId, nativeIds);
      else if (moveToTrash) await moveSelectionToTrash(nativeIds);
      return;
    }
    if (state.internalDrag || state.nativeDragActive) finishDragUi();
    for (const path of payload?.paths || []) await importDroppedValue(path);
  });
}

async function initializeApplication() {
  applicationInitialized = false;
  $("#startup-retry").hidden = true;
  startupScreen.classList.remove("ready");
  try {
    updateStartupProgress(18, "Applying your preferences…");
    applyPreferences();
    setTileSnap(state.tileSnapIndex);
    updateViewModeButton();
    updateStartupProgress(34, "Connecting to the local library…");
    const bootstrap = await command("get_bootstrap");
    updateStartupProgress(72, "Loading folders and library items…");
    applyBootstrap(bootstrap);
    updateStartupProgress(92, "Preparing the workspace…");
    await waitForRenderedFrame();
    applicationInitialized = true;
    finishFirstLaunch();
  } catch (error) {
    welcome.hidden = false;
    toast("Library unavailable", String(error), true);
    if (firstLaunchPending) {
      startupScreen.hidden = false;
      $("#startup-message").textContent = `Phoenix could not finish starting: ${String(error)}`;
      $("#startup-progress-label").textContent = "Needs attention";
      $("#startup-retry").hidden = false;
    }
  }
}

$("#startup-retry").addEventListener("click", () => {
  updateStartupProgress(10, "Trying the local library again…");
  initializeApplication();
});

initializeApplication();

window.setInterval(refreshLibrarySilently, 1800);
window.setInterval(refreshDownloadProgress, 300);
