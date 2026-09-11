use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub extension: String,
    pub mime_type: String,
    pub size: i64,
    pub width: i64,
    pub height: i64,
    pub source_url: String,
    pub website: String,
    pub annotation: String,
    pub rating: i64,
    pub created_at: i64,
    pub modified_at: i64,
    pub imported_at: i64,
    pub comfyui: Option<ComfyUiMetadata>,
    pub tags: Vec<String>,
    pub folder_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUiMetadata {
    pub positive_prompt: String,
    pub negative_prompt: String,
    pub samplers: Vec<ComfyUiSampler>,
    pub models: Vec<String>,
    pub loras: Vec<String>,
    pub vaes: Vec<String>,
    pub clips: Vec<String>,
    pub node_count: usize,
    pub workflow_id: String,
    pub frontend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUiSampler {
    pub seed: String,
    pub steps: Option<f64>,
    pub cfg: Option<f64>,
    pub sampler: String,
    pub scheduler: String,
    pub denoise: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: String,
    pub item_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub library_path: String,
    pub pairing_token: String,
    pub suggested_import_path: Option<String>,
    pub assets: Vec<Asset>,
    pub trashed_assets: Vec<Asset>,
    pub folders: Vec<Folder>,
    pub external_drag_files: Vec<ExternalDragFile>,
    pub total_items: usize,
    pub total_bytes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub data_base64: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub annotation: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub media_type: String,
    #[serde(default)]
    pub extension: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub name: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub state: String,
    pub message: String,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub discovered: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub exported: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPatch {
    pub id: String,
    pub name: Option<String>,
    pub extension: Option<String>,
    pub annotation: Option<String>,
    pub rating: Option<i64>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDragFile {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub mime_type: String,
}
