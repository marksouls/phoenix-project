//! Cómo se nombran los archivos que se arrastran.
//!
//! Un `text/uri-list` lleva URIs, no rutas. El plugin las armaba con
//! `format!("file://{}", ruta)`, así que cualquier nombre con un espacio salía
//! como `file:///home/quien/mi archivo.txt` — que no es un URI válido. El destino
//! lo rechaza o lo interpreta mal, y el arrastre «no funciona» con la mitad de los
//! archivos de cualquiera.

use std::path::Path;

/// El URI `file://` de una ruta, codificado como manda la especificación.
///
/// Se usa `glib::filename_to_uri` y no una codificación propia: GLib es la que va
/// a estar del otro lado en la mayoría de los destinos —cualquier cosa que use
/// `g_file_new_for_uri`— así que codificar igual que ella es la forma de que
/// coincidan.
pub fn de_ruta(ruta: &Path) -> Option<String> {
    gtk::glib::filename_to_uri(ruta, None)
        .ok()
        .map(|g| g.to_string())
}

/// Las rutas tal cual, para `text/plain`.
///
/// **Rutas y no URIs.** Un destino que toma `text/plain` es una terminal, un campo
/// de texto o un editor: lo que le sirve es `/home/quien/mi archivo.md`, no
/// `file:///home/quien/mi%20archivo.md`. Mandándole el URI codificado, lo pega tal
/// cual y no hay archivo en ninguna parte — que es exactamente lo que pasó al
/// probarlo. Es lo que hace cualquier gestor de archivos: el URI va en
/// `text/uri-list` y la ruta legible en `text/plain`.
pub fn rutas_como_texto(rutas: &[std::path::PathBuf]) -> String {
    rutas
        .iter()
        .map(|r| r.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn un_nombre_con_espacios_se_codifica() {
        // Es el caso que rompía: `file:///home/quien/mi archivo.txt` no es un URI.
        let u = de_ruta(&PathBuf::from("/home/quien/mi archivo.txt")).expect("uri");
        assert_eq!(u, "file:///home/quien/mi%20archivo.txt");
        assert!(!u.contains(' '));
    }

    #[test]
    fn los_caracteres_que_parten_un_uri_se_escapan() {
        // `#` corta el URI en un fragmento y `?` en una consulta: sin escapar, el
        // destino recibe una ruta cortada por la mitad.
        let u = de_ruta(&PathBuf::from("/tmp/nota #1 ¿ok?.txt")).expect("uri");
        assert!(!u.contains('#'), "{u}");
        assert!(!u.contains('?'), "{u}");
        assert!(u.starts_with("file:///tmp/"));
    }

    #[test]
    fn los_acentos_sobreviven() {
        let u = de_ruta(&PathBuf::from("/home/quien/Vídeos/canción.mp4")).expect("uri");
        assert!(u.starts_with("file:///home/quien/V"));
        // Y se puede volver: si no, el destino no encuentra el archivo.
        let vuelta = gtk::glib::filename_from_uri(&u).expect("vuelta");
        assert_eq!(vuelta.0, PathBuf::from("/home/quien/Vídeos/canción.mp4"));
    }

    #[test]
    fn una_ruta_relativa_no_da_un_uri() {
        // `filename_to_uri` pide una ruta absoluta, y un URI relativo no le sirve a
        // nadie: mejor descartarla que mandar algo que el destino no puede abrir.
        assert_eq!(de_ruta(&PathBuf::from("relativa/x.txt")), None);
    }

    #[test]
    fn el_texto_plano_lleva_la_ruta_y_no_el_uri() {
        // Lo que rompía la entrega: el destino que toma `text/plain` —una
        // terminal, un campo de texto— pegaba `file:///...%20...` tal cual, y no
        // había archivo en ninguna parte.
        let t = rutas_como_texto(&[PathBuf::from("/home/quien/mi archivo.md")]);
        assert_eq!(t, "/home/quien/mi archivo.md");
        assert!(!t.contains("file://"));
        assert!(!t.contains("%20"));
    }

    #[test]
    fn varias_rutas_van_una_por_linea() {
        let t = rutas_como_texto(&[PathBuf::from("/a/uno.txt"), PathBuf::from("/b/dos.txt")]);
        assert_eq!(t, "/a/uno.txt\n/b/dos.txt");
    }

    #[test]
    fn sin_rutas_no_hay_texto() {
        assert_eq!(rutas_como_texto(&[]), "");
    }
}
