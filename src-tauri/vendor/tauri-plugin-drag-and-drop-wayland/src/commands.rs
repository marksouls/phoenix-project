//! Arrastrar hacia afuera de la aplicación, en Wayland.
//!
//! # Por qué esto no es un comando y medio
//!
//! Un comando de Tauri no puede arrancar un arrastre. `gtk_drag_begin` necesita
//! estar **dentro del despacho de un evento**: usa `gtk_get_current_event()` para
//! sacar el dispositivo y el serial del agarre implícito del ratón, y en Wayland
//! `wl_data_device.start_drag` sin ese serial es una petición que el compositor
//! descarta. Un comando corre en `run_on_main_thread`, o sea en una devolución del
//! bucle principal, donde no hay evento actual.
//!
//! Medido con dos sondas —`examples/sonda-wayland.rs` y
//! `examples/sonda-con-evento.rs`— sobre Wayfire:
//!
//! * Desde un `idle`, `drag_begin_with_coordinates` devuelve `None` con cualquier
//!   widget: `GtkBox`, `GtkEventBox` y el toplevel, los tres igual, con un
//!   `Gdk-CRITICAL` sobre `gdk_wayland_window_get_wl_surface`.
//! * Dentro de un manejador de movimiento, con el botón apretado, devuelve un
//!   contexto — y da igual si se le pasa el evento o `None`, porque GTK lo saca
//!   del evento actual.
//!
//! Así que el comando **arma** el arrastre y quien lo dispara es un manejador de
//! `motion-notify-event`, que sí corre dentro de un evento. Entre el gesto y el
//! arrastre no queda ningún salto asíncrono.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;

use gtk::gdk::DragAction;
use gtk::gio;
use gtk::gio::prelude::*;
use gtk::glib::{self, ToVariant};
use gtk::prelude::*;
use log::{debug, info, warn};
use tauri::ipc::Channel;
use tauri::{command, AppHandle, Runtime, Window};

use crate::error::Error;
use crate::models::*;
use crate::uri;

/// Cuánto vale un arrastre armado antes de darse por perdido.
///
/// Entre el gesto del ratón y el comando hay un viaje de IPC; si en el medio se
/// suelta el botón, el manejador nunca lo dispara y el armado quedaría colgado
/// para el próximo movimiento, arrancando un arrastre que nadie pidió. Pasado el
/// plazo se cancela y se avisa, que es mejor que quedarse en silencio.
const VALIDEZ_DEL_ARMADO_MS: u32 = 30_000;

/// Lo que se identifica como `text/uri-list`.
const URI_TARGET_ID: u32 = 0;
/// Lo que se identifica como texto plano.
const TEXT_TARGET_ID: u32 = 1;
/// Clave de una transferencia a través del portal de escritorio.
const PORTAL_TRANSFER_TARGET_ID: u32 = 2;
/// Alias antiguo que Firefox también consulta antes de caer en `text/uri-list`.
const PORTAL_FILES_TARGET_ID: u32 = 3;
/// El primer identificador para los tipos MIME propios de un arrastre de datos.
const PRIMER_TARGET_PROPIO: u32 = 4;

const PORTAL_BUS: &str = "org.freedesktop.portal.Documents";
const PORTAL_PATH: &str = "/org/freedesktop/portal/documents";
const PORTAL_INTERFACE: &str = "org.freedesktop.portal.FileTransfer";

/// Lo que se va a entregar cuando el destino lo pida.
#[derive(Debug, Clone)]
pub enum Contenido {
    /// Archivos: los URIs codificados para `text/uri-list` **y** las rutas tal
    /// cual para `text/plain`. Hacen falta las dos: un destino de texto pega lo
    /// que recibe, y un URI codificado pegado no es ningún archivo.
    Uris {
        uris: Vec<String>,
        rutas: Vec<PathBuf>,
        /// Key registered with `org.freedesktop.portal.FileTransfer`. GNOME Files
        /// offers this in addition to URI lists and Firefox prefers it on
        /// Wayland, because it produces a durable file-backed `DataTransfer`.
        portal: Option<TransferenciaPortal>,
    },
    /// Datos sueltos: para cada identificador, su tipo MIME y su texto.
    Datos(Vec<(u32, String, String)>),
}

#[derive(Debug, Clone)]
pub struct TransferenciaPortal {
    key: String,
    /// The portal owns a transfer only while its originating D-Bus connection
    /// remains alive. Keeping that connection with the drag is essential: a key
    /// from a disconnected owner is immediately reported as invalid.
    connection: gio::DBusConnection,
}

/// Un arrastre pedido por la interfaz, esperando el próximo movimiento del ratón.
struct Armado {
    contenido: Contenido,
    icono: Option<gdk_pixbuf::Pixbuf>,
    accion: DragAction,
    /// If present, wait for a motion at the edge of the WebKit widget instead
    /// of consuming the first motion after the command arrives.
    edge_threshold: Option<f64>,
    /// Pointer position where the press began. Without an edge threshold GTK's
    /// normal drag distance decides when the one native drag starts.
    start_position: Option<(f64, f64)>,
    /// Last pointer position observed while waiting for an outward crossing.
    last_position: Option<(f64, f64)>,
    canal: Channel<CallbackResult>,
    /// Para que el temporizador de vencimiento no cancele a otro.
    ///
    /// Sin esto, dos arrastres armados dentro de la ventana de validez chocan: el
    /// temporizador del primero se lleva puesto el segundo, que estaba a punto de
    /// dispararse.
    ficha: u64,
}

/// Un arrastre en curso, con lo que hay que entregar y a quién avisarle.
struct EnCurso {
    contenido: Contenido,
    canal: Channel<CallbackResult>,
    /// Dónde estaba el puntero al arrancar, en coordenadas de la pantalla.
    ///
    /// Se informa en el callback. Antes se mandaba `{0, 0}` siempre, o sea que el
    /// campo existía en la API y no decía nada: quien lo usara para ubicar un menú
    /// lo abría en la esquina.
    cursor: CursorPosition,
    /// Si ya se avisó el final. `drag-failed` y `drag-end` pueden llegar los dos.
    avisado: bool,
    /// Si llegó `drag-data-delete`. **Sólo pasa en X11.**
    piden_borrar: bool,
    /// Si llegó `drag-failed`, o sea si el destino no se quedó con nada.
    fallo: bool,
}

thread_local! {
    static ARMADO: RefCell<Option<Armado>> = const { RefCell::new(None) };
    static EN_CURSO: RefCell<Option<EnCurso>> = const { RefCell::new(None) };
    static WIDGET_CACHE: RefCell<HashMap<String, gtk::Widget>> = RefCell::new(HashMap::new());
    /// El contador de fichas de los arrastres armados.
    static PROXIMA_FICHA: RefCell<u64> = const { RefCell::new(0) };
}

fn find_webview_widget(window: &gtk::ApplicationWindow, window_label: &str) -> Option<gtk::Widget> {
    if let Some(cached) = WIDGET_CACHE.with(|cache| cache.borrow().get(window_label).cloned()) {
        if cached.is_visible() {
            return Some(cached);
        }
    }
    let found =
        find_widget_by_type_name(&window.clone().upcast::<gtk::Container>(), "WebKitWebView");
    if let Some(ref w) = found {
        WIDGET_CACHE.with(|cache| {
            cache
                .borrow_mut()
                .insert(window_label.to_string(), w.clone())
        });
    }
    found
}

fn find_widget_by_type_name(container: &gtk::Container, type_name: &str) -> Option<gtk::Widget> {
    for child in container.children() {
        if child.type_().name() == type_name {
            return Some(child);
        }
        if let Some(child_container) = child.downcast_ref::<gtk::Container>() {
            if let Some(found) = find_widget_by_type_name(child_container, type_name) {
                return Some(found);
            }
        }
    }
    None
}

fn load_pixbuf_from_data(data: &[u8]) -> Option<gdk_pixbuf::Pixbuf> {
    let loader = gdk_pixbuf::PixbufLoader::new();
    loader.write(data).ok()?;
    loader.close().ok()?;
    loader.pixbuf()
}

/// Carga el icono del arrastre, sea una ruta o base64.
///
/// Lo decide el contenido y no quien llama: por el puente llega una cadena, y una
/// ruta y un base64 son las dos una cadena. Antes se intentaba distinguirlas con un
/// enum `untagged` de dos variantes de `String`, que serde resuelve siempre por la
/// primera: una ruta —lo que manda el gestor de archivos— se decodificaba como
/// base64, fallaba, y el arrastre nunca tenía icono.
pub fn cargar_icono(valor: &str) -> Option<gdk_pixbuf::Pixbuf> {
    let ruta = PathBuf::from(valor);
    if ruta.is_absolute() && ruta.is_file() {
        if let Ok(datos) = std::fs::read(&ruta) {
            return load_pixbuf_from_data(&datos);
        }
        warn!("no se pudo leer el icono de arrastre: {valor}");
        return None;
    }

    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, valor)
        .ok()
        .and_then(|bytes| load_pixbuf_from_data(&bytes))
}

/// Convierte lo que pidió la interfaz en lo que se va a entregar.
///
/// Los datos sueltos se implementan de verdad: la API de JS los ofrecía y el lado
/// Rust los convertía en `None`, así que el arrastre salía sin nada.
pub fn contenido_de(item: DragItem) -> Contenido {
    match item {
        DragItem::Files(rutas) => {
            let validas: Vec<(String, PathBuf)> = rutas
                .into_iter()
                .filter_map(|r| match uri::de_ruta(&r) {
                    Some(u) => Some((u, r)),
                    None => {
                        warn!("se descarta una ruta que no da un URI: {}", r.display());
                        None
                    }
                })
                .collect();
            let (uris, rutas): (Vec<String>, Vec<PathBuf>) = validas.into_iter().unzip();
            let portal = iniciar_transferencia_portal(&rutas)
                .map_err(|error| {
                    debug!("el portal de archivos no está disponible; se usan URIs: {error}");
                    error
                })
                .ok();
            Contenido::Uris {
                uris,
                rutas,
                portal,
            }
        }
        DragItem::Data { data, mime_types } => {
            let textos: Vec<String> = match data {
                SharedData::Fixed(t) => mime_types.iter().map(|_| t.clone()).collect(),
                SharedData::Map(m) => mime_types
                    .iter()
                    .map(|t| m.get(t).cloned().unwrap_or_default())
                    .collect(),
            };
            Contenido::Datos(
                mime_types
                    .into_iter()
                    .zip(textos)
                    .enumerate()
                    .map(|(i, (mime, texto))| (PRIMER_TARGET_PROPIO + i as u32, mime, texto))
                    .collect(),
            )
        }
    }
}

/// Las acciones que se le ofrecen al destino.
///
/// Un arrastre de copia ofrece sólo `COPY`. Esto importa especialmente para
/// navegadores: si también se ofrece `MOVE`, Firefox puede negociar un movimiento
/// para un archivo temporal aunque la página sólo necesita leerlo. Mantener la
/// transferencia como copia hace que el `File` expuesto a la página tenga la misma
/// semántica que un archivo arrastrado desde el gestor de archivos.
///
/// Un arrastre de movimiento también ofrece `COPY`: muchos editores y navegadores
/// no aceptan `MOVE`, y sin una acción en común el compositor cancela el arrastre.
pub fn acciones_de(modo: DragMode) -> DragAction {
    match modo {
        DragMode::Copy => DragAction::COPY,
        DragMode::Move => DragAction::COPY | DragAction::MOVE,
    }
}

/// Qué tipos se le ofrecen al destino, y con qué identificador cada uno.
///
/// Separado de armar la `TargetList` para poder probarlo: `Atom::intern` exige GTK
/// inicializado en el hilo principal, así que una prueba unitaria no puede tocarlo
/// — y esta lista es justo lo que decide si arrastrar a una terminal hace algo.
pub fn objetivos_de(contenido: &Contenido) -> Vec<(String, u32)> {
    match contenido {
        // El texto además de los URIs: un campo de texto o una terminal aceptan
        // `text/plain` y no `text/uri-list`. Ofreciendo sólo uno, arrastrar ahí no
        // hace nada.
        Contenido::Uris { portal, .. } => objetivos_de_uris(portal.is_some()),
        Contenido::Datos(entradas) => entradas
            .iter()
            .map(|(id, mime, _)| (mime.clone(), *id))
            .collect(),
    }
}

fn objetivos_de_uris(tiene_portal: bool) -> Vec<(String, u32)> {
    let mut objetivos = Vec::new();
    if tiene_portal {
        objetivos.extend([
            (
                "application/vnd.portal.filetransfer".to_string(),
                PORTAL_TRANSFER_TARGET_ID,
            ),
            (
                "application/vnd.portal.files".to_string(),
                PORTAL_FILES_TARGET_ID,
            ),
        ]);
    }
    objetivos.extend([
        ("text/uri-list".to_string(), URI_TARGET_ID),
        ("text/plain".to_string(), TEXT_TARGET_ID),
        ("text/plain;charset=utf-8".to_string(), TEXT_TARGET_ID),
    ]);
    objetivos
}

/// Registers the drag files with the desktop FileTransfer portal.
///
/// Firefox checks this Wayland-safe transfer before converting `text/uri-list`
/// itself. The latter works for ordinary uploads but can expose a short-lived
/// file object to an async page drop handler, which is exactly how ComfyUI reads
/// PNG metadata after the drop event has returned.
fn iniciar_transferencia_portal(
    rutas: &[PathBuf],
) -> std::result::Result<TransferenciaPortal, String> {
    if rutas.is_empty() {
        return Err("no hay archivos para registrar".into());
    }
    let connection = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)
        .map_err(|error| error.to_string())?;
    let start_options = glib::VariantDict::new(None);
    start_options.insert("writable", false);
    start_options.insert("autostop", true);
    let start_parameters = (start_options,).to_variant();
    let reply = connection
        .call_sync(
            Some(PORTAL_BUS),
            PORTAL_PATH,
            PORTAL_INTERFACE,
            "StartTransfer",
            Some(&start_parameters),
            None,
            gio::DBusCallFlags::NONE,
            2500,
            None::<&gio::Cancellable>,
        )
        .map_err(|error| error.to_string())?;
    let key = reply
        .get::<(String,)>()
        .map(|value| value.0)
        .ok_or_else(|| "StartTransfer devolvió una respuesta inválida".to_string())?;

    let add_result = (|| -> std::result::Result<(), String> {
        // Session buses commonly cap one message at roughly 16 descriptors. Keep
        // enough headroom for descriptors used internally by D-Bus itself.
        for lote in rutas.chunks(12) {
            let files = lote
                .iter()
                .map(|ruta| {
                    File::open(ruta).map_err(|error| format!("{}: {error}", ruta.display()))
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let handles = (0..files.len())
                .map(|index| glib::variant::Handle(index as i32))
                .collect::<Vec<_>>();
            // `from_array` constructs and owns the native GUnixFDList in one
            // operation. On newer GLib, the empty `new()` constructor can yield
            // a null object before descriptors are appended.
            let fd_list = gio::UnixFDList::from_array(files);
            let add_options = glib::VariantDict::new(None);
            let add_parameters = (key.as_str(), handles, add_options).to_variant();
            // gio-rs 0.18 incorrectly assumes the reply to
            // `call_with_unix_fd_list_sync` always includes an FD list. AddFiles
            // returns none, so that wrapper panics after a successful call. A
            // DBusMessage carries the outgoing list without making that
            // assumption about the reply.
            let message = gio::DBusMessage::new_method_call(
                Some(PORTAL_BUS),
                PORTAL_PATH,
                Some(PORTAL_INTERFACE),
                "AddFiles",
            );
            message.set_body(&add_parameters);
            message.set_unix_fd_list(Some(&fd_list));
            let (reply, _) = connection
                .send_message_with_reply_sync(
                    &message,
                    gio::DBusSendMessageFlags::NONE,
                    2500,
                    None::<&gio::Cancellable>,
                )
                .map_err(|error| error.to_string())?;
            if reply.message_type() == gio::DBusMessageType::Error {
                return Err(reply
                    .error_name()
                    .map(|name| name.to_string())
                    .unwrap_or_else(|| "AddFiles devolvió un error D-Bus".into()));
            }
        }
        Ok(())
    })();
    if let Err(error) = add_result {
        detener_transferencia_portal(&TransferenciaPortal {
            key: key.clone(),
            connection: connection.clone(),
        });
        return Err(error);
    }
    Ok(TransferenciaPortal { key, connection })
}

fn detener_transferencia_portal(portal: &TransferenciaPortal) {
    let parameters = (portal.key.as_str(),).to_variant();
    let _ = portal.connection.call_sync(
        Some(PORTAL_BUS),
        PORTAL_PATH,
        PORTAL_INTERFACE,
        "StopTransfer",
        Some(&parameters),
        None,
        gio::DBusCallFlags::NONE,
        1000,
        None::<&gio::Cancellable>,
    );
}

fn detener_portal_del_contenido(contenido: &Contenido) {
    if let Contenido::Uris {
        portal: Some(portal),
        ..
    } = contenido
    {
        detener_transferencia_portal(portal);
    }
}

/// La lista de objetivos que se le ofrece al destino.
fn lista_de_objetivos(contenido: &Contenido) -> gtk::TargetList {
    let lista = gtk::TargetList::new(&[]);
    for (mime, id) in objetivos_de(contenido) {
        lista.add(&gtk::gdk::Atom::intern(&mime), 0, id);
    }
    lista
}

/// El nombre de la acción que negoció el destino.
///
/// `MOVE` primero: si por algún motivo llegaran las dos, informar la más fuerte es
/// lo honesto. Igual no es esto lo que autoriza borrar —eso es `drag-data-delete`—
/// así que equivocarse acá no cuesta un archivo.
pub fn nombre_de_accion(accion: DragAction) -> Option<&'static str> {
    if accion.contains(DragAction::MOVE) {
        Some("move")
    } else if accion.contains(DragAction::COPY) {
        Some("copy")
    } else {
        None
    }
}

/// Si el origen tiene que sacar de su lugar lo que entregó.
///
/// **En Wayland no hay ninguna señal que lo pida.** `gtk_drag_finish(..., del=TRUE,
/// ...)` implementa el borrado pidiendo el target `DELETE` por el mecanismo de
/// selecciones de X11, que en Wayland no existe: el protocolo no tiene forma de
/// decirle al origen «borrá el original». Medido — el destino cerraba con
/// `borrar_origen=true` y `drag-data-delete` no llegaba nunca. Fiarse sólo de esa
/// señal es, en Wayland, no mover nunca.
///
/// Lo que sí hay es el par que define el protocolo: `wl_data_source.dnd_finished`
/// cuando el destino confirmó que recibió los datos, y `wl_data_source.cancelled`
/// cuando no. GTK los traduce a `drag-end` y `drag-failed`. Así que «terminó sin
/// fallar y la acción negociada fue mover» es exactamente «el destino se quedó con
/// esto y le toca al origen sacarlo de acá».
///
/// El fallo manda sobre todo lo demás: si el destino no se quedó con nada, borrar
/// sería perder un archivo que no está en ninguna otra parte.
pub fn debe_borrar_el_origen(fallo: bool, pidieron_borrar: bool, accion: DragAction) -> bool {
    if fallo {
        return false;
    }
    pidieron_borrar || accion.contains(DragAction::MOVE)
}

/// Avisa el final del arrastre una sola vez.
fn avisar(resultado: DragResult, accion: Option<DragAction>) {
    EN_CURSO.with(|c| {
        if let Some(curso) = c.borrow_mut().as_mut() {
            if curso.avisado {
                return;
            }
            curso.avisado = true;
            let borrar =
                accion.is_some_and(|a| debe_borrar_el_origen(curso.fallo, curso.piden_borrar, a));
            let _ = curso.canal.send(CallbackResult {
                result: resultado,
                action: accion.and_then(nombre_de_accion).map(str::to_string),
                source_should_delete: borrar,
                cursor_pos: curso.cursor.clone(),
            });
        }
    });
}

/// La marca que se le deja al widget para no engancharlo dos veces.
const MARCA_DE_ENGANCHE: &str = "vsk-dnd-enganchado";

fn pointer_moves_outward_at_edge(
    previous: (f64, f64),
    current: (f64, f64),
    width: f64,
    height: f64,
    margin: f64,
) -> bool {
    let margin = margin.max(0.0).min(width / 2.0).min(height / 2.0);
    let (previous_x, previous_y) = previous;
    let (x, y) = current;
    (x <= margin && x < previous_x)
        || (x >= width - margin && x > previous_x)
        || (y <= margin && y < previous_y)
        || (y >= height - margin && y > previous_y)
}

/// Pone los manejadores de un widget, una sola vez.
///
/// Se enganchan una vez y **nunca se desconectan**. La versión anterior los
/// conectaba en cada arrastre y sólo desconectaba algunos: el `drag-failed` se
/// filtraba, así que el enésimo arrastre cancelado mandaba N avisos. Y desconectar
/// `drag-data-get` al terminar era peor todavía, porque en Wayland el destino pide
/// los datos **después** del drop.
///
/// La marca va en el **widget** y no en la etiqueta de la ventana. Con la etiqueta,
/// si el WebKitWebView se reemplaza —una recarga, una ventana que se recrea con el
/// mismo nombre— la ventana ya figuraba como enganchada y el widget nuevo se
/// quedaba sin manejadores: el arrastre dejaba de funcionar sin que nada lo dijera.
fn enganchar(widget: &gtk::Widget) {
    // Seguro porque el dato se escribe y se lee siempre desde el hilo principal de
    // GTK, y el tipo es el mismo en los dos lados.
    let ya = unsafe { widget.data::<bool>(MARCA_DE_ENGANCHE).is_some() };
    if ya {
        return;
    }
    unsafe { widget.set_data(MARCA_DE_ENGANCHE, true) };

    // El que dispara. Es la única forma de que `drag_begin` corra dentro de un
    // evento, que es lo que Wayland exige.
    widget.connect_motion_notify_event(|w, evento| {
        let apretado = evento
            .state()
            .contains(gtk::gdk::ModifierType::BUTTON1_MASK);

        let esperando_disparo = ARMADO.with(|a| {
            let mut prestado = a.borrow_mut();
            let Some(armado) = prestado.as_mut() else {
                return false;
            };
            let (x, y) = evento.position();
            if armado.edge_threshold.is_none() {
                return armado.start_position.is_some_and(|(inicio_x, inicio_y)| {
                    !w.drag_check_threshold(
                        inicio_x.round() as i32,
                        inicio_y.round() as i32,
                        x.round() as i32,
                        y.round() as i32,
                    )
                });
            }
            let Some(margen) = armado.edge_threshold else {
                return false;
            };
            let asignacion = w.allocation();
            let actual = (x, y);
            let anterior = armado.last_position.replace(actual);
            !anterior.is_some_and(|previa| {
                pointer_moves_outward_at_edge(
                    previa,
                    actual,
                    f64::from(asignacion.width()),
                    f64::from(asignacion.height()),
                    margen,
                )
            })
        });
        if esperando_disparo {
            return gtk::glib::Propagation::Proceed;
        }

        let armado = ARMADO.with(|a| {
            if a.borrow().is_none() {
                return None;
            }
            // Sin el botón apretado no hay agarre implícito, así que el compositor
            // descartaría el arrastre. Se cancela y se avisa.
            if !apretado {
                return a.borrow_mut().take().map(Err);
            }
            a.borrow_mut().take().map(Ok)
        });

        match armado {
            None => {}
            Some(Err(perdido)) => {
                debug!("el botón se soltó antes de arrancar el arrastre");
                detener_portal_del_contenido(&perdido.contenido);
                let (x, y) = evento.root();
                let _ = perdido.canal.send(CallbackResult {
                    result: DragResult::Cancelled,
                    action: None,
                    source_should_delete: false,
                    cursor_pos: CursorPosition { x, y },
                });
            }
            Some(Ok(listo)) => {
                // La posición del evento que dispara el arrastre, en coordenadas de
                // pantalla: es la que sirve para ubicar algo donde está el puntero.
                let (x, y) = evento.root();
                arrancar(
                    w.upcast_ref::<gtk::Widget>(),
                    listo,
                    CursorPosition { x, y },
                    &**evento,
                )
            }
        }

        gtk::glib::Propagation::Proceed
    });

    // Sirve los datos cuando el destino los pide, que en Wayland es **después** del
    // drop. Queda conectado para siempre: desconectarlo al terminar el arrastre
    // dejaba la transferencia sin quien la atendiera y el destino recibía vacío.
    widget.connect_drag_data_get(|_, _, data, info, _| {
        EN_CURSO.with(|c| {
            let prestado = c.borrow();
            let Some(curso) = prestado.as_ref() else {
                warn!("piden datos de arrastre y no hay ninguno en curso");
                return;
            };
            // `set_text` y `set_uris` devuelven si pudieron. Ignorarlo es cómo se
            // llega a un arrastre que se ve bien y entrega vacío sin decir nada.
            let puesto = match &curso.contenido {
                Contenido::Uris {
                    uris,
                    rutas,
                    portal,
                } => match info {
                    URI_TARGET_ID => {
                        let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                        data.set_uris(&refs)
                    }
                    PORTAL_TRANSFER_TARGET_ID | PORTAL_FILES_TARGET_ID => {
                        if let Some(portal) = portal {
                            data.set(&data.target(), 8, portal.key.as_bytes());
                            true
                        } else {
                            false
                        }
                    }
                    // Las rutas tal cual, no los URIs: quien toma `text/plain` pega
                    // lo que recibe, y un URI codificado pegado no es un archivo.
                    TEXT_TARGET_ID => data.set_text(&uri::rutas_como_texto(rutas)),
                    otro => {
                        debug!("objetivo desconocido: {otro}");
                        return;
                    }
                },
                Contenido::Datos(entradas) => {
                    match entradas.iter().find(|(id, _, _)| *id == info) {
                        Some((_, _, texto)) => data.set_text(texto),
                        None => {
                            debug!("objetivo desconocido: {info}");
                            return;
                        }
                    }
                }
            };
            if puesto {
                debug!("datos entregados para el objetivo {info}");
            } else {
                warn!("no se pudieron poner los datos del arrastre (objetivo {info})");
            }
        });
    });

    widget.connect_drag_failed(|_, contexto, motivo| {
        // Se anota **antes** de avisar: `drag-failed` llega antes que `drag-end`, y
        // es lo único que distingue «el destino se quedó con esto» de «no pasó
        // nada». Sin la marca, un arrastre cancelado con la acción en mover haría
        // borrar un archivo que nadie copió a ninguna parte.
        EN_CURSO.with(|c| {
            if let Some(curso) = c.borrow_mut().as_mut() {
                curso.fallo = true;
            }
        });
        debug!(
            "arrastre cancelado: {motivo:?} (acción elegida {:?}, ofrecidas {:?})",
            contexto.selected_action(),
            contexto.actions()
        );
        avisar(DragResult::Cancelled, Some(contexto.selected_action()));
        gtk::glib::Propagation::Proceed
    });

    // El destino pidió el borrado del original: es la señal de que la entrega
    // salió bien y que el movimiento le toca al origen. Se anota y se informa en
    // `drag-end`; borrar archivos del usuario no es cosa de un plugin de arrastre.
    widget.connect_drag_data_delete(|_, _| {
        EN_CURSO.with(|c| {
            if let Some(curso) = c.borrow_mut().as_mut() {
                curso.piden_borrar = true;
            }
        });
        debug!("el destino pidió borrar el original (X11)");
    });

    // `drag-end` es el final de verdad, y llega **después** de que se entregaron
    // los datos. Acá sí se puede soltar todo.
    widget.connect_drag_end(|_, contexto| {
        let accion = contexto.selected_action();
        avisar(DragResult::Dropped, Some(accion));
        debug!(
            "¿hay que sacar el original de su lugar?: {}",
            EN_CURSO.with(
                |c| c.borrow().as_ref().is_some_and(|x| debe_borrar_el_origen(
                    x.fallo,
                    x.piden_borrar,
                    accion
                ))
            )
        );
        EN_CURSO.with(|c| {
            let terminado = c.borrow_mut().take();
            if let Some(terminado) = terminado {
                detener_portal_del_contenido(&terminado.contenido);
            }
        });
        debug!("arrastre terminado (acción {accion:?})");
    });
}

/// Arranca el arrastre. Corre **dentro** del manejador de movimiento.
fn arrancar(widget: &gtk::Widget, listo: Armado, cursor: CursorPosition, event: &gtk::gdk::Event) {
    let lista = lista_de_objetivos(&listo.contenido);
    let (start_x, start_y) = listo
        .start_position
        .map(|(x, y)| (x.round() as i32, y.round() as i32))
        .unwrap_or((-1, -1));

    EN_CURSO.with(|c| {
        *c.borrow_mut() = Some(EnCurso {
            contenido: listo.contenido.clone(),
            canal: listo.canal.clone(),
            cursor: cursor.clone(),
            avisado: false,
            piden_borrar: false,
            fallo: false,
        })
    });

    // Sin `drag_source_set`: no hace falta para `drag_begin`, y aplicárselo al
    // widget de WebKit le borra la configuración de arrastre que es suya.
    match widget.drag_begin_with_coordinates(&lista, listo.accion, 1, Some(event), start_x, start_y)
    {
        Some(contexto) => {
            if let Some(pixbuf) = listo.icono {
                contexto.drag_set_icon_pixbuf(&pixbuf, 0, 0);
            }
            let _ = listo.canal.send(CallbackResult {
                result: DragResult::Started,
                action: None,
                source_should_delete: false,
                cursor_pos: cursor,
            });
            info!(
                "arrastre iniciado (acciones ofrecidas {:?})",
                contexto.actions()
            );
        }
        None => {
            // No debería pasar desde acá, pero si pasa hay que decirlo: en silencio
            // parece que el arrastre salió y no llegó nunca.
            warn!("GTK no pudo iniciar el arrastre");
            avisar(DragResult::Cancelled, None);
            EN_CURSO.with(|c| {
                let fallido = c.borrow_mut().take();
                if let Some(fallido) = fallido {
                    detener_portal_del_contenido(&fallido.contenido);
                }
            });
        }
    }
}

/// Arma un arrastre para que lo dispare el próximo movimiento del ratón.
///
/// Se llama con el botón **todavía apretado**: es lo que hace que el compositor
/// acepte el arrastre. Si se soltó en el camino, se cancela y se avisa por el
/// canal en lugar de quedarse en silencio.
#[command]
pub async fn start_drag<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    item: DragItem,
    image: Option<Image>,
    options: Option<DragOptions>,
    on_event: Channel<CallbackResult>,
) -> Result<()> {
    let opts = options.unwrap_or_default();
    let etiqueta = window.label().to_string();
    let contenido = contenido_de(item);
    let accion = acciones_de(opts.mode);
    let edge_threshold = opts.edge_threshold.filter(|value| *value > 0.0);
    let start_position = opts.start_x.zip(opts.start_y);
    let last_position = start_position;

    let (tx, rx) = std::sync::mpsc::channel();

    app.run_on_main_thread(move || {
        let resultado = match window.gtk_window() {
            Ok(w) => {
                let widget = find_webview_widget(&w, &etiqueta).unwrap_or_else(|| {
                    warn!("no se encontró el WebKitWebView; se usa la ventana");
                    w.upcast::<gtk::Widget>()
                });
                enganchar(&widget);

                let icono = image.as_ref().and_then(|img| cargar_icono(&img.0));

                let ficha = PROXIMA_FICHA.with(|f| {
                    let mut f = f.borrow_mut();
                    *f += 1;
                    *f
                });

                ARMADO.with(|a| {
                    let anterior = a.borrow_mut().replace(Armado {
                        contenido,
                        icono,
                        accion,
                        edge_threshold,
                        start_position,
                        last_position,
                        canal: on_event.clone(),
                        ficha,
                    });
                    if let Some(anterior) = anterior {
                        detener_portal_del_contenido(&anterior.contenido);
                    }
                });

                // Si el movimiento no llega, no se queda armado esperando a un
                // gesto que nadie pidió.
                gtk::glib::timeout_add_local_once(
                    std::time::Duration::from_millis(VALIDEZ_DEL_ARMADO_MS as u64),
                    move || {
                        // Sólo se lleva el suyo: dentro de la ventana de validez
                        // puede haberse armado otro, y cancelarlo sería matar un
                        // arrastre que estaba a punto de dispararse.
                        let propio = ARMADO.with(|a| {
                            let coincide = a.borrow().as_ref().is_some_and(|x| x.ficha == ficha);
                            if coincide {
                                a.borrow_mut().take()
                            } else {
                                None
                            }
                        });
                        if let Some(perdido) = propio {
                            debug!("el arrastre armado venció sin que llegara un movimiento");
                            detener_portal_del_contenido(&perdido.contenido);
                            // Sin posición: venció sin que llegara ningún
                            // movimiento, así que no hubo evento del que sacarla.
                            let _ = perdido.canal.send(CallbackResult {
                                result: DragResult::Cancelled,
                                action: None,
                                source_should_delete: false,
                                cursor_pos: CursorPosition { x: 0.0, y: 0.0 },
                            });
                        }
                    },
                );

                Ok(())
            }
            Err(e) => Err(Error::Tauri(e)),
        };
        let _ = tx.send(resultado);
    })
    .map_err(Error::Tauri)?;

    rx.recv()
        .map_err(|e| Error::Drag(format!("drag result channel closed: {e}")))?
}

/// Cancels a drag that is waiting for an edge motion. An already-running native
/// drag is left to the compositor, which will report its normal final result.
#[command]
pub async fn cancel_drag<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        if let Some(cancelado) = ARMADO.with(|a| a.borrow_mut().take()) {
            detener_portal_del_contenido(&cancelado.contenido);
            let _ = cancelado.canal.send(CallbackResult {
                result: DragResult::Cancelled,
                action: None,
                source_should_delete: false,
                cursor_pos: CursorPosition { x: 0.0, y: 0.0 },
            });
        }
        let _ = tx.send(());
    })
    .map_err(Error::Tauri)?;
    rx.recv()
        .map_err(|e| Error::Drag(format!("drag cancellation channel closed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_umbral_nativo_exige_movimiento_hacia_afuera_en_los_cuatro_bordes() {
        assert!(pointer_moves_outward_at_edge(
            (9.0, 300.0),
            (4.0, 300.0),
            800.0,
            600.0,
            12.0
        ));
        assert!(pointer_moves_outward_at_edge(
            (790.0, 300.0),
            (796.0, 300.0),
            800.0,
            600.0,
            12.0
        ));
        assert!(pointer_moves_outward_at_edge(
            (400.0, 9.0),
            (400.0, 4.0),
            800.0,
            600.0,
            12.0
        ));
        assert!(pointer_moves_outward_at_edge(
            (400.0, 590.0),
            (400.0, 596.0),
            800.0,
            600.0,
            12.0
        ));
        assert!(!pointer_moves_outward_at_edge(
            (4.0, 300.0),
            (9.0, 300.0),
            800.0,
            600.0,
            12.0
        ));
        assert!(!pointer_moves_outward_at_edge(
            (400.0, 300.0),
            (405.0, 300.0),
            800.0,
            600.0,
            12.0
        ));
    }

    fn item(json: &str) -> DragItem {
        serde_json::from_str(json).expect("deserializa")
    }

    #[test]
    fn las_rutas_se_vuelven_uris_codificados() {
        // Antes salían como `file:///...` sin codificar, así que cualquier nombre
        // con un espacio era un URI inválido y el destino lo rechazaba.
        let c = contenido_de(item(r#"["/tmp/mi archivo.txt","/tmp/otro.png"]"#));
        match c {
            Contenido::Uris { uris, rutas, .. } => {
                assert_eq!(uris[0], "file:///tmp/mi%20archivo.txt");
                assert_eq!(uris[1], "file:///tmp/otro.png");
                // Y las rutas tal cual, que son las que van a `text/plain`.
                assert_eq!(rutas[0], std::path::PathBuf::from("/tmp/mi archivo.txt"));
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn una_ruta_que_no_da_uri_se_descarta_sin_llevarse_las_demas() {
        // Una relativa no sirve para un `text/uri-list`, pero perder el arrastre
        // entero por una sería peor.
        let c = contenido_de(item(r#"["relativa.txt","/tmp/buena.png"]"#));
        match c {
            Contenido::Uris { uris, rutas, .. } => {
                assert_eq!(uris, vec!["file:///tmp/buena.png".to_string()]);
                // Las dos listas quedan alineadas: si no, `text/plain` entregaría
                // la ruta de un archivo distinto del que dice `text/uri-list`.
                assert_eq!(rutas, vec![std::path::PathBuf::from("/tmp/buena.png")]);
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn los_datos_sueltos_se_entregan_de_verdad() {
        // La API de JS los ofrecía y el lado Rust los convertía en `None`: el
        // arrastre salía sin ningún contenido.
        let c = contenido_de(item(
            r#"{"data":"hola","types":["text/plain","text/html"]}"#,
        ));
        match c {
            Contenido::Datos(e) => {
                assert_eq!(e.len(), 2);
                assert_eq!(
                    e[0],
                    (PRIMER_TARGET_PROPIO, "text/plain".into(), "hola".into())
                );
                assert_eq!(
                    e[1],
                    (PRIMER_TARGET_PROPIO + 1, "text/html".into(), "hola".into())
                );
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn un_mapa_de_datos_le_da_a_cada_tipo_lo_suyo() {
        let c = contenido_de(item(
            r#"{"data":{"text/plain":"llano","text/html":"<b>rico</b>"},"types":["text/plain","text/html"]}"#,
        ));
        match c {
            Contenido::Datos(e) => {
                assert_eq!(e[0].2, "llano");
                assert_eq!(e[1].2, "<b>rico</b>");
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn un_tipo_sin_datos_en_el_mapa_no_rompe_el_arrastre() {
        let c = contenido_de(item(
            r#"{"data":{"text/plain":"llano"},"types":["text/plain","text/html"]}"#,
        ));
        match c {
            Contenido::Datos(e) => {
                assert_eq!(e[0].2, "llano");
                assert_eq!(e[1].2, "", "vacío, no ausente");
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[test]
    fn los_identificadores_propios_no_chocan_con_los_de_archivos() {
        // Si un tipo propio reusara el identificador de `text/uri-list`, el destino
        // pediría archivos y `drag-data-get` le entregaría texto.
        let c = contenido_de(item(
            r#"{"data":"x","types":["a/1","a/2","a/3","a/4","a/5"]}"#,
        ));
        let reservados = [URI_TARGET_ID, TEXT_TARGET_ID];
        for (mime, id) in objetivos_de(&c) {
            assert!(
                !reservados.contains(&id),
                "{mime} reusa el identificador {id}"
            );
        }
    }

    #[test]
    fn los_objetivos_de_archivos_incluyen_texto_para_quien_no_entiende_uris() {
        // Un campo de texto o una terminal aceptan `text/plain` y no
        // `text/uri-list`; sin ofrecer los dos, arrastrar a una terminal no hace
        // nada.
        let objetivos = objetivos_de(&Contenido::Uris {
            uris: vec!["file:///a".into()],
            rutas: vec![std::path::PathBuf::from("/a")],
            portal: None,
        });
        let id_de = |n: &str| objetivos.iter().find(|(m, _)| m == n).map(|(_, i)| *i);
        assert_eq!(id_de("text/uri-list"), Some(URI_TARGET_ID));
        assert_eq!(id_de("text/plain"), Some(TEXT_TARGET_ID));
        assert_eq!(id_de("text/plain;charset=utf-8"), Some(TEXT_TARGET_ID));
        assert_eq!(id_de("application/vnd.portal.filetransfer"), None);
        assert_eq!(id_de("application/vnd.portal.files"), None);
    }

    #[test]
    fn los_objetivos_de_archivos_incluyen_el_portal_cuando_hay_transferencia() {
        let objetivos = objetivos_de_uris(true);
        let id_de = |n: &str| objetivos.iter().find(|(m, _)| m == n).map(|(_, i)| *i);
        assert_eq!(
            id_de("application/vnd.portal.filetransfer"),
            Some(PORTAL_TRANSFER_TARGET_ID)
        );
        assert_eq!(
            id_de("application/vnd.portal.files"),
            Some(PORTAL_FILES_TARGET_ID)
        );
        assert_eq!(id_de("text/uri-list"), Some(URI_TARGET_ID));
    }

    #[test]
    #[ignore = "requires the user's live XDG desktop portal session"]
    fn el_portal_registra_y_recupera_un_archivo_real() {
        let ruta = std::env::temp_dir().join(format!(
            "phoenix-portal-test-{}-{}.png",
            std::process::id(),
            std::thread::current().name().unwrap_or("thread")
        ));
        std::fs::write(&ruta, b"portal test").expect("create portal test file");
        let portal = iniciar_transferencia_portal(std::slice::from_ref(&ruta))
            .expect("register the file with FileTransfer");
        assert!(!portal.key.is_empty());
        // The portal deliberately rejects retrieval by the transfer's owner.
        // A separate gdbus process has its own unique bus name, just like the
        // receiving Firefox process.
        let output = std::process::Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest",
                PORTAL_BUS,
                "--object-path",
                PORTAL_PATH,
                "--method",
                "org.freedesktop.portal.FileTransfer.RetrieveFiles",
                &portal.key,
                "{}",
            ])
            .output()
            .expect("run independent portal receiver");
        assert!(
            output.status.success(),
            "RetrieveFiles failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(
                ruta.file_name()
                    .expect("test filename")
                    .to_string_lossy()
                    .as_ref()
            ),
            "RetrieveFiles did not return the registered file: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        std::fs::remove_file(ruta).expect("remove portal test file");
    }

    #[test]
    fn los_objetivos_de_datos_son_los_tipos_que_se_pidieron() {
        let c = contenido_de(item(r#"{"data":"x","types":["application/x-vasak"]}"#));
        let objetivos = objetivos_de(&c);
        assert_eq!(
            objetivos,
            vec![("application/x-vasak".to_string(), PRIMER_TARGET_PROPIO)]
        );
        // Y no se ofrece `text/uri-list`, que prometería archivos que no hay.
        assert!(!objetivos.iter().any(|(m, _)| m == "text/uri-list"));
    }

    #[test]
    #[ignore = "GDK image loading is unavailable in the headless test environment"]
    fn una_ruta_de_icono_se_carga_como_ruta_y_no_como_base64() {
        // El defecto original: `Image` es untagged con dos variantes de `String`,
        // así que una ruta entraba como `Base64`, la decodificación fallaba y el
        // arrastre nunca tenía icono. Ahora decide el contenido.
        let base = std::env::temp_dir().join(format!("dnd-icono-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        let png = base.join("icono.png");

        // Un PNG de 1x1 de verdad: `PixbufLoader` rechaza cualquier otra cosa.
        let bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&png, &bytes).unwrap();

        assert!(cargar_icono(png.to_str().unwrap()).is_some(), "por ruta");

        // Y en base64 también, que es la otra forma que ofrece la API.
        let en_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        assert!(cargar_icono(&en_base64).is_some(), "en base64");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn un_icono_que_no_existe_no_rompe_el_arrastre() {
        // El gestor de archivos pedía `icons/32x32.png`, un archivo que no está en
        // el paquete. Sin icono se arrastra igual.
        assert!(cargar_icono("/no/existe/icono.png").is_none());
        assert!(cargar_icono("").is_none());
        assert!(cargar_icono("no-es-base64-ni-ruta!!").is_none());
    }

    #[test]
    fn copiar_no_ofrece_un_movimiento_al_navegador() {
        let a = acciones_de(DragMode::Copy);
        assert_eq!(a, DragAction::COPY);
    }

    #[test]
    fn mover_conserva_copia_como_alternativa() {
        let a = acciones_de(DragMode::Move);
        assert!(a.contains(DragAction::COPY));
        assert!(a.contains(DragAction::MOVE));
    }

    #[test]
    fn no_se_ofrece_una_accion_que_no_sabemos_cumplir() {
        // `LINK` haría que el destino cree un enlace simbólico esperando que el
        // origen colabore, y no hay nada de eso implementado.
        let a = acciones_de(DragMode::Copy);
        assert!(!a.contains(DragAction::LINK));
        assert!(!a.contains(DragAction::ASK));
    }

    #[test]
    fn la_accion_informada_es_la_que_negocio_el_destino() {
        assert_eq!(nombre_de_accion(DragAction::COPY), Some("copy"));
        assert_eq!(nombre_de_accion(DragAction::MOVE), Some("move"));
        assert_eq!(nombre_de_accion(DragAction::empty()), None);
    }

    #[test]
    fn con_las_dos_puestas_se_informa_la_mas_fuerte() {
        // No debería pasar —el destino elige una— pero informar «copy» cuando hubo
        // un movimiento dejaría el original donde estaba sin que nada lo dijera.
        assert_eq!(
            nombre_de_accion(DragAction::COPY | DragAction::MOVE),
            Some("move")
        );
    }

    #[test]
    fn una_accion_que_no_ofrecemos_no_se_informa_como_nuestra() {
        // `LINK` y `ASK` no se ofrecen; si llegaran, no son ni copiar ni mover.
        assert_eq!(nombre_de_accion(DragAction::LINK), None);
        assert_eq!(nombre_de_accion(DragAction::ASK), None);
    }

    #[test]
    fn cada_armado_lleva_su_propia_ficha() {
        // Sin ficha, dos arrastres armados dentro de la ventana de validez chocan:
        // el temporizador del primero se lleva puesto el segundo, que estaba a
        // punto de dispararse, y el arrastre se cancela sin motivo aparente.
        let a = PROXIMA_FICHA.with(|f| {
            let mut f = f.borrow_mut();
            *f += 1;
            *f
        });
        let b = PROXIMA_FICHA.with(|f| {
            let mut f = f.borrow_mut();
            *f += 1;
            *f
        });
        assert_ne!(a, b);
        assert!(b > a, "las fichas no se reusan");
    }

    #[test]
    fn un_arrastre_que_fallo_nunca_borra() {
        // Lo primero y lo más importante: si el destino no se quedó con nada,
        // borrar sería perder un archivo que no está en ninguna otra parte. El
        // fallo manda incluso sobre un pedido explícito de borrado.
        assert!(!debe_borrar_el_origen(true, false, DragAction::MOVE));
        assert!(!debe_borrar_el_origen(true, true, DragAction::MOVE));
        assert!(!debe_borrar_el_origen(true, false, DragAction::COPY));
    }

    #[test]
    fn mover_sin_fallo_saca_el_original_de_su_lugar() {
        // En Wayland no hay ninguna señal que pida el borrado: `drag-data-delete`
        // no se emite. Lo que hay es `dnd_finished` contra `cancelled`, que GTK
        // traduce a `drag-end` contra `drag-failed`. Medido: sin esto, mover no
        // movía nunca.
        assert!(debe_borrar_el_origen(false, false, DragAction::MOVE));
    }

    #[test]
    fn copiar_deja_el_original_donde_esta() {
        assert!(!debe_borrar_el_origen(false, false, DragAction::COPY));
        assert!(!debe_borrar_el_origen(false, false, DragAction::empty()));
    }

    #[test]
    fn el_pedido_explicito_de_x11_sigue_valiendo() {
        // En X11 `drag-data-delete` sí llega, y es más explícito que deducirlo de
        // la acción: si llega, se respeta.
        assert!(debe_borrar_el_origen(false, true, DragAction::COPY));
    }
}
