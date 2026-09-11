use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, super::error::Error>;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum DragItem {
    Files(Vec<PathBuf>),
    Data {
        data: SharedData,
        #[serde(rename = "types")]
        mime_types: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum SharedData {
    Fixed(String),
    Map(HashMap<String, String>),
}

/// El icono del arrastre: una ruta absoluta o el contenido en base64.
///
/// Una sola variante a propósito. Antes eran dos —`Base64(String)` y
/// `Raw(String)`— bajo `#[serde(untagged)]`, que prueba en orden y se queda con la
/// primera que encaje: las dos encajan con cualquier cadena, así que `Raw` era
/// **inalcanzable** y una ruta se intentaba decodificar como base64. El arrastre
/// nunca tuvo icono. Cuál de las dos cosas es lo decide el contenido, en
/// `commands::cargar_icono`, que es donde se puede mirar el disco.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct Image(pub String);

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DragMode {
    #[default]
    Copy,
    Move,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DragOptions {
    #[serde(default)]
    pub mode: DragMode,
    /// When set, keep the drag armed until the pointer reaches this many pixels
    /// from any edge of the WebKit widget. This lets web content retain control
    /// of internal drops while GTK owns the exact Wayland edge handoff.
    #[serde(default)]
    pub edge_threshold: Option<f64>,
    /// Pointer position when the web gesture began, in WebKit viewport pixels.
    /// Keeping this lets the native side distinguish an outward edge crossing
    /// from a card near an edge being dragged back into Phoenix.
    #[serde(default)]
    pub start_x: Option<f64>,
    #[serde(default)]
    pub start_y: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CursorPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize)]
pub enum DragResult {
    Started,
    Dropped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallbackResult {
    pub result: DragResult,
    /// La acción que negoció el destino: `"copy"` o `"move"`. Informativa.
    pub action: Option<String>,
    /// Si el destino pidió que el origen borre lo que entregó.
    ///
    /// **Esta es la señal que autoriza borrar, y no `action`.** Un destino puede
    /// elegir mover y después no pedir el borrado —porque falló al guardar, o
    /// porque cambió de idea—, y borrar por haber visto «move» sería perder un
    /// archivo que nadie copió a ninguna parte. GTK emite `drag-data-delete` sólo
    /// cuando la entrega salió bien y corresponde borrar.
    #[serde(rename = "sourceShouldDelete")]
    pub source_should_delete: bool,
    #[serde(rename = "cursorPos")]
    pub cursor_pos: CursorPosition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_icono_llega_como_una_sola_cosa() {
        // Una ruta y un base64 son los dos una cadena, y no hay forma de que serde
        // los distinga: por eso hay una variante y no dos. Antes eran dos bajo
        // `untagged` y la segunda era inalcanzable.
        let ruta: Image = serde_json::from_str(r#""/usr/share/icons/x.png""#).expect("ruta");
        assert_eq!(ruta.0, "/usr/share/icons/x.png");
        let b64: Image = serde_json::from_str(r#""iVBORw0KGgo=""#).expect("base64");
        assert_eq!(b64.0, "iVBORw0KGgo=");
    }

    #[test]
    fn los_datos_sueltos_conservan_sus_tipos_y_su_contenido() {
        // La API de JS los ofrece; antes el lado Rust los descartaba y el arrastre
        // salía sin nada.
        let d: DragItem = serde_json::from_str(
            r#"{"data":{"text/plain":"llano","text/html":"<b>rico</b>"},"types":["text/plain","text/html"]}"#,
        )
        .expect("deserializa");

        match d {
            DragItem::Data { data, mime_types } => {
                assert_eq!(mime_types, vec!["text/plain", "text/html"]);
                match data {
                    SharedData::Map(m) => {
                        assert_eq!(m.get("text/plain").map(String::as_str), Some("llano"));
                        assert_eq!(m.get("text/html").map(String::as_str), Some("<b>rico</b>"));
                    }
                    otro => panic!("{otro:?}"),
                }
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn una_lista_de_rutas_se_lee_como_archivos_y_no_como_datos() {
        // `untagged` prueba en orden: si `Data` estuviera primero, un arreglo de
        // cadenas podría entrar por el lado equivocado.
        let d: DragItem = serde_json::from_str(r#"["/tmp/a.txt"]"#).expect("deserializa");
        assert!(matches!(d, DragItem::Files(_)));
    }
}
