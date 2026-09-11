import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Firefox extension has capture permissions and a stable local id", async () => {
  const manifest = JSON.parse(await text("extension/manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.id, "capture@phoenix-project.local");
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:41673/*"));
  assert.ok(manifest.content_scripts[0].matches.includes("https://*/*"));
});

test("browser and native sides agree on the capture contract", async () => {
  const background = await text("extension/background.js");
  const model = await text("src-tauri/src/model.rs");
  for (const field of ["token", "url", "dataBase64", "name", "website", "annotation", "tags", "mediaType", "extension"]) {
    assert.match(background, new RegExp(`\\b${field}\\b`));
  }
  assert.match(model, /rename_all = "camelCase"/);
  assert.match(model, /struct CaptureRequest/);
});

test("empty library, Firefox video capture, and download progress are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const background = await text("extension/background.js");
  const content = await text("extension/content.js");
  const manifest = JSON.parse(await text("extension/manifest.json"));
  const native = await text("src-tauri/src/lib.rs");
  const server = await text("src-tauri/src/server.rs");
  const library = await text("src-tauri/src/library.rs");
  assert.match(frontend, /libraryIsCompletelyEmpty[\s\S]*\? "" :/);
  assert.match(frontend, /welcome\.hidden = !libraryIsCompletelyEmpty/);
  assert.match(background, /contexts: \["image", "video"\]/);
  assert.match(background, /mediaType: info\.mediaType === "video"/);
  assert.match(content, /target\.closest\("img, video"\)/);
  assert.match(content, /video\.draggable = true/);
  assert.equal(manifest.version, "0.1.1");
  assert.match(markup, /id="download-progress-stack"/);
  assert.match(styles, /\.download-progress-track/);
  assert.match(frontend, /get_download_progress/);
  assert.match(frontend, /window\.setInterval\(refreshDownloadProgress, 300\)/);
  assert.match(native, /fn get_download_progress/);
  assert.match(server, /\/api\/v1\/downloads/);
  assert.match(library, /response\.chunk\(\)\.await/);
  assert.match(library, /ingest_video_staging/);
  assert.match(library, /"downloading"/);
  assert.match(library, /"processing"/);
  assert.match(library, /"complete"/);
});

test("desktop bootstrap prebuilds stable outbound drag files", async () => {
  const model = await text("src-tauri/src/model.rs");
  const library = await text("src-tauri/src/library.rs");
  const frontend = await text("frontend/app.js");
  assert.match(model, /pub external_drag_files: Vec<ExternalDragFile>/);
  assert.match(library, /let external_drag_files = self\.external_drag_files\(&asset_ids\)/);
  assert.match(frontend, /bootstrap\.externalDragFiles/);
});

test("local API is bound to loopback and mutating capture requires a token", async () => {
  const server = await text("src-tauri/src/server.rs");
  const library = await text("src-tauri/src/library.rs");
  assert.match(server, /127\.0\.0\.1:41673/);
  assert.match(library, /capture\.token != self\.token/);
});

test("desktop interactions cover viewing, multi-select, folders, export, URL import, and Trash", async () => {
  const frontend = await text("frontend/app.js");
  const styles = await text("frontend/styles.css");
  const markup = await text("frontend/index.html");
  const native = await text("src-tauri/src/lib.rs");
  assert.match(frontend, /card\.addEventListener\("dblclick"/);
  assert.match(frontend, /draggable="false"/);
  assert.match(frontend, /application\/x-phoenix-assets/);
  assert.match(frontend, /selectedIds: new Set/);
  assert.match(frontend, /move_assets_to_trash/);
  assert.match(frontend, /delete_assets_permanently/);
  assert.match(frontend, /empty_trash/);
  assert.match(frontend, /add_assets_to_folder/);
  assert.match(frontend, /remove_assets_from_folder/);
  assert.match(frontend, /trashDropTarget\.addEventListener\("drop"/);
  assert.match(frontend, /get_external_drag_files/);
  assert.match(frontend, /plugin:drag-and-drop-wayland\|start_drag/);
  assert.match(frontend, /function startNativeFileDrag/);
  assert.match(frontend, /function dragBadgeBase64/);
  assert.doesNotMatch(frontend, /setData\("DownloadURL"/);
  assert.doesNotMatch(frontend, /setData\("application\/x-moz-url"/);
  assert.match(frontend, /document\.body\.classList\.add\("phoenix-dragging"\)/);
  assert.match(frontend, /function updateSidebarDropTarget/);
  assert.match(frontend, /choose_directory/);
  assert.match(frontend, /command\("import_url"/);
  assert.match(native, /async fn import_url/);
  assert.match(native, /fn open_asset_window/);
  assert.match(native, /fn export_assets/);
  assert.match(native, /fn delete_assets_permanently/);
  assert.match(native, /fn empty_trash/);
  assert.match(native, /tauri_plugin_drag_and_drop_wayland::init/);
  assert.match(native, /restore_wayland_backend_for_appimage/);
  assert.match(native, /GST_PLUGIN_SYSTEM_PATH_1_0/);
  assert.match(native, /GST_PLUGIN_SCANNER_1_0/);
  assert.match(native, /\/usr\/lib\/\{multiarch\}\/gstreamer-1\.0/);
  assert.match(native, /set_var\("GDK_BACKEND", "wayland"\)/);
  assert.match(markup, /<section class="image-viewer" id="image-viewer" hidden/);
  assert.match(markup, /id="viewer-position"/);
  assert.match(markup, /id="empty-trash"/);
  assert.match(markup, /id="trash-context-menu"/);
  assert.match(markup, /data-action="delete-permanently"/);
  assert.doesNotMatch(markup, /id="import-suggested"/);
  assert.doesNotMatch(markup, /id="choose-path"/);
  assert.doesNotMatch(markup, /id="suggested-path"/);
  assert.doesNotMatch(frontend, /import-suggested|suggested-path|function importPath/);
  assert.match(styles, /\.toolbar-button\[hidden\]\s*\{\s*display:\s*none/);
  assert.doesNotMatch(markup, /<dialog class="image-viewer"/);
  assert.match(styles, /\.gallery-wrap[^}]*overflow-y: auto/);
  assert.match(styles, /aspect-ratio: var\(--asset-ratio/);
  assert.match(styles, /\.viewer-stage img[^}]*object-fit: contain/);
});

test("desktop navigation, collapsible panels, tags, and viewer gestures are wired", async () => {
  const frontend = await text("frontend/app.js");
  const styles = await text("frontend/styles.css");
  const markup = await text("frontend/index.html");
  assert.match(markup, /id="sidebar-toggle"/);
  assert.match(markup, /id="inspector-toggle"/);
  assert.match(markup, /id="history-back"/);
  assert.match(markup, /id="tag-add"/);
  assert.match(markup, /id="tag-create" hidden/);
  assert.doesNotMatch(markup, /<button aria-label="Close">/);
  assert.match(markup, /type="button" data-close-dialog aria-label="Close"/);
  assert.match(frontend, /viewer-stage"\)\.addEventListener\("wheel"/);
  assert.match(frontend, /viewer-stage"\)\.addEventListener\("pointermove"/);
  assert.match(frontend, /function navigateHistory/);
  assert.match(frontend, /event\.button !== 3 && event\.button !== 4/);
  assert.match(frontend, /if \(!\$\("#image-viewer"\)\.hidden\) navigateViewer\(state\.preferences\.reverseMouseViewerNavigation \? 1 : -1\)/);
  assert.match(frontend, /if \(!\$\("#image-viewer"\)\.hidden\) navigateViewer\(state\.preferences\.reverseMouseViewerNavigation \? -1 : 1\)/);
  assert.match(frontend, /Already at the first item/);
  assert.match(frontend, /Already at the last item/);
  assert.match(markup, /data-collection="unfiled"/);
  assert.match(frontend, /state\.collection === "unfiled"/);
  assert.match(frontend, /asset\.folderIds\?\.length/);
  assert.match(markup, /phoenix-icon\.png/);
  assert.match(frontend, /querySelector\('\[data-action="view"\]'\)\.hidden = isMultiSelection/);
  assert.match(frontend, /data-close-dialog/);
  assert.match(styles, /\.app-shell\.sidebar-collapsed/);
  assert.match(styles, /\.content-area\.inspector-collapsed/);
  assert.match(styles, /body\.phoenix-dragging \.nav-item\[data-folder-id\]/);
  assert.match(styles, /\.toolbar-button\[hidden\]/);
});

test("responsive grid snaps, list view, and safe folder deletion are wired", async () => {
  const frontend = await text("frontend/app.js");
  const styles = await text("frontend/styles.css");
  const markup = await text("frontend/index.html");
  const native = await text("src-tauri/src/lib.rs");
  const library = await text("src-tauri/src/library.rs");
  assert.match(markup, /id="tile-smaller"/);
  assert.match(markup, /id="tile-larger"/);
  assert.doesNotMatch(markup, /id="tile-size" type="range"/);
  assert.match(markup, /id="view-mode"/);
  assert.match(markup, /id="folder-context-menu"/);
  assert.match(markup, /id="delete-folder-dialog"/);
  assert.match(frontend, /const TILE_SNAPS = \[/);
  assert.match(frontend, /function layoutGallery/);
  assert.match(frontend, /event\.ctrlKey/);
  assert.match(frontend, /state\.viewMode === "grid" \? "list" : "grid"/);
  assert.match(frontend, /command\("delete_folder"/);
  assert.match(styles, /\.gallery\.list-mode/);
  assert.match(native, /fn delete_folder/);
  assert.match(library, /pub fn delete_folder/);
  assert.match(library, /UPDATE assets SET is_deleted = 1/);
});

test("asset dates, extension details, expanded zoom, and four-way sorting are available", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  assert.match(markup, /id="asset-created"/);
  assert.match(markup, /id="asset-extension"/);
  assert.match(markup, /value="newest"/);
  assert.match(markup, /value="oldest"/);
  assert.match(markup, /value="name-asc"/);
  assert.match(markup, /value="name-desc"/);
  assert.match(markup, /value="size-desc"/);
  assert.match(markup, /value="size-asc"/);
  assert.match(frontend, /function formatDate/);
  assert.match(frontend, /Math\.min\(8, Math\.max\(0\.25/);
  assert.match(frontend, /const TILE_SNAPS = \[80, 110, 150, 205, 270, 350, 440\]/);
});

test("real file dates, extension conversion, keyboard navigation, and marquee selection are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const model = await text("src-tauri/src/model.rs");
  const library = await text("src-tauri/src/library.rs");
  assert.match(markup, /id="asset-imported"/);
  assert.match(markup, /id="asset-created"/);
  assert.match(markup, /id="asset-modified"/);
  assert.match(markup, /id="selection-marquee"/);
  assert.match(frontend, /function filenamePatch/);
  assert.match(frontend, /function moveGallerySelection/);
  assert.match(frontend, /function marqueeRect/);
  assert.match(styles, /\.selection-marquee/);
  assert.match(model, /pub modified_at: i64/);
  assert.match(model, /pub extension: Option<String>/);
  assert.match(library, /fn embedded_creation_time/);
  assert.match(library, /fn convert_asset_extension/);
});

test("manual fallback, unified native Wayland drops, and interactive image cropping are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const native = await text("src-tauri/src/lib.rs");
  const library = await text("src-tauri/src/library.rs");
  assert.match(frontend, /let manualDragSession = null/);
  assert.match(frontend, /function updateManualDrag/);
  assert.match(frontend, /function armNativeDrag/);
  assert.match(frontend, /plugin:drag-and-drop-wayland\|cancel_drag/);
  assert.match(frontend, /startManualDragCandidate[\s\S]*startNativeFileDrag/);
  assert.match(frontend, /payload\?\.result === "Started"/);
  assert.match(frontend, /tauri:\/\/drag-over/);
  assert.match(frontend, /const updateNativeDropTarget/);
  assert.doesNotMatch(frontend, /NATIVE_HANDOFF_EDGE/);
  assert.match(frontend, /updateSidebarDropTargetAt/);
  assert.doesNotMatch(frontend, /phoenix-native-drag/);
  assert.match(markup, /id="viewer-crop"/);
  assert.match(markup, /data-action="crop"/);
  assert.match(markup, /data-action="remove-folder"/);
  assert.match(markup, /id="crop-dialog"/);
  assert.match(frontend, /function openCropDialog/);
  assert.match(frontend, /command\("crop_asset"/);
  assert.match(styles, /\.crop-selection/);
  assert.match(native, /fn crop_asset/);
  assert.doesNotMatch(native, /phoenix-native-drag/);
  assert.match(library, /pub fn crop_asset/);
  assert.match(library, /'asset\.crop'/);
  assert.match(library, /'folder\.remove'/);
  assert.match(frontend, /command\("remove_assets_from_folder"/);
});

test("external imports, editable text assets, viewer deletion, and ComfyUI metadata are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const model = await text("src-tauri/src/model.rs");
  const library = await text("src-tauri/src/library.rs");
  const native = await text("src-tauri/src/lib.rs");
  assert.match(frontend, /function importLocalPath/);
  assert.match(frontend, /preparedDragIdsForPaths/);
  assert.match(frontend, /dataTransferPaths/);
  assert.match(frontend, /function deleteViewerItem/);
  assert.match(frontend, /command\("create_text_asset"/);
  assert.match(frontend, /command\("read_text_asset"/);
  assert.match(frontend, /command\("update_text_asset"/);
  assert.match(frontend, /function renderComfyUi/);
  assert.match(markup, /id="viewer-text-editor"/);
  assert.match(markup, /id="viewer-trash"/);
  assert.match(markup, /id="text-file-dialog"/);
  assert.match(markup, /data-gallery-action="new-text"/);
  assert.match(markup, /id="comfyui-section"/);
  assert.match(markup, /Embedded in this file/);
  assert.match(markup, /data-action="external-app"/);
  assert.match(styles, /\.viewer-text-editor/);
  assert.match(styles, /\.comfyui-prompt/);
  assert.match(model, /pub comfyui: Option<ComfyUiMetadata>/);
  assert.match(library, /fn extract_comfyui_metadata/);
  assert.match(library, /fn extract_comfyui_video_metadata/);
  assert.match(library, /Command::new\("ffprobe"\)/);
  assert.match(library, /uncompressed_latin1_text/);
  assert.match(library, /compressed_latin1_text/);
  assert.match(library, /utf8_text/);
  assert.match(library, /pub fn create_text_asset/);
  assert.match(library, /pub fn read_text_asset/);
  assert.match(library, /pub fn update_text_asset/);
  assert.match(native, /fn create_text_asset/);
  assert.match(native, /fn read_text_asset/);
  assert.match(native, /fn update_text_asset/);
  assert.match(native, /fn open_asset_externally/);
  assert.match(frontend, /function openAssetExternally/);
});

test("video download progress cards update in place without restarting their animation", async () => {
  const frontend = await text("frontend/app.js");
  const styles = await text("frontend/styles.css");
  assert.match(frontend, /dataset\.downloadId = id/);
  assert.match(frontend, /element\.querySelector\("small"\)\.textContent/);
  assert.doesNotMatch(frontend, /container\.innerHTML = downloads\.map/);
  assert.match(styles, /\.download-progress\.entering, \.download-progress\.leaving/);
});

test("video thumbnail frames recover after the viewer closes and toolbar sorting is polished", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  assert.match(frontend, /function suspendVideoThumbnails/);
  assert.match(frontend, /function restoreVideoThumbnailFrames/);
  assert.match(frontend, /requestAnimationFrame\(restoreVideoThumbnailFrames\)/);
  assert.match(frontend, /video\.addEventListener\("loadeddata"/);
  assert.doesNotMatch(markup, /<circle cx="84" cy="67" r="2"/);
  assert.match(markup, /<optgroup label="Date">/);
  assert.match(markup, /<optgroup label="File size">/);
  assert.match(styles, /\.sort-control::after/);
  assert.match(styles, /appearance:\s*none/);
});

test("viewer reclaims toolbar space, advances after Trash, and uses a compact inspector toggle", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  assert.match(markup, /class="icon-button inspector-toggle" id="inspector-toggle"/);
  assert.doesNotMatch(markup, /id="inspector-toggle"[^>]*>[^<]*Inspector/);
  assert.match(styles, /\.workspace\.viewer-active\s*\{[^}]*grid-template-rows:\s*0/);
  assert.match(styles, /\.workspace\.viewer-active \.toolbar/);
  assert.match(frontend, /classList\.add\("viewer-active"\)/);
  assert.match(frontend, /classList\.remove\("viewer-active"\)/);
  assert.match(frontend, /const adjacentId = visible\[index \+ 1\]\?\.id \|\| visible\[index - 1\]\?\.id/);
  assert.match(frontend, /await openViewer\(adjacentId\)/);
  assert.match(frontend, /button\.textContent = collapsed \? "‹" : "›"/);
});

test("inspector edge control, ComfyUI prompt copying, and exclusive TXT viewing are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const viewerIndex = markup.indexOf('id="image-viewer"');
  const toggleIndex = markup.indexOf('id="inspector-toggle"');
  const inspectorIndex = markup.indexOf('id="inspector"');
  assert.ok(viewerIndex >= 0 && toggleIndex > viewerIndex && inspectorIndex > toggleIndex);
  assert.match(styles, /\.content-area \.inspector-toggle\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.content-area\.inspector-collapsed \.inspector-toggle/);
  assert.match(styles, /\.viewer-stage img\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(styles, /\.preview-frame img\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(frontend, /data-copy-prompt="\$\{className\}"/);
  assert.match(frontend, /async function copyComfyPrompt/);
  assert.match(frontend, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(frontend, /#comfyui-data"\)\.addEventListener\("click"/);
  assert.match(styles, /\.comfyui-prompt\.positive \.comfyui-copy/);
  assert.match(styles, /\.comfyui-prompt\.negative \.comfyui-copy/);
});

test("GIF hover, paired text split view, and Wayland sidebar drop hit-testing are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  assert.match(frontend, /function isGifAsset/);
  assert.match(frontend, /function wireGifPlayback/);
  assert.match(frontend, /pointerenter[\s\S]*thumbnailUrl\(asset\.id, true\)/);
  assert.match(frontend, /pointerleave[\s\S]*thumbnailUrl\(asset\.id\)/);
  assert.match(markup, /id="viewer-split"/);
  assert.match(frontend, /function matchingImageForText/);
  assert.match(frontend, /function toggleViewerTextSplit/);
  assert.match(styles, /\.viewer-stage\.text-split/);
  assert.match(styles, /grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.inspector-content\s*\{[^}]*padding:\s*48px 14px 14px/);
  assert.match(frontend, /const target = findSidebarDropTargetAt\(x, y\)/);
  assert.doesNotMatch(frontend, /findSidebarDropTargetAt\(x \/ scale, y \/ scale\)/);
  assert.match(frontend, /allowActiveFallback && state\.nativeDragStarted/);
  assert.match(frontend, /nativeIdsForDrop\(payload, state\.nativeDragStarted\)/);
});

test("source links open externally and viewer entry synchronizes the inspector", async () => {
  const frontend = await text("frontend/app.js");
  const native = await text("src-tauri/src/lib.rs");
  assert.match(frontend, /#asset-source"\)\.addEventListener\("click"/);
  assert.match(frontend, /invoke\("open_external_url", \{ url: source \}\)/);
  assert.match(frontend, /async function openViewer[\s\S]*setSingleSelection\(id\)/);
  assert.match(frontend, /if \(state\.viewerId && assetById\(state\.viewerId\)\)[\s\S]*state\.selectedIds = new Set\(\[state\.viewerId\]\)/);
  assert.match(native, /async fn open_external_url/);
  assert.match(native, /matches!\(parsed\.scheme\(\), "http" \| "https"\)/);
  assert.match(native, /Command::new\("xdg-open"\)/);
  assert.match(native, /open_external_url,[\s\S]*open_asset_window/);
});

test("filename substring search and persistent folder colors are supported", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const model = await text("src-tauri/src/model.rs");
  const library = await text("src-tauri/src/library.rs");
  const native = await text("src-tauri/src/lib.rs");
  assert.match(library, /instr\(lower\(a\.name \|\| '\.' \|\| a\.extension\), lower\(\?2\)\) > 0/);
  assert.match(library, /list_assets\(Some\("192"\)\)/);
  assert.match(library, /list_assets\(Some\("api"\)\)/);
  assert.match(model, /pub color: String/);
  assert.match(library, /ALTER TABLE folders ADD COLUMN color/);
  assert.match(library, /pub fn update_folder_color/);
  assert.match(native, /fn update_folder_color/);
  assert.match(frontend, /command\("update_folder_color"/);
  assert.match(frontend, /--folder-color:\$\{safeFolderColor\(folder\.color\)\}/);
  assert.match(markup, /class="folder-color-palette"/);
  assert.match(styles, /\.folder-color-palette/);
});

test("search defaults to filenames with an all-fields toggle and split media is bounded", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const library = await text("src-tauri/src/library.rs");
  const native = await text("src-tauri/src/lib.rs");
  assert.match(frontend, /wideSearch: false/);
  assert.match(markup, /id="search-scope"[^>]*>Name</);
  assert.match(frontend, /wide: state\.wideSearch/);
  assert.match(frontend, /state\.wideSearch \? "All" : "Name"/);
  assert.match(native, /wide: Option<bool>/);
  assert.match(library, /pub fn search_assets\(&self, query: &str, wide: bool\)/);
  assert.match(library, /let search_condition = if wide/);
  assert.match(library, /list_assets\(Some\("round trip"\)\)[\s\S]*is_empty/);
  assert.match(markup, /class="viewer-media-pane" id="viewer-media-pane"/);
  assert.match(styles, /\.viewer-stage\.text-split \.viewer-media-pane\s*\{[^}]*min-height:\s*0/);
  assert.match(styles, /\.viewer-stage\.text-split img\s*\{[^}]*object-fit:\s*contain/);
});

test("video files use the shared library, drag, inspector, and viewer pipeline", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const windowMarkup = await text("frontend/viewer-window.html");
  const windowScript = await text("frontend/viewer-window.js");
  const library = await text("src-tauri/src/library.rs");
  const server = await text("src-tauri/src/server.rs");
  const preview = await text("tools/preview-server.mjs");
  const config = await text("src-tauri/tauri.conf.json");
  for (const extension of ["mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi"]) {
    assert.match(library, new RegExp(`"${extension}"`));
  }
  assert.match(library, /fn ingest_video_bytes/);
  assert.match(library, /fn validate_video_bytes/);
  assert.match(server, /header::RANGE/);
  assert.match(server, /StatusCode::PARTIAL_CONTENT/);
  assert.match(server, /header::ACCEPT_RANGES/);
  assert.match(server, /ReaderStream/);
  assert.match(server, /allow_headers\([^)]*header::RANGE/);
  assert.match(config, /media-src 'self' blob: http:\/\/127\.0\.0\.1:41673/);
  assert.match(frontend, /function isVideoAsset/);
  assert.match(frontend, /function wireVideoPlayback/);
  assert.match(frontend, /<video data-id=/);
  assert.match(markup, /id="viewer-video"[^>]*controls/);
  assert.match(markup, /id="inspector-video"[^>]*controls/);
  assert.match(styles, /\.viewer-stage video[^}]*object-fit: contain/);
  assert.match(windowMarkup, /id="video"[^>]*controls/);
  assert.match(windowScript, /video\.src = source/);
  assert.match(preview, /"Content-Range"/);
  assert.match(preview, /video\/mp4/);
});

test("folder export and debounced inspector autosave are wired", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  assert.match(markup, /data-folder-action="export"[^>]*>Export all items/);
  assert.match(frontend, /async function exportFolder/);
  assert.match(frontend, /asset\.folderIds\?\.includes\(folderId\)/);
  assert.match(frontend, /exportAssetIds\(assetIds, `“\$\{folder\.name\}”`\)/);
  assert.match(markup, /id="autosave-status"/);
  assert.doesNotMatch(markup, /id="save-metadata"/);
  assert.match(frontend, /function scheduleMetadataAutosave/);
  assert.match(frontend, /metadataSaveChain/);
  assert.match(frontend, /#asset-name"\)\.addEventListener\("input"/);
  assert.match(frontend, /#asset-notes"\)\.addEventListener\("input"/);
  assert.match(frontend, /scheduleMetadataAutosave\(0\)/);
  assert.match(styles, /\.autosave-status/);
});

test("logo settings persist theme, hover playback, viewer playback, and navigation preferences", async () => {
  const frontend = await text("frontend/app.js");
  const markup = await text("frontend/index.html");
  const styles = await text("frontend/styles.css");
  const windowScript = await text("frontend/viewer-window.js");
  const themeEffects = await text("frontend/theme-effects.js");
  assert.match(markup, /id="open-settings"[^>]*Open Phoenix settings/);
  assert.match(markup, /id="settings-page"[^>]*hidden/);
  for (const id of ["setting-theme", "setting-gif-hover", "setting-video-hover", "setting-video-autoplay", "setting-video-loop-short", "setting-mouse-direction", "setting-arrow-direction", "setting-show-unfiled", "setting-show-untagged", "setting-show-recent"]) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  assert.match(frontend, /gifHoverPlayback: true/);
  assert.match(frontend, /videoHoverPreview: true/);
  assert.match(frontend, /videoAutoplayViewer: true/);
  assert.match(frontend, /loopShortVideos: true/);
  assert.match(frontend, /showUnfiledSection: true/);
  assert.match(frontend, /showUntaggedSection: true/);
  assert.match(frontend, /showRecentSection: true/);
  assert.match(frontend, /theme: "retrowave-embers"/);
  assert.match(markup, /value="retrowave-embers" selected/);
  assert.match(frontend, /localStorage\.setItem\(PREFERENCES_KEY/);
  assert.match(frontend, /activateCollection\("settings", "Settings"\)/);
  assert.match(frontend, /preferences\.loopShortVideos[\s\S]*viewerVideo\.duration < 30/);
  assert.match(frontend, /preferences\.videoAutoplayViewer[\s\S]*viewerVideo\.play/);
  assert.match(frontend, /reverseArrowViewerNavigation \? 1 : -1/);
  assert.match(frontend, /reverseMouseViewerNavigation \? 1 : -1/);
  assert.match(windowScript, /localStorage\.getItem\("phoenix\.preferences\.v1"\)/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /\.settings-page/);
  assert.match(styles, /\.settings-switch:checked/);
  for (const theme of ["cyberpunk-synapse", "retrowave-embers", "midnight-rain", "ocean-constellations", "terminal-flow", "ume-petals", "cute-sparkles"]) {
    assert.match(markup, new RegExp(`value="${theme}"`));
    assert.match(themeEffects, new RegExp(`"${theme}"`));
  }
  for (const effect of ["synapse", "embers", "rain", "constellations", "flow", "petals", "sparkles"]) {
    assert.match(themeEffects, new RegExp(`effect: "${effect}"`));
  }
  assert.match(themeEffects, /prefers-reduced-motion: reduce/);
  assert.match(themeEffects, /requestAnimationFrame\(animate\)/);
  assert.match(frontend, /applyAnimatedTheme\(preferences\.theme\)/);
  assert.match(styles, /\.animated-theme-canvas/);
  assert.match(styles, /\.nav-item\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(markup, />Not in folders</);
  assert.doesNotMatch(markup, />Not in a folder</);
  assert.doesNotMatch(frontend, /muted loop playsinline preload="metadata"/);
  assert.match(frontend, /function wireVideoPlayback[\s\S]*restartPreview[\s\S]*video\.load\(\)/);
  assert.match(themeEffects, /tailLength = 10 \+ particle\.speed \* 8/);
  assert.match(markup, /id="startup-screen"[^>]*hidden/);
  assert.match(markup, /id="startup-progress-bar"/);
  assert.match(markup, /id="startup-retry"[^>]*hidden/);
  assert.match(frontend, /FIRST_LAUNCH_READY_KEY/);
  assert.match(frontend, /const bootstrap = await command\("get_bootstrap"\)/);
  assert.match(frontend, /await waitForRenderedFrame\(\)/);
  assert.match(frontend, /localStorage\.setItem\(FIRST_LAUNCH_READY_KEY, "1"\)/);
  assert.match(styles, /\.startup-screen/);
  assert.match(styles, /\.startup-progress i/);
});
