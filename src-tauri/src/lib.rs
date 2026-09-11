pub mod library;
pub mod model;
pub mod server;

#[cfg(feature = "desktop")]
use library::Library;
#[cfg(feature = "desktop")]
use model::{
    Asset, AssetPatch, Bootstrap, CaptureRequest, DownloadProgress, ExportSummary,
    ExternalDragFile, Folder, ImportSummary,
};
#[cfg(feature = "desktop")]
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
struct AppState {
    library: Arc<Library>,
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
fn restore_wayland_backend_for_appimage() {
    let appimage_runtime =
        std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
    let wayland_session = std::env::var("XDG_SESSION_TYPE")
        .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"));
    let has_wayland_display = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if wayland_session && has_wayland_display {
        // Tauri's AppImage GTK hook currently exports GDK_BACKEND=x11 even in a
        // Wayland session. This runs before Tauri/GTK creates any threads or
        // initializes GDK, restoring the same backend selected by the DEB.
        unsafe { std::env::set_var("GDK_BACKEND", "wayland") };
    }

    if !appimage_runtime {
        return;
    }

    // linuxdeploy's GTK AppRun hook points GST_PLUGIN_SYSTEM_PATH_1_0 at
    // $APPDIR/usr/lib/gstreamer-1.0, but Tauri's AppImage does not contain
    // that directory. GStreamer then finds no playback elements at all and
    // WebKit can stall while creating the first <video> pipeline. Restore the
    // host plugin directories and scanner before GTK/WebKit initializes. The
    // DEB does not set APPIMAGE/APPDIR and therefore keeps its normal setup.
    let multiarch = match std::env::consts::ARCH {
        "x86_64" => Some("x86_64-linux-gnu"),
        "aarch64" => Some("aarch64-linux-gnu"),
        _ => None,
    };
    let mut plugin_paths = Vec::new();
    if let Some(multiarch) = multiarch {
        plugin_paths.push(PathBuf::from(format!("/usr/lib/{multiarch}/gstreamer-1.0")));
    }
    plugin_paths.extend([
        PathBuf::from("/usr/lib64/gstreamer-1.0"),
        PathBuf::from("/usr/lib/gstreamer-1.0"),
    ]);
    if let Some(existing) = std::env::var_os("GST_PLUGIN_SYSTEM_PATH_1_0") {
        plugin_paths.extend(std::env::split_paths(&existing));
    }
    plugin_paths.retain(|path| path.is_dir());
    plugin_paths.dedup();
    if let Ok(paths) = std::env::join_paths(&plugin_paths) {
        unsafe {
            std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &paths);
            std::env::set_var("GST_PLUGIN_SYSTEM_PATH", paths);
        }
    }

    let mut scanner_candidates = Vec::new();
    if let Some(multiarch) = multiarch {
        scanner_candidates.push(PathBuf::from(format!(
            "/usr/lib/{multiarch}/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
        )));
    }
    scanner_candidates.extend([
        PathBuf::from("/usr/libexec/gstreamer-1.0/gst-plugin-scanner"),
        PathBuf::from("/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"),
    ]);
    if let Some(scanner) = scanner_candidates.into_iter().find(|path| path.is_file()) {
        unsafe {
            std::env::set_var("GST_PLUGIN_SCANNER_1_0", &scanner);
            std::env::set_var("GST_PLUGIN_SCANNER", scanner);
        }
    }
}

#[cfg(all(feature = "desktop", not(target_os = "linux")))]
fn restore_wayland_backend_for_appimage() {}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_bootstrap(state: tauri::State<'_, AppState>) -> Result<Bootstrap, String> {
    state.library.bootstrap()
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_download_progress(state: tauri::State<'_, AppState>) -> Vec<DownloadProgress> {
    state.library.download_progress()
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn import_directory(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ImportSummary, String> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.import_directory(&PathBuf::from(path)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn import_url(
    url: String,
    name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Asset, String> {
    let library = state.library.clone();
    let request = CaptureRequest {
        token: library.token().to_owned(),
        url,
        data_base64: String::new(),
        name: name.unwrap_or_default(),
        website: String::new(),
        annotation: String::new(),
        tags: vec!["browser drop".to_owned()],
        media_type: String::new(),
        extension: String::new(),
    };
    library.capture(request).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn search_assets(
    query: String,
    wide: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Asset>, String> {
    state.library.search_assets(&query, wide.unwrap_or(false))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn update_asset(patch: AssetPatch, state: tauri::State<'_, AppState>) -> Result<Asset, String> {
    state.library.update_asset(patch)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn create_text_asset(
    name: String,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<Asset, String> {
    state.library.create_text_asset(&name, &content)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn read_text_asset(id: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.library.read_text_asset(&id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn update_text_asset(
    id: String,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<Asset, String> {
    state.library.update_text_asset(&id, &content)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn create_folder(name: String, state: tauri::State<'_, AppState>) -> Result<Folder, String> {
    state.library.create_folder(&name)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn update_folder_color(
    folder_id: String,
    color: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.library.update_folder_color(&folder_id, &color)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn delete_folder(folder_id: String, state: tauri::State<'_, AppState>) -> Result<usize, String> {
    state.library.delete_folder(&folder_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn add_assets_to_folder(
    folder_id: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.library.add_assets_to_folder(&folder_id, &asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn remove_assets_from_folder(
    folder_id: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .library
        .remove_assets_from_folder(&folder_id, &asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_external_drag_files(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ExternalDragFile>, String> {
    state.library.external_drag_files(&asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn crop_asset(
    id: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    state: tauri::State<'_, AppState>,
) -> Result<Asset, String> {
    state.library.crop_asset(&id, x, y, width, height)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn move_assets_to_trash(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.library.move_assets_to_trash(&asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn restore_assets(asset_ids: Vec<String>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.library.restore_assets(&asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn delete_assets_permanently(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    state.library.delete_assets_permanently(&asset_ids)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn empty_trash(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    state.library.empty_trash()
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn choose_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = std::process::Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                "--title=Choose export folder",
            ])
            .output()
            .map_err(|error| format!("Could not open the folder chooser: {error}"))?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Ok((!path.is_empty()).then_some(path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn export_assets(
    asset_ids: Vec<String>,
    destination: String,
    state: tauri::State<'_, AppState>,
) -> Result<ExportSummary, String> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.export_assets(&asset_ids, &PathBuf::from(destination))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(&url).map_err(|_| "The source link is not a valid URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS source links can be opened".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .status()
            .map_err(|error| format!("Could not launch the default browser: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("The default browser could not open this source link".to_owned())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn open_asset_externally(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let path = state
        .library
        .media_path(&id, false)?
        .ok_or_else(|| "Item not found".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("gio")
            .arg("open")
            .arg(&path)
            .status()
            .or_else(|_| std::process::Command::new("xdg-open").arg(&path).status())
            .map_err(|error| format!("Could not launch the system application: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("The system application could not open this item".to_owned())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn open_asset_window(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("asset-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("viewer-window.html?id={id}").into()),
    )
    .title("Phoenix File Viewer")
    .inner_size(1100.0, 780.0)
    .min_inner_size(560.0, 420.0)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(feature = "desktop")]
pub fn run() {
    restore_wayland_backend_for_appimage();
    tauri::Builder::default()
        .plugin(tauri_plugin_drag_and_drop_wayland::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(PathBuf::from);
            let development_library = project_root
                .as_ref()
                .map(|root| root.join("Phoenix Test Library.phoenixlib"));
            let library_root = development_library
                .filter(|path| cfg!(debug_assertions) && path.exists())
                .unwrap_or_else(|| app_data.join("Phoenix Library.phoenixlib"));
            let library = Arc::new(Library::open(library_root, None)?);
            server::start(library.clone());
            app.manage(AppState { library });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            get_download_progress,
            import_directory,
            import_url,
            search_assets,
            update_asset,
            create_text_asset,
            read_text_asset,
            update_text_asset,
            create_folder,
            update_folder_color,
            delete_folder,
            add_assets_to_folder,
            remove_assets_from_folder,
            get_external_drag_files,
            crop_asset,
            move_assets_to_trash,
            restore_assets,
            delete_assets_permanently,
            empty_trash,
            choose_directory,
            export_assets,
            open_external_url,
            open_asset_externally,
            open_asset_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running Phoenix Project");
}
