import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontend = join(root, "frontend");
const source = resolve(process.env.PHOENIX_PREVIEW_ASSETS || join(root, "sample-assets"));
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".ogv", "video/ogg"],
  [".avi", "video/x-msvideo"],
]);

const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi"]);

function embeddedCreatedAt(bytes) {
  const matches = bytes.toString("latin1").match(/\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/g) || [];
  const timestamps = matches.map((value) => {
    const [date, time] = value.split(" ");
    const [year, month, day] = date.split(":").map(Number);
    const [hour, minute, second] = time.split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }).filter(Number.isFinite);
  return timestamps.length ? Math.min(...timestamps) : null;
}

async function makeAssets() {
  let names;
  try {
    names = await readdir(source, { recursive: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const assets = [];
  for (const name of names.sort()) {
    if (!/\.(jpe?g|png|webp|gif|mp4|m4v|mov|webm|mkv|ogv|avi)$/i.test(name)) continue;
    const path = join(source, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const bytes = await readFile(path);
    const id = createHash("sha256").update(name).digest("hex").slice(0, 24);
    const fileExtension = extname(name).toLowerCase();
    const video = videoExtensions.has(fileExtension);
    assets.push({
      id,
      name: name.replace(/\.[^.]+$/, ""),
      extension: fileExtension.slice(1).replace("jpeg", "jpg"),
      mimeType: mime.get(fileExtension) || "application/octet-stream",
      size: info.size,
      width: video ? 0 : 3648,
      height: video ? 0 : 2432,
      sourceUrl: "",
      website: "",
      annotation: "",
      rating: 0,
      createdAt: Math.min(...[embeddedCreatedAt(bytes), info.birthtimeMs, info.mtimeMs].filter((value) => value > 0)),
      modifiedAt: info.mtimeMs,
      importedAt: Date.now(),
      comfyui: null,
      tags: [],
      folderIds: [],
      _path: path,
    });
  }
  return assets;
}

const assets = await makeAssets();
const trashedAssets = [];
const folders = [];
const byId = new Map(assets.map((asset) => [asset.id, asset]));
const folderColors = ["#efb84c", "#5d94ee", "#e66b63", "#8b72db", "#45a989", "#d875b0", "#df8c42", "#62a9bd"];

function publicAsset(asset) {
  const { _path, _content, ...value } = asset;
  return value;
}

function publicFolders() {
  return folders.map((folder) => ({
    ...folder,
    itemCount: assets.filter((asset) => asset.folderIds.includes(folder.id)).length,
  }));
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function parseByteRange(value, total) {
  const match = /^bytes=(\d*)-(\d*)/.exec(String(value || ""));
  if (!match || total <= 0) return null;
  if (!match[1]) {
    const suffix = Math.min(Number(match[2]), total);
    return suffix > 0 ? [total - suffix, total - 1] : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && start < total
    ? [start, end] : null;
}

async function handler(request, response) {
  const url = new URL(request.url, "http://127.0.0.1:41673");
  if (url.pathname === "/api/v1/health") return json(response, 200, { status: "ok", name: "Phoenix Project preview", apiVersion: 1 });
  if (url.pathname === "/dev/bootstrap") {
    return json(response, 200, {
      libraryPath: "Preview mode · no files are copied",
      pairingToken: "preview-token",
      suggestedImportPath: source,
      totalItems: assets.length,
      totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      assets: assets.map(publicAsset),
      trashedAssets: trashedAssets.map(publicAsset),
      folders: publicFolders(),
    });
  }
  if (url.pathname === "/dev/search") {
    const query = url.searchParams.get("q")?.toLocaleLowerCase() || "";
    const wide = url.searchParams.get("wide") === "1";
    return json(response, 200, assets.filter((asset) => (wide
      ? [asset.name, asset.sourceUrl, asset.website, asset.annotation, ...asset.tags]
      : [asset.name])
      .some((value) => value.toLocaleLowerCase().includes(query))).map(publicAsset));
  }
  if (url.pathname === "/dev/import" && request.method === "POST") {
    return json(response, 200, { discovered: assets.length, imported: 0, duplicates: assets.length, skipped: 0, failed: [] });
  }
  if (url.pathname === "/dev/capture-url" && request.method === "POST") {
    const capture = await body(request);
    const existing = assets.find((asset) => asset.sourceUrl === capture.url);
    if (existing) return json(response, 200, publicAsset(existing));
    const original = assets[0];
    const asset = {
      ...original,
      id: createHash("sha256").update(capture.url).digest("hex").slice(0, 24),
      name: capture.name || "Browser image",
      sourceUrl: capture.url,
      website: capture.url,
      importedAt: Date.now(),
      tags: ["browser drop"],
      folderIds: [],
    };
    assets.unshift(asset);
    byId.set(asset.id, asset);
    return json(response, 200, publicAsset(asset));
  }
  if (url.pathname === "/dev/update" && request.method === "POST") {
    const { patch = {} } = await body(request);
    const asset = byId.get(patch.id);
    if (!asset) return json(response, 404, { message: "Asset not found" });
    for (const key of ["name", "annotation", "rating", "tags"]) {
      if (patch[key] !== undefined) asset[key] = patch[key];
    }
    if (patch.extension !== undefined && /^(jpe?g|png|webp|gif)$/i.test(patch.extension)) {
      asset.extension = patch.extension.toLocaleLowerCase().replace("jpeg", "jpg");
      asset.mimeType = asset.extension === "jpg" ? "image/jpeg" : `image/${asset.extension}`;
      asset.modifiedAt = Date.now();
    }
    return json(response, 200, publicAsset(asset));
  }
  if (url.pathname === "/dev/text/create" && request.method === "POST") {
    const requestBody = await body(request);
    const cleanName = String(requestBody.name || "Untitled.txt").replace(/\.txt$/i, "") || "Untitled";
    const content = String(requestBody.content || "");
    const now = Date.now();
    const asset = {
      id: createHash("sha256").update(`${cleanName}-${now}-${Math.random()}`).digest("hex").slice(0, 24),
      name: cleanName, extension: "txt", mimeType: "text/plain", size: Buffer.byteLength(content),
      width: 0, height: 0, sourceUrl: "", website: "", annotation: "", rating: 0,
      createdAt: now, modifiedAt: now, importedAt: now, comfyui: null, tags: [], folderIds: [], _content: content,
    };
    assets.unshift(asset);
    byId.set(asset.id, asset);
    return json(response, 200, publicAsset(asset));
  }
  if (url.pathname === "/dev/text/read" && request.method === "GET") {
    const asset = byId.get(url.searchParams.get("id"));
    if (!asset || asset.extension !== "txt") return json(response, 404, { message: "Text file not found" });
    return json(response, 200, asset._content || "");
  }
  if (url.pathname === "/dev/text/update" && request.method === "POST") {
    const requestBody = await body(request);
    const asset = byId.get(requestBody.id);
    if (!asset || asset.extension !== "txt") return json(response, 404, { message: "Text file not found" });
    asset._content = String(requestBody.content || "");
    asset.size = Buffer.byteLength(asset._content);
    asset.modifiedAt = Date.now();
    return json(response, 200, publicAsset(asset));
  }
  if (url.pathname === "/dev/crop" && request.method === "POST") {
    const crop = await body(request);
    const asset = byId.get(crop.id);
    if (!asset) return json(response, 404, { message: "Asset not found" });
    if (!(crop.width > 0 && crop.height > 0)) return json(response, 400, { message: "Invalid crop" });
    asset.width = Math.round(crop.width);
    asset.height = Math.round(crop.height);
    asset.modifiedAt = Date.now();
    return json(response, 200, publicAsset(asset));
  }
  if (url.pathname === "/dev/folders" && request.method === "POST") {
    const requestBody = await body(request);
    const name = String(requestBody.name || "").trim();
    if (!name) return json(response, 400, { message: "Folder name cannot be empty" });
    if (folders.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return json(response, 409, { message: "A folder with that name already exists" });
    }
    const folder = {
      id: createHash("sha256").update(`${name}-${Date.now()}`).digest("hex").slice(0, 24),
      name,
      color: folderColors[Math.floor(Math.random() * folderColors.length)],
      itemCount: 0,
    };
    folders.push(folder);
    return json(response, 200, folder);
  }
  if (url.pathname === "/dev/folder-color" && request.method === "POST") {
    const requestBody = await body(request);
    const folder = folders.find((item) => item.id === requestBody.folderId);
    if (!folder) return json(response, 404, { message: "Folder not found" });
    if (!folderColors.includes(requestBody.color)) return json(response, 400, { message: "Invalid folder color" });
    folder.color = requestBody.color;
    return json(response, 200, null);
  }
  if (url.pathname === "/dev/delete-folder" && request.method === "POST") {
    const requestBody = await body(request);
    const folderIndex = folders.findIndex((folder) => folder.id === requestBody.folderId);
    if (folderIndex < 0) return json(response, 404, { message: "Folder not found" });
    let moved = 0;
    for (let index = assets.length - 1; index >= 0; index -= 1) {
      if (!assets[index].folderIds.includes(requestBody.folderId)) continue;
      trashedAssets.unshift(...assets.splice(index, 1));
      moved += 1;
    }
    for (const asset of [...assets, ...trashedAssets]) {
      asset.folderIds = asset.folderIds.filter((id) => id !== requestBody.folderId);
    }
    folders.splice(folderIndex, 1);
    return json(response, 200, moved);
  }
  if (url.pathname === "/dev/folder-assets" && request.method === "POST") {
    const requestBody = await body(request);
    for (const id of requestBody.assetIds || []) {
      const asset = byId.get(id);
      if (asset && !asset.folderIds.includes(requestBody.folderId)) asset.folderIds.push(requestBody.folderId);
    }
    return json(response, 200, null);
  }
  if (url.pathname === "/dev/remove-folder-assets" && request.method === "POST") {
    const requestBody = await body(request);
    for (const id of requestBody.assetIds || []) {
      const asset = byId.get(id);
      if (asset) asset.folderIds = asset.folderIds.filter((folderId) => folderId !== requestBody.folderId);
    }
    return json(response, 200, null);
  }
  if (url.pathname === "/dev/trash" && request.method === "POST") {
    const requestBody = await body(request);
    for (const id of requestBody.assetIds || []) {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index >= 0) trashedAssets.unshift(...assets.splice(index, 1));
    }
    return json(response, 200, null);
  }
  if (url.pathname === "/dev/restore" && request.method === "POST") {
    const requestBody = await body(request);
    for (const id of requestBody.assetIds || []) {
      const index = trashedAssets.findIndex((asset) => asset.id === id);
      if (index >= 0) assets.unshift(...trashedAssets.splice(index, 1));
    }
    return json(response, 200, null);
  }
  if (url.pathname === "/dev/delete-permanently" && request.method === "POST") {
    const requestBody = await body(request);
    let deleted = 0;
    for (const id of requestBody.assetIds || []) {
      const index = trashedAssets.findIndex((asset) => asset.id === id);
      if (index < 0) continue;
      trashedAssets.splice(index, 1);
      byId.delete(id);
      deleted += 1;
    }
    return json(response, 200, deleted);
  }
  if (url.pathname === "/dev/empty-trash" && request.method === "POST") {
    const deleted = trashedAssets.length;
    for (const asset of trashedAssets) byId.delete(asset.id);
    trashedAssets.splice(0);
    return json(response, 200, deleted);
  }
  if (url.pathname === "/dev/choose-directory") return json(response, 200, source);
  if (url.pathname === "/dev/export" && request.method === "POST") {
    const requestBody = await body(request);
    return json(response, 200, { exported: (requestBody.assetIds || []).length, failed: [] });
  }
  if (url.pathname === "/dev/external-drag" && request.method === "POST") {
    const requestBody = await body(request);
    return json(response, 200, (requestBody.assetIds || []).map((id) => byId.get(id)).filter((asset) => asset?._path).map((asset) => ({
      id: asset.id,
      path: asset._path,
      fileName: `${asset.name}.${asset.extension}`,
      mimeType: asset.mimeType,
    })));
  }

  const mediaMatch = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/(thumbnail|original)$/);
  if (mediaMatch) {
    const asset = byId.get(decodeURIComponent(mediaMatch[1]));
    if (!asset) return json(response, 404, { message: "Asset not found" });
    if (asset.extension === "txt") {
      response.writeHead(200, { "Content-Type": asset.mimeType, "Cache-Control": "public, max-age=3600" });
      return response.end(asset._content || "");
    }
    const range = parseByteRange(request.headers.range, asset.size);
    if (range) {
      const [start, end] = range;
      response.writeHead(206, {
        "Content-Type": asset.mimeType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${asset.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      });
      return createReadStream(asset._path, { start, end }).pipe(response);
    }
    response.writeHead(200, {
      "Content-Type": asset.mimeType,
      "Content-Length": asset.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    });
    return createReadStream(asset._path).pipe(response);
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(frontend, requested));
  if (!path.startsWith(`${frontend}/`)) return json(response, 403, { message: "Forbidden" });
  try {
    const content = await readFile(path);
    response.writeHead(200, { "Content-Type": mime.get(extname(path)) || "application/octet-stream" });
    response.end(content);
  } catch {
    json(response, 404, { message: "Not found" });
  }
}

export function startPreview(port = 41673) {
  const server = createServer((request, response) => handler(request, response).catch((error) => json(response, 500, { message: error.message })));
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startPreview(Number(process.env.PHOENIX_PREVIEW_PORT || 41673));
  const address = server.address();
  process.stdout.write(`Phoenix preview: http://127.0.0.1:${address.port}\n`);
}
