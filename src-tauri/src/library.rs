use crate::model::{
    Asset, AssetPatch, Bootstrap, CaptureRequest, ComfyUiMetadata, ComfyUiSampler,
    DownloadProgress, ExportSummary, ExternalDragFile, Folder, ImportSummary,
};
use base64::Engine;
use chrono::{Datelike, Local, NaiveDateTime, TimeZone};
use image::{ImageDecoder, ImageFormat};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Clone)]
pub struct Library {
    pub root: PathBuf,
    db_path: PathBuf,
    token: String,
    suggested_import_path: Option<PathBuf>,
    downloads: Arc<Mutex<HashMap<String, DownloadProgress>>>,
}

impl Library {
    pub fn open(root: PathBuf, suggested_import_path: Option<PathBuf>) -> Result<Self, String> {
        fs::create_dir_all(root.join("objects")).map_err(to_string)?;
        fs::create_dir_all(root.join("thumbnails")).map_err(to_string)?;
        fs::create_dir_all(root.join(".staging")).map_err(to_string)?;
        fs::create_dir_all(root.join(".drag-out")).map_err(to_string)?;

        let token_path = root.join("pairing-token");
        let token = match fs::read_to_string(&token_path) {
            Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
            _ => {
                let value = Uuid::new_v4().to_string();
                fs::write(&token_path, format!("{value}\n")).map_err(to_string)?;
                value
            }
        };

        let library = Self {
            db_path: root.join("library.sqlite3"),
            root,
            token,
            suggested_import_path,
            downloads: Arc::new(Mutex::new(HashMap::new())),
        };
        library.initialize_schema()?;
        library.repair_oriented_thumbnails()?;
        library.repair_asset_dates()?;
        library.repair_comfyui_metadata()?;
        Ok(library)
    }

    fn connect(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.db_path).map_err(to_string)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA busy_timeout = 5000;",
            )
            .map_err(to_string)?;
        Ok(connection)
    }

    fn initialize_schema(&self) -> Result<(), String> {
        let connection = self.connect()?;
        connection
            .execute_batch(
                "
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                extension TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                width INTEGER NOT NULL DEFAULT 0,
                height INTEGER NOT NULL DEFAULT 0,
                source_url TEXT NOT NULL DEFAULT '',
                website TEXT NOT NULL DEFAULT '',
                annotation TEXT NOT NULL DEFAULT '',
                rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
                original_path TEXT NOT NULL,
                thumbnail_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                imported_at INTEGER NOT NULL,
                comfyui_json TEXT NOT NULL DEFAULT '',
                is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE
            );
            CREATE TABLE IF NOT EXISTS asset_tags (
                asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY(asset_id, tag_id)
            );
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT NOT NULL DEFAULT '#efb84c',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_assets (
                folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                PRIMARY KEY(folder_id, asset_id)
            );
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
                asset_id UNINDEXED,
                name,
                annotation,
                website,
                tags,
                tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                happened_at INTEGER NOT NULL,
                action TEXT NOT NULL,
                asset_id TEXT,
                details TEXT NOT NULL DEFAULT '{}'
            );
            ",
            )
            .map_err(to_string)?;
        let has_modified_at: bool = connection
            .prepare("PRAGMA table_info(assets)")
            .map_err(to_string)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(to_string)?
            .filter_map(Result::ok)
            .any(|name| name == "modified_at");
        if !has_modified_at {
            connection
                .execute(
                    "ALTER TABLE assets ADD COLUMN modified_at INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(to_string)?;
        }
        let has_comfyui_json: bool = connection
            .prepare("PRAGMA table_info(assets)")
            .map_err(to_string)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(to_string)?
            .filter_map(Result::ok)
            .any(|name| name == "comfyui_json");
        if !has_comfyui_json {
            connection
                .execute(
                    "ALTER TABLE assets ADD COLUMN comfyui_json TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(to_string)?;
        }
        let has_folder_color: bool = connection
            .prepare("PRAGMA table_info(folders)")
            .map_err(to_string)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(to_string)?
            .filter_map(Result::ok)
            .any(|name| name == "color");
        if !has_folder_color {
            connection
                .execute(
                    "ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT '#efb84c'",
                    [],
                )
                .map_err(to_string)?;
            connection
                .execute_batch(
                    "UPDATE folders SET color = CASE abs(rowid) % 8
                        WHEN 0 THEN '#efb84c' WHEN 1 THEN '#5d94ee'
                        WHEN 2 THEN '#e66b63' WHEN 3 THEN '#8b72db'
                        WHEN 4 THEN '#45a989' WHEN 5 THEN '#d875b0'
                        WHEN 6 THEN '#df8c42' ELSE '#62a9bd' END;",
                )
                .map_err(to_string)?;
        }
        Ok(())
    }

    fn repair_oriented_thumbnails(&self) -> Result<(), String> {
        let connection = self.connect()?;
        let completed: Option<String> = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'orientation_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_string)?;
        if completed.as_deref() == Some("1") {
            return Ok(());
        }

        let records = {
            let mut statement = connection
                .prepare("SELECT id, original_path, thumbnail_path, extension FROM assets")
                .map_err(to_string)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(to_string)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row.map_err(to_string)?);
            }
            records
        };

        for (id, original_path, thumbnail_path, extension) in records {
            let format = match format_for_extension(&extension) {
                Some(format) => format,
                None => continue,
            };
            let bytes = match fs::read(&original_path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    eprintln!(
                        "Phoenix could not read {original_path} for orientation repair: {error}"
                    );
                    continue;
                }
            };
            let decoded = match decode_oriented(&bytes, format) {
                Ok(decoded) => decoded,
                Err(error) => {
                    eprintln!("Phoenix could not orient {original_path}: {error}");
                    continue;
                }
            };
            let thumbnail = decoded.thumbnail(720, 720).to_rgb8();
            if let Err(error) = thumbnail.save_with_format(&thumbnail_path, ImageFormat::Jpeg) {
                eprintln!("Phoenix could not update {thumbnail_path}: {error}");
                continue;
            }
            connection
                .execute(
                    "UPDATE assets SET width = ?1, height = ?2 WHERE id = ?3",
                    params![i64::from(decoded.width()), i64::from(decoded.height()), id],
                )
                .map_err(to_string)?;
        }
        connection
            .execute(
                "INSERT INTO app_meta (key, value) VALUES ('orientation_version', '1')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .map_err(to_string)?;
        Ok(())
    }

    fn repair_asset_dates(&self) -> Result<(), String> {
        let connection = self.connect()?;
        let completed: Option<String> = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'asset_dates_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_string)?;
        if completed.as_deref() == Some("1") {
            return Ok(());
        }

        let records = {
            let mut statement = connection
                .prepare("SELECT id, original_path, created_at, imported_at FROM assets")
                .map_err(to_string)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .map_err(to_string)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };

        for (id, original_path, previous_created, imported_at) in records {
            let bytes = fs::read(&original_path).unwrap_or_default();
            let metadata = fs::metadata(&original_path).ok();
            let embedded = embedded_creation_time(&bytes);
            let filesystem_modified = metadata
                .as_ref()
                .and_then(|value| value.modified().ok())
                .and_then(system_time_millis);
            let filesystem_created = metadata
                .as_ref()
                .and_then(|value| value.created().ok())
                .and_then(system_time_millis);
            let created_at = [
                embedded,
                filesystem_created,
                filesystem_modified,
                Some(previous_created),
            ]
            .into_iter()
            .flatten()
            .filter(|value| *value > 0)
            .min()
            .unwrap_or(imported_at);
            let modified_at = match (embedded, filesystem_modified) {
                (Some(original), Some(modified)) if (modified - imported_at).abs() < 300_000 => {
                    original
                }
                (_, Some(modified)) => modified,
                (Some(original), None) => original,
                _ => created_at,
            };
            connection
                .execute(
                    "UPDATE assets SET created_at = ?1, modified_at = ?2 WHERE id = ?3",
                    params![created_at, modified_at, id],
                )
                .map_err(to_string)?;
        }
        connection
            .execute(
                "INSERT INTO app_meta (key, value) VALUES ('asset_dates_version', '1')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .map_err(to_string)?;
        Ok(())
    }

    fn repair_comfyui_metadata(&self) -> Result<(), String> {
        let connection = self.connect()?;
        let completed: Option<String> = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'comfyui_metadata_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_string)?;
        if completed.as_deref() == Some("1") {
            return Ok(());
        }

        let records = {
            let mut statement = connection
                .prepare("SELECT id, original_path FROM assets WHERE extension = 'png'")
                .map_err(to_string)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(to_string)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for (id, path) in records {
            let summary = fs::read(&path)
                .ok()
                .and_then(|bytes| extract_comfyui_metadata(&bytes))
                .and_then(|metadata| serde_json::to_string(&metadata).ok())
                .unwrap_or_default();
            connection
                .execute(
                    "UPDATE assets SET comfyui_json = ?1 WHERE id = ?2",
                    params![summary, id],
                )
                .map_err(to_string)?;
        }
        connection
            .execute(
                "INSERT INTO app_meta (key, value) VALUES ('comfyui_metadata_version', '1')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .map_err(to_string)?;
        Ok(())
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn update_download(
        &self,
        id: &str,
        name: &str,
        received_bytes: u64,
        total_bytes: Option<u64>,
        state: &str,
        message: &str,
    ) {
        let finished_at = matches!(state, "complete" | "error").then(unix_millis);
        let progress = DownloadProgress {
            id: id.to_owned(),
            name: sanitize_text(name, 240),
            received_bytes,
            total_bytes,
            state: state.to_owned(),
            message: sanitize_text(message, 500),
            finished_at,
        };
        self.downloads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_owned(), progress);
    }

    pub fn download_progress(&self) -> Vec<DownloadProgress> {
        let now = unix_millis();
        let mut downloads = self
            .downloads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        downloads.retain(|_, progress| {
            progress
                .finished_at
                .is_none_or(|finished| now.saturating_sub(finished) < 7_000)
        });
        let mut progress: Vec<_> = downloads.values().cloned().collect();
        progress.sort_by(|left, right| left.id.cmp(&right.id));
        progress
    }

    pub fn bootstrap(&self) -> Result<Bootstrap, String> {
        let assets = self.list_assets(None)?;
        let trashed_assets = self.list_deleted_assets()?;
        let folders = self.list_folders()?;
        let asset_ids: Vec<String> = assets.iter().map(|asset| asset.id.clone()).collect();
        let external_drag_files = self.external_drag_files(&asset_ids)?;
        let total_bytes = assets.iter().map(|asset| asset.size).sum();
        Ok(Bootstrap {
            library_path: self.root.to_string_lossy().into_owned(),
            pairing_token: self.token.clone(),
            suggested_import_path: self
                .suggested_import_path
                .as_ref()
                .filter(|path| path.exists())
                .map(|path| path.to_string_lossy().into_owned()),
            total_items: assets.len(),
            total_bytes,
            assets,
            trashed_assets,
            folders,
            external_drag_files,
        })
    }

    pub fn list_assets(&self, query: Option<&str>) -> Result<Vec<Asset>, String> {
        self.query_assets(query, false, false)
    }

    pub fn search_assets(&self, query: &str, wide: bool) -> Result<Vec<Asset>, String> {
        self.query_assets(Some(query), false, wide)
    }

    pub fn list_deleted_assets(&self) -> Result<Vec<Asset>, String> {
        self.query_assets(None, true, false)
    }

    fn query_assets(
        &self,
        query: Option<&str>,
        deleted: bool,
        wide: bool,
    ) -> Result<Vec<Asset>, String> {
        let connection = self.connect()?;
        let base = format!(
            "
            SELECT a.id, a.name, a.extension, a.mime_type, a.size, a.width, a.height,
                   a.source_url, a.website, a.annotation, a.rating, a.created_at, a.modified_at, a.imported_at,
                   a.comfyui_json,
                   COALESCE(group_concat(t.name, char(31)), ''),
                   COALESCE((SELECT group_concat(fa.folder_id, char(31))
                             FROM folder_assets fa WHERE fa.asset_id = a.id), '')
            FROM assets a
            LEFT JOIN asset_tags at ON at.asset_id = a.id
            LEFT JOIN tags t ON t.id = at.tag_id
            WHERE a.is_deleted = {}",
            if deleted { 1 } else { 0 }
        );

        let mut assets = Vec::new();
        if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            let search_condition = if wide {
                "(
                    instr(lower(a.name || '.' || a.extension), lower(?2)) > 0
                    OR a.id IN (SELECT asset_id FROM assets_fts WHERE assets_fts MATCH ?1)
                    OR instr(lower(a.source_url), lower(?2)) > 0
                    OR instr(lower(a.website), lower(?2)) > 0
                    OR instr(lower(a.annotation), lower(?2)) > 0
                 )"
            } else {
                "instr(lower(a.name || '.' || a.extension), lower(?2)) > 0"
            };
            let sql = format!(
                "{base} AND {search_condition}
                 GROUP BY a.id ORDER BY a.imported_at DESC, a.name COLLATE NOCASE"
            );
            let mut statement = connection.prepare(&sql).map_err(to_string)?;
            let rows = statement
                .query_map(
                    params![sanitize_fts_query(query), query.trim()],
                    row_to_asset,
                )
                .map_err(to_string)?;
            for row in rows {
                assets.push(row.map_err(to_string)?);
            }
        } else {
            let sql =
                format!("{base} GROUP BY a.id ORDER BY a.imported_at DESC, a.name COLLATE NOCASE");
            let mut statement = connection.prepare(&sql).map_err(to_string)?;
            let rows = statement.query_map([], row_to_asset).map_err(to_string)?;
            for row in rows {
                assets.push(row.map_err(to_string)?);
            }
        }
        Ok(assets)
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>, String> {
        let connection = self.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT f.id, f.name, f.color, COUNT(a.id)
                 FROM folders f
                 LEFT JOIN folder_assets fa ON fa.folder_id = f.id
                 LEFT JOIN assets a ON a.id = fa.asset_id AND a.is_deleted = 0
                 GROUP BY f.id ORDER BY f.name COLLATE NOCASE",
            )
            .map_err(to_string)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    item_count: row.get(3)?,
                })
            })
            .map_err(to_string)?;
        let mut folders = Vec::new();
        for row in rows {
            folders.push(row.map_err(to_string)?);
        }
        Ok(folders)
    }

    pub fn create_folder(&self, name: &str) -> Result<Folder, String> {
        let name = sanitize_text(name.trim(), 200);
        if name.is_empty() {
            return Err("Folder name cannot be empty".to_owned());
        }
        let id = Uuid::new_v4().to_string();
        let color = random_folder_color(&id).to_owned();
        self.connect()?
            .execute(
                "INSERT INTO folders (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, color, unix_millis()],
            )
            .map_err(|error| {
                if error.to_string().contains("UNIQUE constraint failed") {
                    "A folder with that name already exists".to_owned()
                } else {
                    error.to_string()
                }
            })?;
        Ok(Folder {
            id,
            name,
            color,
            item_count: 0,
        })
    }

    pub fn update_folder_color(&self, folder_id: &str, color: &str) -> Result<(), String> {
        let color = normalize_folder_color(color)
            .ok_or_else(|| "Choose one of the available folder colors".to_owned())?;
        let changed = self
            .connect()?
            .execute(
                "UPDATE folders SET color = ?1 WHERE id = ?2",
                params![color, folder_id],
            )
            .map_err(to_string)?;
        if changed == 0 {
            return Err("Folder not found".to_owned());
        }
        Ok(())
    }

    pub fn delete_folder(&self, folder_id: &str) -> Result<usize, String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
                [folder_id],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        if !exists {
            return Err("Folder not found".to_owned());
        }
        let item_count: usize = transaction
            .query_row(
                "SELECT COUNT(*)
                 FROM folder_assets fa
                 JOIN assets a ON a.id = fa.asset_id
                 WHERE fa.folder_id = ?1 AND a.is_deleted = 0",
                [folder_id],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        transaction
            .execute(
                "INSERT INTO audit_log (happened_at, action, asset_id, details)
                 SELECT ?1, 'asset.trash', a.id, '{\"reason\":\"folder deleted\"}'
                 FROM folder_assets fa
                 JOIN assets a ON a.id = fa.asset_id
                 WHERE fa.folder_id = ?2 AND a.is_deleted = 0",
                params![unix_millis(), folder_id],
            )
            .map_err(to_string)?;
        transaction
            .execute(
                "UPDATE assets SET is_deleted = 1
                 WHERE is_deleted = 0 AND id IN (
                   SELECT asset_id FROM folder_assets WHERE folder_id = ?1
                 )",
                [folder_id],
            )
            .map_err(to_string)?;
        transaction
            .execute("DELETE FROM folders WHERE id = ?1", [folder_id])
            .map_err(to_string)?;
        transaction.commit().map_err(to_string)?;
        Ok(item_count)
    }

    pub fn add_assets_to_folder(
        &self,
        folder_id: &str,
        asset_ids: &[String],
    ) -> Result<(), String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
                [folder_id],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        if !exists {
            return Err("Folder not found".to_owned());
        }
        for asset_id in asset_ids {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO folder_assets (folder_id, asset_id)
                     SELECT ?1, id FROM assets WHERE id = ?2 AND is_deleted = 0",
                    params![folder_id, asset_id],
                )
                .map_err(to_string)?;
        }
        transaction.commit().map_err(to_string)
    }

    pub fn remove_assets_from_folder(
        &self,
        folder_id: &str,
        asset_ids: &[String],
    ) -> Result<(), String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        for asset_id in asset_ids {
            let removed = transaction
                .execute(
                    "DELETE FROM folder_assets WHERE folder_id = ?1 AND asset_id = ?2",
                    params![folder_id, asset_id],
                )
                .map_err(to_string)?;
            if removed > 0 {
                transaction
                    .execute(
                        "INSERT INTO audit_log (happened_at, action, asset_id, details)
                         VALUES (?1, 'folder.remove', ?2, json_object('folderId', ?3))",
                        params![unix_millis(), asset_id, folder_id],
                    )
                    .map_err(to_string)?;
            }
        }
        transaction.commit().map_err(to_string)
    }

    pub fn move_assets_to_trash(&self, asset_ids: &[String]) -> Result<(), String> {
        self.set_deleted(asset_ids, true)
    }

    pub fn restore_assets(&self, asset_ids: &[String]) -> Result<(), String> {
        self.set_deleted(asset_ids, false)
    }

    pub fn delete_assets_permanently(&self, asset_ids: &[String]) -> Result<usize, String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        let mut records = Vec::new();
        {
            let mut statement = transaction
                .prepare(
                    "SELECT id, original_path, thumbnail_path
                     FROM assets WHERE id = ?1 AND is_deleted = 1",
                )
                .map_err(to_string)?;
            for asset_id in asset_ids {
                let record = statement
                    .query_row([asset_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .optional()
                    .map_err(to_string)?;
                if let Some(record) = record {
                    records.push(record);
                }
            }
        }
        for (asset_id, _, _) in &records {
            transaction
                .execute("DELETE FROM assets_fts WHERE asset_id = ?1", [asset_id])
                .map_err(to_string)?;
            transaction
                .execute("DELETE FROM audit_log WHERE asset_id = ?1", [asset_id])
                .map_err(to_string)?;
            transaction
                .execute(
                    "DELETE FROM assets WHERE id = ?1 AND is_deleted = 1",
                    [asset_id],
                )
                .map_err(to_string)?;
        }
        transaction
            .execute(
                "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM asset_tags)",
                [],
            )
            .map_err(to_string)?;
        transaction.commit().map_err(to_string)?;

        let mut cleanup_errors = Vec::new();
        for (asset_id, original_path, thumbnail_path) in &records {
            for path in [Path::new(original_path), Path::new(thumbnail_path)] {
                if !path.starts_with(&self.root) {
                    cleanup_errors.push(format!(
                        "refused to remove unmanaged path {}",
                        path.display()
                    ));
                    continue;
                }
                if let Err(error) = fs::remove_file(path) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        cleanup_errors.push(format!("{}: {error}", path.display()));
                    }
                }
            }
            let drag_directory = self.root.join(".drag-out").join(asset_id);
            if let Err(error) = fs::remove_dir_all(&drag_directory) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    cleanup_errors.push(format!("{}: {error}", drag_directory.display()));
                }
            }
        }
        if cleanup_errors.is_empty() {
            Ok(records.len())
        } else {
            Err(format!(
                "The library entries were deleted, but {} managed file cleanup operation(s) failed: {}",
                cleanup_errors.len(),
                cleanup_errors.join("; ")
            ))
        }
    }

    pub fn empty_trash(&self) -> Result<usize, String> {
        let connection = self.connect()?;
        let asset_ids = {
            let mut statement = connection
                .prepare("SELECT id FROM assets WHERE is_deleted = 1")
                .map_err(to_string)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(to_string)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(to_string)?
        };
        self.delete_assets_permanently(&asset_ids)
    }

    fn set_deleted(&self, asset_ids: &[String], deleted: bool) -> Result<(), String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        let action = if deleted {
            "asset.trash"
        } else {
            "asset.restore"
        };
        for asset_id in asset_ids {
            transaction
                .execute(
                    "UPDATE assets SET is_deleted = ?1 WHERE id = ?2",
                    params![i64::from(deleted), asset_id],
                )
                .map_err(to_string)?;
            transaction
                .execute(
                    "INSERT INTO audit_log (happened_at, action, asset_id, details)
                     VALUES (?1, ?2, ?3, '{}')",
                    params![unix_millis(), action, asset_id],
                )
                .map_err(to_string)?;
        }
        transaction.commit().map_err(to_string)
    }

    pub fn export_assets(
        &self,
        asset_ids: &[String],
        destination: &Path,
    ) -> Result<ExportSummary, String> {
        if !destination.is_absolute() || !destination.is_dir() {
            return Err("Choose an existing destination folder".to_owned());
        }
        let connection = self.connect()?;
        let mut summary = ExportSummary {
            exported: 0,
            failed: Vec::new(),
        };
        for asset_id in asset_ids {
            let record = connection
                .query_row(
                    "SELECT name, extension, original_path FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(to_string)?;
            let Some((name, extension, source)) = record else {
                summary.failed.push(format!("{asset_id}: asset not found"));
                continue;
            };
            let stem = clean_export_stem(&name);
            let mut target = destination.join(format!("{stem}.{extension}"));
            let mut suffix = 2;
            while target.exists() {
                target = destination.join(format!("{stem} ({suffix}).{extension}"));
                suffix += 1;
            }
            match fs::copy(&source, &target) {
                Ok(_) => summary.exported += 1,
                Err(error) => summary
                    .failed
                    .push(format!("{}: {error}", target.display())),
            }
        }
        Ok(summary)
    }

    pub fn external_drag_files(
        &self,
        asset_ids: &[String],
    ) -> Result<Vec<ExternalDragFile>, String> {
        let connection = self.connect()?;
        let mut files = Vec::new();
        for asset_id in asset_ids {
            let record = connection
                .query_row(
                    "SELECT name, extension, mime_type, original_path FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(to_string)?;
            if let Some((name, extension, mime_type, path)) = record {
                if Path::new(&path).is_file() {
                    let file_name = format!("{}.{}", clean_export_stem(&name), extension);
                    let drag_directory = self.root.join(".drag-out").join(asset_id);
                    fs::create_dir_all(&drag_directory).map_err(to_string)?;
                    let drag_path = drag_directory.join(&file_name);
                    // Keep an already prepared drag file stable. Replacing it
                    // during pointer-down invalidates WebKitGTK's active drag
                    // source on Wayland and leaves the drag icon at its origin.
                    if !drag_path.is_file() {
                        for entry in fs::read_dir(&drag_directory).map_err(to_string)? {
                            let stale_path = entry.map_err(to_string)?.path();
                            if stale_path != drag_path {
                                let _ = fs::remove_file(stale_path);
                            }
                        }
                        if fs::hard_link(&path, &drag_path).is_err() {
                            fs::copy(&path, &drag_path).map_err(to_string)?;
                        }
                    }
                    files.push(ExternalDragFile {
                        id: asset_id.clone(),
                        path: drag_path.to_string_lossy().into_owned(),
                        file_name,
                        mime_type,
                    });
                }
            }
        }
        Ok(files)
    }

    pub fn import_directory(&self, source: &Path) -> Result<ImportSummary, String> {
        if !source.exists() {
            return Err(format!("Import path does not exist: {}", source.display()));
        }

        let supported = [
            "jpg", "jpeg", "png", "webp", "gif", "txt", "mp4", "m4v", "mov", "webm", "mkv", "ogv",
            "avi",
        ];
        let mut files = Vec::new();
        if source.is_file() {
            files.push(source.to_owned());
        } else if source.is_dir() {
            for entry in WalkDir::new(source).follow_links(false) {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => return Err(error.to_string()),
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let ext = entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if supported.contains(&ext.as_str()) {
                    files.push(entry.path().to_owned());
                }
            }
        }
        files.retain(|path| {
            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            supported.contains(&ext.as_str())
        });
        files.sort();

        let mut summary = ImportSummary {
            discovered: files.len(),
            imported: 0,
            duplicates: 0,
            skipped: 0,
            failed: Vec::new(),
        };

        for file in files {
            match fs::read(&file).map_err(to_string).and_then(|bytes| {
                let name = file
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled")
                    .to_owned();
                let (created_at, modified_at) = source_file_dates(&file, &bytes);
                let extension = file
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if extension == "txt" {
                    self.ingest_text_bytes(&bytes, &name, created_at, modified_at)
                } else if is_video_extension(&extension) {
                    self.ingest_video_bytes(
                        &bytes,
                        &name,
                        &extension,
                        "",
                        "",
                        "",
                        &[],
                        created_at,
                        modified_at,
                    )
                } else {
                    self.ingest_bytes(&bytes, &name, "", "", "", &[], created_at, modified_at)
                }
            }) {
                Ok(IngestOutcome::Imported(_)) => summary.imported += 1,
                Ok(IngestOutcome::Duplicate(_)) => summary.duplicates += 1,
                Err(error) => summary.failed.push(format!("{}: {error}", file.display())),
            }
        }
        summary.skipped = summary
            .discovered
            .saturating_sub(summary.imported + summary.duplicates + summary.failed.len());
        Ok(summary)
    }

    pub fn create_text_asset(&self, name: &str, content: &str) -> Result<Asset, String> {
        match self.ingest_text_bytes(content.as_bytes(), name, None, None)? {
            IngestOutcome::Imported(asset) | IngestOutcome::Duplicate(asset) => Ok(asset),
        }
    }

    pub fn read_text_asset(&self, asset_id: &str) -> Result<String, String> {
        let record = self
            .connect()?
            .query_row(
                "SELECT mime_type, original_path FROM assets WHERE id = ?1",
                [asset_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_string)?
            .ok_or_else(|| "Text file not found".to_owned())?;
        if record.0 != "text/plain" {
            return Err("This asset is not a text file".to_owned());
        }
        fs::read_to_string(record.1).map_err(|error| format!("Could not read text file: {error}"))
    }

    pub fn update_text_asset(&self, asset_id: &str, content: &str) -> Result<Asset, String> {
        if content.len() > 10 * 1024 * 1024 {
            return Err("Text files are limited to 10 MB".to_owned());
        }
        let connection = self.connect()?;
        let record = connection
            .query_row(
                "SELECT mime_type, original_path FROM assets WHERE id = ?1 AND is_deleted = 0",
                [asset_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_string)?
            .ok_or_else(|| "Text file not found".to_owned())?;
        if record.0 != "text/plain" {
            return Err("This asset is not a text file".to_owned());
        }

        let bytes = content.as_bytes();
        let hash = text_asset_hash(asset_id, bytes);
        let object_dir = self.root.join("objects").join(&hash[0..2]);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        let target_path = object_dir.join(format!("{hash}.txt"));
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, bytes).map_err(to_string)?;
        fs::rename(&staging_path, &target_path).map_err(to_string)?;
        let now = unix_millis();
        if let Err(error) = connection.execute(
            "UPDATE assets
             SET sha256 = ?1, size = ?2, original_path = ?3, modified_at = ?4
             WHERE id = ?5",
            params![
                hash,
                bytes.len() as i64,
                target_path.to_string_lossy(),
                now,
                asset_id
            ],
        ) {
            let _ = fs::remove_file(&target_path);
            return Err(error.to_string());
        }
        if Path::new(&record.1) != target_path {
            let _ = fs::remove_file(record.1);
        }
        let _ = fs::remove_dir_all(self.root.join(".drag-out").join(asset_id));
        self.asset_by_id(asset_id)?
            .ok_or_else(|| "Text file not found after saving".to_owned())
    }

    fn ingest_text_bytes(
        &self,
        bytes: &[u8],
        name: &str,
        source_created_at: Option<i64>,
        source_modified_at: Option<i64>,
    ) -> Result<IngestOutcome, String> {
        if bytes.len() > 10 * 1024 * 1024 {
            return Err("Text files are limited to 10 MB".to_owned());
        }
        std::str::from_utf8(bytes).map_err(|_| "Only UTF-8 text files are supported".to_owned())?;
        let id = Uuid::new_v4().to_string();
        let hash = text_asset_hash(&id, bytes);
        let object_dir = self.root.join("objects").join(&hash[0..2]);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        let object_path = object_dir.join(format!("{hash}.txt"));
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, bytes).map_err(to_string)?;
        fs::rename(&staging_path, &object_path).map_err(to_string)?;

        let now = unix_millis();
        let created_at = source_created_at.unwrap_or(now);
        let modified_at = source_modified_at.unwrap_or(created_at);
        let clean_name = sanitize_text(name.trim_end_matches(".txt"), 500);
        let connection = self.connect()?;
        if let Err(error) = connection.execute(
            "INSERT INTO assets (
                id, sha256, name, extension, mime_type, size, width, height,
                source_url, website, annotation, original_path, thumbnail_path,
                created_at, modified_at, imported_at, comfyui_json
             ) VALUES (?1, ?2, ?3, 'txt', 'text/plain', ?4, 0, 0, '', '', '', ?5, '', ?6, ?7, ?8, '')",
            params![
                id,
                hash,
                if clean_name.is_empty() { "Untitled" } else { &clean_name },
                bytes.len() as i64,
                object_path.to_string_lossy(),
                created_at,
                modified_at,
                now
            ],
        ) {
            let _ = fs::remove_file(&object_path);
            return Err(error.to_string());
        }
        let transaction = connection.unchecked_transaction().map_err(to_string)?;
        refresh_fts(&transaction, &id)?;
        transaction.commit().map_err(to_string)?;
        self.asset_by_id(&id)?
            .map(IngestOutcome::Imported)
            .ok_or_else(|| "Created text file was not indexed".to_owned())
    }

    pub async fn capture(&self, capture: CaptureRequest) -> Result<Asset, String> {
        if capture.token != self.token {
            return Err("Invalid pairing token".to_owned());
        }

        let name = if capture.name.trim().is_empty() {
            if capture.media_type.eq_ignore_ascii_case("video") {
                "Captured video"
            } else {
                "Captured image"
            }
        } else {
            capture.name.trim()
        };

        if !capture.data_base64.is_empty() {
            let payload = capture
                .data_base64
                .split_once(',')
                .map(|(_, value)| value)
                .unwrap_or(&capture.data_base64);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|_| "Captured media data is not valid base64".to_owned())?;
            if bytes.len() > 50 * 1024 * 1024 {
                return Err("Inline capture exceeds the 50 MB limit".to_owned());
            }
            if capture.media_type.eq_ignore_ascii_case("video") {
                let extension = capture_video_extension(&capture, "").ok_or_else(|| {
                    "Phoenix could not determine this video's file format".to_owned()
                })?;
                let progress_id = Uuid::new_v4().to_string();
                let size = bytes.len() as u64;
                self.update_download(
                    &progress_id,
                    name,
                    size,
                    Some(size),
                    "processing",
                    "Adding video to the library…",
                );
                let result = self.ingest_video_bytes(
                    &bytes,
                    name,
                    &extension,
                    &capture.url,
                    &capture.website,
                    &capture.annotation,
                    &capture.tags,
                    None,
                    None,
                );
                return match result {
                    Ok(IngestOutcome::Imported(asset)) | Ok(IngestOutcome::Duplicate(asset)) => {
                        self.update_download(
                            &progress_id,
                            name,
                            size,
                            Some(size),
                            "complete",
                            "Video saved to Phoenix",
                        );
                        Ok(asset)
                    }
                    Err(error) => {
                        self.update_download(&progress_id, name, size, Some(size), "error", &error);
                        Err(error)
                    }
                };
            }
            return match self.ingest_bytes(
                &bytes,
                name,
                &capture.url,
                &capture.website,
                &capture.annotation,
                &capture.tags,
                None,
                None,
            )? {
                IngestOutcome::Imported(asset) | IngestOutcome::Duplicate(asset) => Ok(asset),
            };
        }

        validate_remote_url(&capture.url)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(60 * 30))
            .build()
            .map_err(to_string)?;
        let mut response = client
            .get(&capture.url)
            .header(reqwest::header::USER_AGENT, "Phoenix-Project/0.1")
            .header(
                reqwest::header::ACCEPT,
                "video/*,image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
            )
            .send()
            .await
            .map_err(to_string)?
            .error_for_status()
            .map_err(to_string)?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let video_extension = capture_video_extension(&capture, &content_type);
        let video = capture.media_type.eq_ignore_ascii_case("video")
            || content_type.starts_with("video/")
            || video_extension.is_some();

        if video {
            let extension = video_extension
                .ok_or_else(|| "Phoenix could not determine this video's file format".to_owned())?;
            let total = response.content_length();
            const MAX_VIDEO_CAPTURE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
            let progress_id = Uuid::new_v4().to_string();
            self.update_download(
                &progress_id,
                name,
                0,
                total,
                "downloading",
                "Starting download…",
            );
            if total.is_some_and(|size| size > MAX_VIDEO_CAPTURE_BYTES) {
                let error = "Video capture exceeds the 4 GB limit";
                self.update_download(&progress_id, name, 0, total, "error", error);
                return Err(error.to_owned());
            }

            let staging_path = self
                .root
                .join(".staging")
                .join(format!("download-{progress_id}"));
            let mut staging = match tokio::fs::File::create(&staging_path).await {
                Ok(file) => file,
                Err(error) => {
                    self.update_download(&progress_id, name, 0, total, "error", &error.to_string());
                    return Err(error.to_string());
                }
            };
            let mut received = 0_u64;
            let download_result: Result<(), String> = async {
                while let Some(chunk) = response.chunk().await.map_err(to_string)? {
                    received = received.saturating_add(chunk.len() as u64);
                    if received > MAX_VIDEO_CAPTURE_BYTES {
                        return Err("Video capture exceeds the 4 GB limit".to_owned());
                    }
                    staging.write_all(&chunk).await.map_err(to_string)?;
                    self.update_download(
                        &progress_id,
                        name,
                        received,
                        total,
                        "downloading",
                        "Downloading video…",
                    );
                }
                staging.flush().await.map_err(to_string)?;
                Ok(())
            }
            .await;
            drop(staging);
            if let Err(error) = download_result {
                let _ = tokio::fs::remove_file(&staging_path).await;
                self.update_download(&progress_id, name, received, total, "error", &error);
                return Err(error);
            }

            self.update_download(
                &progress_id,
                name,
                received,
                total.or(Some(received)),
                "processing",
                "Adding video to the library…",
            );
            let result = self.ingest_video_staging(
                &staging_path,
                name,
                &extension,
                &capture.url,
                &capture.website,
                &capture.annotation,
                &capture.tags,
                None,
                None,
            );
            match result {
                Ok(IngestOutcome::Imported(asset)) | Ok(IngestOutcome::Duplicate(asset)) => {
                    self.update_download(
                        &progress_id,
                        name,
                        received,
                        total.or(Some(received)),
                        "complete",
                        "Video saved to Phoenix",
                    );
                    Ok(asset)
                }
                Err(error) => {
                    let _ = fs::remove_file(&staging_path);
                    self.update_download(
                        &progress_id,
                        name,
                        received,
                        total.or(Some(received)),
                        "error",
                        &error,
                    );
                    Err(error)
                }
            }
        } else {
            if response.content_length().unwrap_or(0) > 50 * 1024 * 1024 {
                return Err("Image capture exceeds the 50 MB limit".to_owned());
            }
            let bytes = response.bytes().await.map_err(to_string)?.to_vec();
            if bytes.len() > 50 * 1024 * 1024 {
                return Err("Image capture exceeds the 50 MB limit".to_owned());
            }
            match self.ingest_bytes(
                &bytes,
                name,
                &capture.url,
                &capture.website,
                &capture.annotation,
                &capture.tags,
                None,
                None,
            )? {
                IngestOutcome::Imported(asset) | IngestOutcome::Duplicate(asset) => Ok(asset),
            }
        }
    }

    fn ingest_bytes(
        &self,
        bytes: &[u8],
        name: &str,
        source_url: &str,
        website: &str,
        annotation: &str,
        tags: &[String],
        source_created_at: Option<i64>,
        source_modified_at: Option<i64>,
    ) -> Result<IngestOutcome, String> {
        if bytes.is_empty() {
            return Err("Cannot import an empty file".to_owned());
        }

        let format =
            image::guess_format(bytes).map_err(|_| "Unsupported or invalid image".to_owned())?;
        let extension =
            extension_for_format(format).ok_or_else(|| "Unsupported image format".to_owned())?;
        let mime_type = mime_for_format(format);
        let comfyui_json = extract_comfyui_metadata(bytes)
            .and_then(|metadata| serde_json::to_string(&metadata).ok())
            .unwrap_or_default();
        let hash = format!("{:x}", Sha256::digest(bytes));

        if let Some(asset) = self.asset_by_hash(&hash)? {
            let detected_created = source_created_at.or_else(|| embedded_creation_time(bytes));
            if detected_created.is_some() || source_modified_at.is_some() {
                self.connect()?
                    .execute(
                        "UPDATE assets
                         SET created_at = COALESCE(?1, created_at),
                             modified_at = COALESCE(?2, modified_at)
                         WHERE id = ?3",
                        params![detected_created, source_modified_at, &asset.id],
                    )
                    .map_err(to_string)?;
                return self
                    .asset_by_id(&asset.id)?
                    .map(IngestOutcome::Duplicate)
                    .ok_or_else(|| "Asset not found after refreshing dates".to_owned());
            }
            return Ok(IngestOutcome::Duplicate(asset));
        }

        let decoded = decode_oriented(bytes, format)?;
        let width = i64::from(decoded.width());
        let height = i64::from(decoded.height());
        let prefix = &hash[0..2];
        let object_dir = self.root.join("objects").join(prefix);
        let thumbnail_dir = self.root.join("thumbnails").join(prefix);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        fs::create_dir_all(&thumbnail_dir).map_err(to_string)?;

        let object_path = object_dir.join(format!("{hash}.{extension}"));
        let thumbnail_path = thumbnail_dir.join(format!("{hash}.jpg"));
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, bytes).map_err(to_string)?;

        let thumbnail = decoded.thumbnail(720, 720).to_rgb8();
        thumbnail
            .save_with_format(&thumbnail_path, ImageFormat::Jpeg)
            .map_err(to_string)?;
        fs::rename(&staging_path, &object_path).map_err(to_string)?;

        let id = Uuid::new_v4().to_string();
        let now = unix_millis();
        let created_at = source_created_at
            .or_else(|| embedded_creation_time(bytes))
            .unwrap_or(now);
        let modified_at = source_modified_at.unwrap_or(created_at);
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        transaction
            .execute(
                "INSERT INTO assets (
                    id, sha256, name, extension, mime_type, size, width, height,
                    source_url, website, annotation, original_path, thumbnail_path,
                    created_at, modified_at, imported_at, comfyui_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    id,
                    hash,
                    sanitize_text(name, 500),
                    extension,
                    mime_type,
                    bytes.len() as i64,
                    width,
                    height,
                    sanitize_text(source_url, 4096),
                    sanitize_text(website, 4096),
                    sanitize_text(annotation, 10_000),
                    object_path.to_string_lossy(),
                    thumbnail_path.to_string_lossy(),
                    created_at,
                    modified_at,
                    now,
                    comfyui_json
                ],
            )
            .map_err(to_string)?;

        replace_tags(&transaction, &id, tags)?;
        refresh_fts(&transaction, &id)?;
        transaction
            .execute(
                "INSERT INTO audit_log (happened_at, action, asset_id, details) VALUES (?1, 'asset.import', ?2, '{}')",
                params![now, id],
            )
            .map_err(to_string)?;
        transaction.commit().map_err(to_string)?;

        let asset = self
            .asset_by_id(&id)?
            .ok_or_else(|| "Imported asset was not indexed".to_owned())?;
        Ok(IngestOutcome::Imported(asset))
    }

    fn ingest_video_bytes(
        &self,
        bytes: &[u8],
        name: &str,
        extension: &str,
        source_url: &str,
        website: &str,
        annotation: &str,
        tags: &[String],
        source_created_at: Option<i64>,
        source_modified_at: Option<i64>,
    ) -> Result<IngestOutcome, String> {
        validate_video_bytes(extension, bytes)?;
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, bytes).map_err(to_string)?;
        self.ingest_video_staging(
            &staging_path,
            name,
            extension,
            source_url,
            website,
            annotation,
            tags,
            source_created_at,
            source_modified_at,
        )
    }

    fn ingest_video_staging(
        &self,
        staging_path: &Path,
        name: &str,
        extension: &str,
        source_url: &str,
        website: &str,
        annotation: &str,
        tags: &[String],
        source_created_at: Option<i64>,
        source_modified_at: Option<i64>,
    ) -> Result<IngestOutcome, String> {
        let mut source = fs::File::open(staging_path).map_err(to_string)?;
        let mut header = [0_u8; 16];
        let header_length = source.read(&mut header).map_err(to_string)?;
        validate_video_bytes(extension, &header[..header_length])?;
        source.seek(SeekFrom::Start(0)).map_err(to_string)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        let mut size = 0_u64;
        loop {
            let read = source.read(&mut buffer).map_err(to_string)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            size = size.saturating_add(read as u64);
        }
        drop(source);
        let hash = format!("{:x}", hasher.finalize());
        if let Some(asset) = self.asset_by_hash(&hash)? {
            let _ = fs::remove_file(staging_path);
            return Ok(IngestOutcome::Duplicate(asset));
        }

        let prefix = &hash[0..2];
        let object_dir = self.root.join("objects").join(prefix);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        let object_path = object_dir.join(format!("{hash}.{extension}"));
        fs::rename(&staging_path, &object_path).map_err(to_string)?;

        let id = Uuid::new_v4().to_string();
        let now = unix_millis();
        let created_at = source_created_at.unwrap_or(now);
        let modified_at = source_modified_at.unwrap_or(created_at);
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        transaction
            .execute(
                "INSERT INTO assets (
                    id, sha256, name, extension, mime_type, size, width, height,
                    source_url, website, annotation, original_path, thumbnail_path,
                    created_at, modified_at, imported_at, comfyui_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, '')",
                params![
                    id,
                    hash,
                    sanitize_text(name, 500),
                    extension,
                    mime_for_video_extension(extension),
                    i64::try_from(size).unwrap_or(i64::MAX),
                    sanitize_text(source_url, 4096),
                    sanitize_text(website, 4096),
                    sanitize_text(annotation, 10_000),
                    object_path.to_string_lossy(),
                    object_path.to_string_lossy(),
                    created_at,
                    modified_at,
                    now,
                ],
            )
            .map_err(to_string)?;
        replace_tags(&transaction, &id, tags)?;
        refresh_fts(&transaction, &id)?;
        transaction
            .execute(
                "INSERT INTO audit_log (happened_at, action, asset_id, details)
                 VALUES (?1, 'asset.import', ?2, '{\"type\":\"video\"}')",
                params![now, id],
            )
            .map_err(to_string)?;
        transaction.commit().map_err(to_string)?;
        let asset = self
            .asset_by_id(&id)?
            .ok_or_else(|| "Imported video was not indexed".to_owned())?;
        Ok(IngestOutcome::Imported(asset))
    }

    pub fn update_asset(&self, patch: AssetPatch) -> Result<Asset, String> {
        if let Some(extension) = patch.extension.as_deref() {
            self.convert_asset_extension(&patch.id, extension)?;
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(to_string)?;
        if let Some(name) = patch.name {
            transaction
                .execute(
                    "UPDATE assets SET name = ?1 WHERE id = ?2",
                    params![sanitize_text(&name, 500), patch.id],
                )
                .map_err(to_string)?;
        }
        if let Some(annotation) = patch.annotation {
            transaction
                .execute(
                    "UPDATE assets SET annotation = ?1 WHERE id = ?2",
                    params![sanitize_text(&annotation, 10_000), patch.id],
                )
                .map_err(to_string)?;
        }
        if let Some(rating) = patch.rating {
            transaction
                .execute(
                    "UPDATE assets SET rating = ?1 WHERE id = ?2",
                    params![rating.clamp(0, 5), patch.id],
                )
                .map_err(to_string)?;
        }
        if let Some(tags) = patch.tags {
            replace_tags(&transaction, &patch.id, &tags)?;
        }
        refresh_fts(&transaction, &patch.id)?;
        transaction
            .execute(
                "INSERT INTO audit_log (happened_at, action, asset_id, details) VALUES (?1, 'asset.update', ?2, '{}')",
                params![unix_millis(), patch.id],
            )
            .map_err(to_string)?;
        transaction.commit().map_err(to_string)?;
        self.asset_by_id(&patch.id)?
            .ok_or_else(|| "Asset not found".to_owned())
    }

    pub fn crop_asset(
        &self,
        asset_id: &str,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<Asset, String> {
        if width == 0 || height == 0 {
            return Err("The crop must have a width and height".to_owned());
        }
        let connection = self.connect()?;
        let record = connection
            .query_row(
                "SELECT extension, original_path, thumbnail_path FROM assets WHERE id = ?1",
                [asset_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(to_string)?
            .ok_or_else(|| "Asset not found".to_owned())?;
        let original_bytes = fs::read(&record.1).map_err(to_string)?;
        let source_format = image::guess_format(&original_bytes)
            .map_err(|_| "The stored image could not be decoded".to_owned())?;
        let decoded = decode_oriented(&original_bytes, source_format)?;
        if x >= decoded.width()
            || y >= decoded.height()
            || x.saturating_add(width) > decoded.width()
            || y.saturating_add(height) > decoded.height()
        {
            return Err("The crop extends beyond the image".to_owned());
        }
        if x == 0 && y == 0 && width == decoded.width() && height == decoded.height() {
            return self
                .asset_by_id(asset_id)?
                .ok_or_else(|| "Asset not found".to_owned());
        }

        let cropped = decoded.crop_imm(x, y, width, height);
        let target_format = format_for_extension(&record.0)
            .ok_or_else(|| "The stored image format cannot be cropped".to_owned())?;
        let mut encoded = Cursor::new(Vec::new());
        cropped
            .write_to(&mut encoded, target_format)
            .map_err(to_string)?;
        let cropped_bytes = encoded.into_inner();
        let hash = format!("{:x}", Sha256::digest(&cropped_bytes));
        if let Some(existing) = self.asset_by_hash(&hash)? {
            if existing.id != asset_id {
                return Err("An identical cropped image already exists in Phoenix".to_owned());
            }
        }

        let object_dir = self.root.join("objects").join(&hash[0..2]);
        let thumbnail_dir = self.root.join("thumbnails").join(&hash[0..2]);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        fs::create_dir_all(&thumbnail_dir).map_err(to_string)?;
        let object_path = object_dir.join(format!("{}.{}", hash, record.0));
        let thumbnail_path = thumbnail_dir.join(format!("{hash}.jpg"));
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, &cropped_bytes).map_err(to_string)?;
        fs::rename(&staging_path, &object_path).map_err(to_string)?;
        if let Err(error) = cropped
            .thumbnail(720, 720)
            .to_rgb8()
            .save_with_format(&thumbnail_path, ImageFormat::Jpeg)
        {
            let _ = fs::remove_file(&object_path);
            return Err(error.to_string());
        }

        let now = unix_millis();
        let update = connection.execute(
            "UPDATE assets
             SET sha256 = ?1, size = ?2, width = ?3, height = ?4,
                 original_path = ?5, thumbnail_path = ?6, modified_at = ?7,
                 comfyui_json = ''
             WHERE id = ?8",
            params![
                hash,
                cropped_bytes.len() as i64,
                i64::from(width),
                i64::from(height),
                object_path.to_string_lossy(),
                thumbnail_path.to_string_lossy(),
                now,
                asset_id
            ],
        );
        if let Err(error) = update {
            let _ = fs::remove_file(&object_path);
            let _ = fs::remove_file(&thumbnail_path);
            return Err(error.to_string());
        }
        connection
            .execute(
                "INSERT INTO audit_log (happened_at, action, asset_id, details)
                 VALUES (?1, 'asset.crop', ?2, ?3)",
                params![
                    now,
                    asset_id,
                    format!(r#"{{"x":{x},"y":{y},"width":{width},"height":{height}}}"#)
                ],
            )
            .map_err(to_string)?;
        if Path::new(&record.1) != object_path {
            let _ = fs::remove_file(record.1);
        }
        if Path::new(&record.2) != thumbnail_path {
            let _ = fs::remove_file(record.2);
        }
        let _ = fs::remove_dir_all(self.root.join(".drag-out").join(asset_id));
        self.asset_by_id(asset_id)?
            .ok_or_else(|| "Asset not found after cropping".to_owned())
    }

    fn convert_asset_extension(&self, asset_id: &str, requested: &str) -> Result<(), String> {
        let normalized = requested
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let connection = self.connect()?;
        let record = connection
            .query_row(
                "SELECT extension, original_path FROM assets WHERE id = ?1",
                [asset_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(to_string)?
            .ok_or_else(|| "Asset not found".to_owned())?;
        if record.0 == "txt" {
            return if normalized == "txt" {
                Ok(())
            } else {
                Err("Text files must keep the .txt extension".to_owned())
            };
        }
        if is_video_extension(&record.0) {
            return if normalized == record.0 {
                Ok(())
            } else {
                Err("Video files must keep their original extension".to_owned())
            };
        }
        let target_format = format_for_extension(&normalized)
            .ok_or_else(|| "Choose jpg, png, webp, or gif as the file extension".to_owned())?;
        let target_extension = extension_for_format(target_format)
            .ok_or_else(|| "Unsupported image format".to_owned())?;
        if record.0 == target_extension {
            return Ok(());
        }

        let original_bytes = fs::read(&record.1).map_err(to_string)?;
        let source_format = image::guess_format(&original_bytes)
            .map_err(|_| "The stored image could not be decoded".to_owned())?;
        let decoded = decode_oriented(&original_bytes, source_format)?;
        let mut encoded = Cursor::new(Vec::new());
        decoded
            .write_to(&mut encoded, target_format)
            .map_err(to_string)?;
        let converted_bytes = encoded.into_inner();
        let hash = format!("{:x}", Sha256::digest(&converted_bytes));
        let object_dir = self.root.join("objects").join(&hash[0..2]);
        fs::create_dir_all(&object_dir).map_err(to_string)?;
        let target_path = object_dir.join(format!("{hash}.{target_extension}"));
        let staging_path = self.root.join(".staging").join(Uuid::new_v4().to_string());
        fs::write(&staging_path, &converted_bytes).map_err(to_string)?;
        fs::rename(&staging_path, &target_path).map_err(to_string)?;
        let update = connection.execute(
            "UPDATE assets
             SET sha256 = ?1, extension = ?2, mime_type = ?3, size = ?4,
                 width = ?5, height = ?6, original_path = ?7, modified_at = ?8,
                 comfyui_json = ''
             WHERE id = ?9",
            params![
                hash,
                target_extension,
                mime_for_format(target_format),
                converted_bytes.len() as i64,
                i64::from(decoded.width()),
                i64::from(decoded.height()),
                target_path.to_string_lossy(),
                unix_millis(),
                asset_id
            ],
        );
        if let Err(error) = update {
            let _ = fs::remove_file(&target_path);
            return Err(if error.to_string().contains("UNIQUE constraint failed") {
                "An identical converted image already exists in Phoenix".to_owned()
            } else {
                error.to_string()
            });
        }
        if Path::new(&record.1) != target_path {
            let _ = fs::remove_file(record.1);
        }
        let _ = fs::remove_dir_all(self.root.join(".drag-out").join(asset_id));
        Ok(())
    }

    pub fn media_path(&self, id: &str, thumbnail: bool) -> Result<Option<PathBuf>, String> {
        let connection = self.connect()?;
        let column = if thumbnail {
            "thumbnail_path"
        } else {
            "original_path"
        };
        connection
            .query_row(
                &format!("SELECT {column} FROM assets WHERE id = ?1"),
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.map(PathBuf::from))
            .map_err(to_string)
    }

    fn asset_by_hash(&self, hash: &str) -> Result<Option<Asset>, String> {
        let connection = self.connect()?;
        asset_query_one(&connection, "a.sha256 = ?1", hash)
    }

    fn asset_by_id(&self, id: &str) -> Result<Option<Asset>, String> {
        let connection = self.connect()?;
        asset_query_one(&connection, "a.id = ?1", id)
    }
}

enum IngestOutcome {
    Imported(Asset),
    Duplicate(Asset),
}

fn asset_query_one(
    connection: &Connection,
    predicate: &str,
    value: &str,
) -> Result<Option<Asset>, String> {
    let sql = format!(
        "SELECT a.id, a.name, a.extension, a.mime_type, a.size, a.width, a.height,
                a.source_url, a.website, a.annotation, a.rating, a.created_at, a.modified_at, a.imported_at,
                a.comfyui_json,
                COALESCE(group_concat(t.name, char(31)), ''),
                COALESCE((SELECT group_concat(fa.folder_id, char(31))
                          FROM folder_assets fa WHERE fa.asset_id = a.id), '')
         FROM assets a
         LEFT JOIN asset_tags at ON at.asset_id = a.id
         LEFT JOIN tags t ON t.id = at.tag_id
         WHERE {predicate} AND a.is_deleted = 0 GROUP BY a.id"
    );
    connection
        .query_row(&sql, [value], row_to_asset)
        .optional()
        .map_err(to_string)
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<Asset> {
    let comfyui_json: String = row.get(14)?;
    let tags: String = row.get(15)?;
    let folder_ids: String = row.get(16)?;
    Ok(Asset {
        id: row.get(0)?,
        name: row.get(1)?,
        extension: row.get(2)?,
        mime_type: row.get(3)?,
        size: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        source_url: row.get(7)?,
        website: row.get(8)?,
        annotation: row.get(9)?,
        rating: row.get(10)?,
        created_at: row.get(11)?,
        modified_at: row.get(12)?,
        imported_at: row.get(13)?,
        comfyui: (!comfyui_json.is_empty())
            .then(|| serde_json::from_str(&comfyui_json).ok())
            .flatten(),
        tags: tags
            .split(char::from(31))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        folder_ids: folder_ids
            .split(char::from(31))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

fn replace_tags(
    transaction: &rusqlite::Transaction<'_>,
    asset_id: &str,
    tags: &[String],
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM asset_tags WHERE asset_id = ?1", [asset_id])
        .map_err(to_string)?;
    for tag in tags {
        let tag = sanitize_text(tag.trim(), 100);
        if tag.is_empty() {
            continue;
        }
        transaction
            .execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [&tag])
            .map_err(to_string)?;
        let tag_id: i64 = transaction
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&tag],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?1, ?2)",
                params![asset_id, tag_id],
            )
            .map_err(to_string)?;
    }
    Ok(())
}

fn refresh_fts(transaction: &rusqlite::Transaction<'_>, asset_id: &str) -> Result<(), String> {
    transaction
        .execute("DELETE FROM assets_fts WHERE asset_id = ?1", [asset_id])
        .map_err(to_string)?;
    transaction
        .execute(
            "INSERT INTO assets_fts (asset_id, name, annotation, website, tags)
             SELECT a.id, a.name, a.annotation, a.website, COALESCE(group_concat(t.name, ' '), '')
             FROM assets a
             LEFT JOIN asset_tags at ON at.asset_id = a.id
             LEFT JOIN tags t ON t.id = at.tag_id
             WHERE a.id = ?1 GROUP BY a.id",
            [asset_id],
        )
        .map_err(to_string)?;
    Ok(())
}

fn extension_for_format(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::Png => Some("png"),
        ImageFormat::WebP => Some("webp"),
        ImageFormat::Gif => Some("gif"),
        _ => None,
    }
}

fn is_video_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "ogv" | "avi"
    )
}

fn capture_video_extension(capture: &CaptureRequest, content_type: &str) -> Option<String> {
    let declared = capture
        .extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if is_video_extension(&declared) {
        return Some(declared);
    }
    let from_url = reqwest::Url::parse(&capture.url)
        .ok()
        .and_then(|url| {
            Path::new(url.path())
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
        })
        .filter(|extension| is_video_extension(extension));
    if from_url.is_some() {
        return from_url;
    }
    match content_type {
        "video/mp4" => Some("mp4".to_owned()),
        "video/quicktime" => Some("mov".to_owned()),
        "video/webm" => Some("webm".to_owned()),
        "video/x-matroska" => Some("mkv".to_owned()),
        "video/ogg" => Some("ogv".to_owned()),
        "video/x-msvideo" | "video/avi" => Some("avi".to_owned()),
        _ => None,
    }
}

fn mime_for_video_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

fn validate_video_bytes(extension: &str, bytes: &[u8]) -> Result<(), String> {
    let valid = match extension.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" | "mov" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "webm" | "mkv" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "ogv" => bytes.starts_with(b"OggS"),
        "avi" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"AVI ",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Unsupported or invalid video file".to_owned())
    }
}

fn format_for_extension(extension: &str) -> Option<ImageFormat> {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "webp" => Some(ImageFormat::WebP),
        "gif" => Some(ImageFormat::Gif),
        _ => None,
    }
}

fn text_asset_hash(asset_id: &str, bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(asset_id.as_bytes());
    digest.update([0]);
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn extract_comfyui_metadata(bytes: &[u8]) -> Option<ComfyUiMetadata> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    reader.finish().ok()?;
    let info = reader.info();
    let mut chunks = HashMap::new();
    for chunk in &info.uncompressed_latin1_text {
        chunks.insert(chunk.keyword.to_ascii_lowercase(), chunk.text.clone());
    }
    for chunk in &info.compressed_latin1_text {
        if let Ok(text) = chunk.get_text() {
            chunks.insert(chunk.keyword.to_ascii_lowercase(), text);
        }
    }
    for chunk in &info.utf8_text {
        if let Ok(text) = chunk.get_text() {
            chunks.insert(chunk.keyword.to_ascii_lowercase(), text);
        }
    }

    let prompt = chunks
        .get("prompt")
        .and_then(|text| parse_relaxed_json(text))?;
    let nodes = prompt.as_object()?;
    let mut metadata = ComfyUiMetadata {
        node_count: nodes.len(),
        ..ComfyUiMetadata::default()
    };
    let mut positive_ids = HashSet::new();
    let mut negative_ids = HashSet::new();

    for node in nodes.values() {
        let class_type = node
            .get("class_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let inputs = node.get("inputs").and_then(serde_json::Value::as_object);
        let Some(inputs) = inputs else { continue };
        if class_type.to_ascii_lowercase().contains("sampler") {
            reference_node_id(inputs.get("positive")).map(|id| positive_ids.insert(id));
            reference_node_id(inputs.get("negative")).map(|id| negative_ids.insert(id));
            metadata.samplers.push(ComfyUiSampler {
                seed: json_scalar(inputs.get("seed")),
                steps: json_number(inputs.get("steps")),
                cfg: json_number(inputs.get("cfg")),
                sampler: json_string(inputs.get("sampler_name")),
                scheduler: json_string(inputs.get("scheduler")),
                denoise: json_number(inputs.get("denoise")),
            });
        }
        let class_lower = class_type.to_ascii_lowercase();
        if class_lower.contains("lora") {
            push_unique(&mut metadata.loras, json_string(inputs.get("lora_name")));
        }
        if class_lower.contains("vae") && class_lower.contains("loader") {
            push_unique(&mut metadata.vaes, json_string(inputs.get("vae_name")));
        }
        if class_lower.contains("clip") && class_lower.contains("loader") {
            push_unique(&mut metadata.clips, json_string(inputs.get("clip_name")));
        }
        if class_lower.contains("loader") && !class_lower.contains("lora") {
            for key in ["ckpt_name", "unet_name", "model_name"] {
                push_unique(&mut metadata.models, json_string(inputs.get(key)));
            }
        }
    }

    let mut positives = Vec::new();
    let mut negatives = Vec::new();
    for (id, node) in nodes {
        let class_type = node
            .get("class_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !class_type.eq_ignore_ascii_case("CLIPTextEncode") {
            continue;
        }
        let text = node
            .get("inputs")
            .and_then(|inputs| inputs.get("text"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim();
        if text.is_empty() {
            continue;
        }
        let title = node
            .get("_meta")
            .and_then(|meta| meta.get("title"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if negative_ids.contains(id) || title.contains("negative") {
            push_unique(&mut negatives, text.to_owned());
        } else if positive_ids.contains(id) || title.contains("positive") {
            push_unique(&mut positives, text.to_owned());
        }
    }
    metadata.positive_prompt = positives.join("\n\n");
    metadata.negative_prompt = negatives.join("\n\n");

    if let Some(workflow) = chunks
        .get("workflow")
        .and_then(|text| parse_relaxed_json(text))
    {
        metadata.workflow_id = workflow
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        metadata.frontend_version = workflow
            .get("extra")
            .and_then(|extra| extra.get("frontendVersion"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    Some(metadata)
}

fn parse_relaxed_json(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str(text)
        .or_else(|_| serde_json::from_str(&replace_nonfinite_json_values(text)))
        .ok()
}

fn replace_nonfinite_json_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            output.push(b'"');
            index += 1;
            continue;
        }
        let remaining = &text[index..];
        let token_len = ["-Infinity", "Infinity", "NaN"]
            .into_iter()
            .find(|token| remaining.starts_with(token))
            .map(str::len);
        if let Some(length) = token_len {
            let after = bytes.get(index + length).copied();
            if after.is_none_or(|value| !value.is_ascii_alphanumeric() && value != b'_') {
                output.extend_from_slice(b"null");
                index += length;
                continue;
            }
        }
        output.push(byte);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| text.to_owned())
}

fn reference_node_id(value: Option<&serde_json::Value>) -> Option<String> {
    value?.as_array()?.first()?.as_str().map(str::to_owned)
}

fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn json_scalar(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(value)) => value.clone(),
        Some(serde_json::Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(serde_json::Value::as_f64)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn system_time_millis(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn embedded_creation_time(bytes: &[u8]) -> Option<i64> {
    bytes
        .windows(19)
        .filter_map(|window| {
            let matches_shape = window[0..4].iter().all(u8::is_ascii_digit)
                && window[4] == b':'
                && window[5..7].iter().all(u8::is_ascii_digit)
                && window[7] == b':'
                && window[8..10].iter().all(u8::is_ascii_digit)
                && window[10] == b' '
                && window[11..13].iter().all(u8::is_ascii_digit)
                && window[13] == b':'
                && window[14..16].iter().all(u8::is_ascii_digit)
                && window[16] == b':'
                && window[17..19].iter().all(u8::is_ascii_digit);
            if !matches_shape {
                return None;
            }
            let text = std::str::from_utf8(window).ok()?;
            let naive = NaiveDateTime::parse_from_str(text, "%Y:%m:%d %H:%M:%S").ok()?;
            let year = naive.date().year();
            if !(1970..=2100).contains(&year) {
                return None;
            }
            Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|date| date.timestamp_millis())
        })
        .min()
}

fn source_file_dates(path: &Path, bytes: &[u8]) -> (Option<i64>, Option<i64>) {
    let metadata = fs::metadata(path).ok();
    let modified_at = metadata
        .as_ref()
        .and_then(|value| value.modified().ok())
        .and_then(system_time_millis);
    let filesystem_created = metadata
        .as_ref()
        .and_then(|value| value.created().ok())
        .and_then(system_time_millis);
    let created_at = [
        embedded_creation_time(bytes),
        filesystem_created,
        modified_at,
    ]
    .into_iter()
    .flatten()
    .filter(|value| *value > 0)
    .min();
    (created_at, modified_at.or(created_at))
}

fn decode_oriented(bytes: &[u8], format: ImageFormat) -> Result<image::DynamicImage, String> {
    let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut decoder = reader.into_decoder().map_err(to_string)?;
    let orientation = decoder.orientation().map_err(to_string)?;
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(to_string)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

fn mime_for_format(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => "application/octet-stream",
    }
}

fn validate_remote_url(value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| "Capture URL is invalid".to_owned())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only HTTP and HTTPS capture URLs are supported".to_owned());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host == "0.0.0.0" || host == "::1" || host.starts_with("127.") {
        return Err("Capturing from loopback addresses is blocked".to_owned());
    }
    Ok(())
}

fn sanitize_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(limit)
        .collect()
}

fn clean_export_stem(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(240)
        .collect();
    let cleaned = cleaned.trim_matches([' ', '.']);
    if cleaned.is_empty() {
        "Untitled".to_owned()
    } else {
        cleaned.to_owned()
    }
}

fn sanitize_fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

const FOLDER_COLORS: [&str; 8] = [
    "#efb84c", "#5d94ee", "#e66b63", "#8b72db", "#45a989", "#d875b0", "#df8c42", "#62a9bd",
];

fn random_folder_color(seed: &str) -> &'static str {
    let index = seed
        .bytes()
        .fold(0usize, |sum, byte| sum.wrapping_add(byte as usize))
        % FOLDER_COLORS.len();
    FOLDER_COLORS[index]
}

fn normalize_folder_color(value: &str) -> Option<&'static str> {
    FOLDER_COLORS
        .iter()
        .copied()
        .find(|color| color.eq_ignore_ascii_case(value.trim()))
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use std::io::Cursor;

    fn jpeg_with_exif(width: u32, height: u32, orientation: u16, date: &str) -> Vec<u8> {
        assert_eq!(date.len(), 19);
        let pixels = vec![128_u8; (width * height * 3) as usize];
        let mut jpeg = Vec::new();
        JpegEncoder::new(&mut jpeg)
            .encode(&pixels, width, height, image::ExtendedColorType::Rgb8)
            .unwrap();

        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42_u16.to_le_bytes());
        tiff.extend_from_slice(&8_u32.to_le_bytes());
        tiff.extend_from_slice(&2_u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
        tiff.extend_from_slice(&3_u16.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&0_u16.to_le_bytes());
        tiff.extend_from_slice(&0x0132_u16.to_le_bytes());
        tiff.extend_from_slice(&2_u16.to_le_bytes());
        tiff.extend_from_slice(&20_u32.to_le_bytes());
        tiff.extend_from_slice(&38_u32.to_le_bytes());
        tiff.extend_from_slice(&0_u32.to_le_bytes());
        tiff.extend_from_slice(date.as_bytes());
        tiff.push(0);

        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let segment_length = u16::try_from(payload.len() + 2).unwrap();
        let mut result = Vec::with_capacity(jpeg.len() + payload.len() + 4);
        result.extend_from_slice(&jpeg[..2]);
        result.extend_from_slice(&[0xff, 0xe1]);
        result.extend_from_slice(&segment_length.to_be_bytes());
        result.extend_from_slice(&payload);
        result.extend_from_slice(&jpeg[2..]);
        result
    }

    #[test]
    fn sanitizes_search_terms() {
        assert_eq!(sanitize_fts_query("red fox"), "\"red\"* AND \"fox\"*");
        assert_eq!(sanitize_fts_query("one\"two"), "\"one\"\"two\"*");
    }

    #[test]
    fn migrates_existing_folders_to_distinct_colors() {
        let temporary =
            std::env::temp_dir().join(format!("phoenix-folder-color-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temporary).unwrap();
        let connection = Connection::open(temporary.join("library.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO folders (id, name, created_at) VALUES
                    ('one', 'One', 1), ('two', 'Two', 2);",
            )
            .unwrap();
        drop(connection);

        let library = Library::open(temporary.clone(), None).unwrap();
        let folders = library.list_folders().unwrap();
        assert_eq!(folders.len(), 2);
        assert_ne!(folders[0].color, folders[1].color);
        assert!(
            folders
                .iter()
                .all(|folder| FOLDER_COLORS.contains(&folder.color.as_str()))
        );
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn blocks_loopback_capture_urls() {
        assert!(validate_remote_url("http://127.0.0.1/secret").is_err());
        assert!(validate_remote_url("file:///tmp/test.jpg").is_err());
        assert!(validate_remote_url("https://example.com/image.jpg").is_ok());
    }

    #[test]
    fn recognizes_browser_video_formats_and_tracks_progress() {
        let temporary =
            std::env::temp_dir().join(format!("phoenix-progress-test-{}", Uuid::new_v4()));
        let library = Library::open(temporary.clone(), None).unwrap();
        let capture = CaptureRequest {
            token: library.token().to_owned(),
            url: "https://example.com/watch?id=7".to_owned(),
            data_base64: String::new(),
            name: "Example clip".to_owned(),
            website: "https://example.com".to_owned(),
            annotation: String::new(),
            tags: Vec::new(),
            media_type: "video".to_owned(),
            extension: String::new(),
        };
        assert_eq!(
            capture_video_extension(&capture, "video/webm").as_deref(),
            Some("webm")
        );
        library.update_download(
            "download-test",
            "Example clip",
            512,
            Some(1024),
            "downloading",
            "Downloading video…",
        );
        let progress = library.download_progress();
        assert_eq!(progress.len(), 1);
        assert_eq!(
            (progress[0].received_bytes, progress[0].total_bytes),
            (512, Some(1024))
        );
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn applies_exif_orientation_before_layout_and_thumbnailing() {
        let bytes = jpeg_with_exif(2, 3, 6, "2017:07:07 12:34:56");
        let decoded = decode_oriented(&bytes, ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
    }

    #[test]
    fn reads_embedded_photo_creation_dates() {
        let bytes = jpeg_with_exif(2, 3, 1, "2017:07:07 12:34:56");
        let timestamp = embedded_creation_time(&bytes).unwrap();
        let date = Local.timestamp_millis_opt(timestamp).single().unwrap();
        assert_eq!((date.year(), date.month(), date.day()), (2017, 7, 7));
    }

    #[test]
    fn extracts_comfyui_prompts_and_sampler_data_from_png_text_chunks() {
        let prompt = r#"{
          "11":{"class_type":"CLIPTextEncode","inputs":{"text":"bright portrait"},"_meta":{"title":"Positive Prompt"}},
          "12":{"class_type":"CLIPTextEncode","inputs":{"text":"blurry, noisy"},"_meta":{"title":"Negative Prompt"}},
          "19":{"class_type":"KSampler","inputs":{"seed":12345,"steps":28,"cfg":6.5,"sampler_name":"euler","scheduler":"normal","denoise":NaN,"positive":["11",0],"negative":["12",0]}},
          "20":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"phoenix-model.safetensors"}},
          "21":{"class_type":"LoraLoader","inputs":{"lora_name":"detail.safetensors"}}
        }"#;
        let workflow = r#"{"id":"workflow-test","extra":{"frontendVersion":"1.24.0"}}"#;
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .add_text_chunk("prompt".to_owned(), prompt.to_owned())
                .unwrap();
            encoder
                .add_text_chunk("workflow".to_owned(), workflow.to_owned())
                .unwrap();
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[240, 120, 80]).unwrap();
        }

        let metadata = extract_comfyui_metadata(&bytes).unwrap();
        assert_eq!(metadata.positive_prompt, "bright portrait");
        assert_eq!(metadata.negative_prompt, "blurry, noisy");
        assert_eq!(metadata.samplers[0].seed, "12345");
        assert_eq!(metadata.samplers[0].steps, Some(28.0));
        assert_eq!(metadata.models, vec!["phoenix-model.safetensors"]);
        assert_eq!(metadata.loras, vec!["detail.safetensors"]);
        assert_eq!(metadata.workflow_id, "workflow-test");
        assert_eq!(metadata.frontend_version, "1.24.0");
    }

    #[test]
    fn creates_reads_updates_and_imports_utf8_text_assets() {
        let temporary = std::env::temp_dir().join(format!("phoenix-text-test-{}", Uuid::new_v4()));
        let source = temporary.join("source");
        let root = temporary.join("Text Library.phoenixlib");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("notes.txt"), "Imported notes").unwrap();

        let library = Library::open(root, None).unwrap();
        let imported = library.import_directory(&source).unwrap();
        assert_eq!((imported.imported, imported.failed.len()), (1, 0));
        let imported_text = library.list_assets(None).unwrap().remove(0);
        assert_eq!(imported_text.extension, "txt");
        assert_eq!(
            library.read_text_asset(&imported_text.id).unwrap(),
            "Imported notes"
        );

        let created = library
            .create_text_asset("Ideas.txt", "First draft")
            .unwrap();
        assert_eq!(library.read_text_asset(&created.id).unwrap(), "First draft");
        let updated = library
            .update_text_asset(&created.id, "Edited in Phoenix")
            .unwrap();
        assert_eq!(updated.size, 17);
        assert_eq!(
            library.read_text_asset(&created.id).unwrap(),
            "Edited in Phoenix"
        );
        assert!(
            library
                .update_asset(AssetPatch {
                    id: created.id,
                    name: None,
                    extension: Some("png".to_owned()),
                    annotation: None,
                    rating: None,
                    tags: None,
                })
                .is_err()
        );

        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn imports_and_exports_video_assets_without_image_decoding() {
        let temporary = std::env::temp_dir().join(format!("phoenix-video-test-{}", Uuid::new_v4()));
        let source = temporary.join("source");
        let root = temporary.join("Video Library.phoenixlib");
        let export = temporary.join("export");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&export).unwrap();
        let sample = [
            0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0, b'i', b's',
            b'o', b'm', b'm', b'p', b'4', b'2',
        ];
        fs::write(source.join("clip.mp4"), sample).unwrap();

        let library = Library::open(root, None).unwrap();
        let imported = library.import_directory(&source).unwrap();
        assert_eq!((imported.imported, imported.failed.len()), (1, 0));
        let video = library.list_assets(None).unwrap().remove(0);
        assert_eq!(
            (video.extension.as_str(), video.mime_type.as_str()),
            ("mp4", "video/mp4")
        );
        assert_eq!((video.width, video.height), (0, 0));
        assert_eq!(
            fs::read(library.media_path(&video.id, false).unwrap().unwrap()).unwrap(),
            sample
        );
        assert_eq!(
            fs::read(library.media_path(&video.id, true).unwrap().unwrap()).unwrap(),
            sample
        );

        let exported = library
            .export_assets(std::slice::from_ref(&video.id), &export)
            .unwrap();
        assert_eq!(exported.exported, 1);
        assert_eq!(fs::read(export.join("clip.mp4")).unwrap(), sample);
        let drag_files = library
            .external_drag_files(std::slice::from_ref(&video.id))
            .unwrap();
        assert_eq!(
            (
                drag_files[0].file_name.as_str(),
                drag_files[0].mime_type.as_str()
            ),
            ("clip.mp4", "video/mp4")
        );

        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn imports_deduplicates_updates_and_searches() {
        let temporary = std::env::temp_dir().join(format!("phoenix-core-test-{}", Uuid::new_v4()));
        let source = temporary.join("source");
        let root = temporary.join("Test Library.phoenixlib");
        fs::create_dir_all(&source).unwrap();

        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12, 8)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let png = encoded.into_inner();
        fs::write(source.join("sample.png"), &png).unwrap();

        let library = Library::open(root.clone(), None).unwrap();
        let first = library.import_directory(&source).unwrap();
        assert_eq!(
            (first.imported, first.duplicates, first.failed.len()),
            (1, 0, 0)
        );
        let second = library.import_directory(&source).unwrap();
        assert_eq!((second.imported, second.duplicates), (0, 1));

        let imported = library.list_assets(None).unwrap().remove(0);
        assert_eq!((imported.width, imported.height), (12, 8));
        assert!(imported.created_at <= imported.imported_at);
        assert!(imported.modified_at <= imported.imported_at);
        let updated = library
            .update_asset(AssetPatch {
                id: imported.id,
                name: Some("Red sample".to_owned()),
                extension: None,
                annotation: Some("Round trip test".to_owned()),
                rating: Some(4),
                tags: Some(vec!["verification".to_owned()]),
            })
            .unwrap();
        assert_eq!(updated.rating, 4);
        assert!(library.list_assets(Some("round trip")).unwrap().is_empty());
        assert_eq!(library.search_assets("round trip", true).unwrap().len(), 1);
        assert_eq!(
            library.search_assets("verification", true).unwrap().len(),
            1
        );

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let captured = runtime
            .block_on(library.capture(CaptureRequest {
                token: library.token().to_owned(),
                url: "https://example.com/sample.png".to_owned(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(&png),
                name: "Captured duplicate".to_owned(),
                website: "https://example.com".to_owned(),
                annotation: String::new(),
                tags: Vec::new(),
                media_type: String::new(),
                extension: String::new(),
            }))
            .unwrap();
        assert_eq!(captured.id, updated.id);
        let unauthorized = runtime.block_on(library.capture(CaptureRequest {
            token: "wrong-token".to_owned(),
            url: "https://example.com/sample.png".to_owned(),
            data_base64: String::new(),
            name: String::new(),
            website: String::new(),
            annotation: String::new(),
            tags: Vec::new(),
            media_type: String::new(),
            extension: String::new(),
        }));
        assert_eq!(unauthorized.unwrap_err(), "Invalid pairing token");

        library
            .update_asset(AssetPatch {
                id: updated.id.clone(),
                name: Some(
                    "http192.168.0.2498189apiviewfilename=ComfyUI_temp_potxt_00002_subf".to_owned(),
                ),
                extension: None,
                annotation: None,
                rating: None,
                tags: None,
            })
            .unwrap();
        assert_eq!(library.list_assets(Some("192")).unwrap().len(), 1);
        assert_eq!(library.list_assets(Some("api")).unwrap().len(), 1);
        library
            .update_asset(AssetPatch {
                id: updated.id.clone(),
                name: Some("Red sample".to_owned()),
                extension: None,
                annotation: None,
                rating: None,
                tags: None,
            })
            .unwrap();

        let folder = library.create_folder("Favorites").unwrap();
        assert!(FOLDER_COLORS.contains(&folder.color.as_str()));
        library.update_folder_color(&folder.id, "#5d94ee").unwrap();
        assert_eq!(library.list_folders().unwrap()[0].color, "#5d94ee");
        library
            .add_assets_to_folder(&folder.id, std::slice::from_ref(&updated.id))
            .unwrap();
        let organized = library.list_assets(None).unwrap().remove(0);
        assert_eq!(organized.folder_ids, vec![folder.id.clone()]);
        assert_eq!(library.list_folders().unwrap()[0].item_count, 1);

        library
            .remove_assets_from_folder(&folder.id, std::slice::from_ref(&updated.id))
            .unwrap();
        assert!(library.list_assets(None).unwrap()[0].folder_ids.is_empty());
        assert_eq!(library.list_folders().unwrap()[0].item_count, 0);
        assert_eq!(library.list_assets(None).unwrap().len(), 1);
        library
            .add_assets_to_folder(&folder.id, std::slice::from_ref(&updated.id))
            .unwrap();

        let export_directory = temporary.join("export");
        fs::create_dir_all(&export_directory).unwrap();
        let exported = library
            .export_assets(std::slice::from_ref(&updated.id), &export_directory)
            .unwrap();
        assert_eq!((exported.exported, exported.failed.len()), (1, 0));
        assert!(export_directory.join("Red sample.png").is_file());

        let converted = library
            .update_asset(AssetPatch {
                id: updated.id.clone(),
                name: None,
                extension: Some("webp".to_owned()),
                annotation: None,
                rating: None,
                tags: None,
            })
            .unwrap();
        assert_eq!(
            (converted.extension.as_str(), converted.mime_type.as_str()),
            ("webp", "image/webp")
        );
        let cropped = library.crop_asset(&converted.id, 2, 1, 6, 4).unwrap();
        assert_eq!((cropped.width, cropped.height), (6, 4));
        let cropped_path = library.media_path(&cropped.id, false).unwrap().unwrap();
        assert_eq!(image::image_dimensions(&cropped_path).unwrap(), (6, 4));
        let drag_files = library
            .external_drag_files(std::slice::from_ref(&cropped.id))
            .unwrap();
        assert_eq!(drag_files[0].file_name, "Red sample.webp");

        library
            .move_assets_to_trash(std::slice::from_ref(&updated.id))
            .unwrap();
        assert!(library.list_assets(None).unwrap().is_empty());
        assert_eq!(library.list_deleted_assets().unwrap().len(), 1);
        assert!(library.media_path(&updated.id, false).unwrap().is_some());
        assert_eq!(library.list_folders().unwrap()[0].item_count, 0);
        library
            .restore_assets(std::slice::from_ref(&updated.id))
            .unwrap();
        assert_eq!(library.list_assets(None).unwrap().len(), 1);
        assert_eq!(library.list_folders().unwrap()[0].item_count, 1);

        let moved_by_folder_delete = library.delete_folder(&folder.id).unwrap();
        assert_eq!(moved_by_folder_delete, 1);
        assert!(library.list_folders().unwrap().is_empty());
        assert!(library.list_assets(None).unwrap().is_empty());
        assert_eq!(library.list_deleted_assets().unwrap().len(), 1);

        let deleted = library.empty_trash().unwrap();
        assert_eq!(deleted, 1);
        assert!(library.list_deleted_assets().unwrap().is_empty());
        assert!(library.media_path(&updated.id, false).unwrap().is_none());
        assert!(!cropped_path.exists());
        assert!(!root.join(".drag-out").join(&updated.id).exists());

        fs::remove_dir_all(temporary).unwrap();
    }
}
