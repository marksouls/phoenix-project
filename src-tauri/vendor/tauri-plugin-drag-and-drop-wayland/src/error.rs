#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("drag failed: {0}")]
    Drag(String),
    #[error("{0}")]
    Base64(#[from] base64::DecodeError),
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
