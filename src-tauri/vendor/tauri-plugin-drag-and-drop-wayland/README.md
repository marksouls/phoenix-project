# tauri-plugin-drag-and-drop-wayland

Plugin de Tauri para iniciar operaciones de arrastrar y soltar (drag & drop) en Wayland utilizando GTK GDK drag.

## Requisitos

- Tauri 2.x
- Linux con Wayland
- GTK3 (desarrollo)
- Soporte de WebKitGTK

## Instalación

### 1. Agregar el crate a Rust

```toml
[dependencies]
tauri-plugin-drag-and-drop-wayland = "2.1"
```

### 2. Agregar el plugin en `lib.rs`

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag_and_drop_wayland::init())
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}
```

### 3. Agregar el paquete npm (frontend)

```bash
npm install @vasakgroup/plugin-drag-and-drop-wayland
```

## Uso

```typescript
import { startDrag } from "@vasakgroup/plugin-drag-and-drop-wayland";

// Arrastrar archivos
await startDrag(
  ["/ruta/al/archivo1.txt", "/ruta/al/archivo2.txt"],
  "data:image/png;base64,iVBOR...",
  { mode: "copy" },
  (payload) => {
    console.log("Resultado:", payload.result);
    console.log("Posición:", payload.cursorPos);
  }
);
```

## API

### `startDrag(item, icon?, options?, onEvent?)`

Inicia una operación de arrastre.

**Parámetros:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `item` | `string[] \| { data: string \| Record<string, string>, types: string[] }` | Rutas de archivos o datos para arrastrar |
| `icon` | `string` (opcional) | Icono a mostrar durante el arrastre (base64 o ruta) |
| `options` | `{ mode?: "copy" \| "move" }` (opcional) | Opciones de arrastre |
| `onEvent` | `(payload: CallbackPayload) => void` (opcional) | Callback para eventos de resultado |

**`CallbackPayload`:**

```typescript
{
  result: "Dropped" | "Cancelled";
  cursorPos: { x: number; y: number };
}
```

## Permisos

Agrega el permiso en `tauri.conf.json`:

```json
{
  "permissions": ["drag-and-drop-wayland:default"]
}
```

## Cómo funciona

El plugin utiliza GDK drag de GTK para iniciar operaciones de arrastre nativas en Wayland. Cuando se invoca `start_drag`:

1. Busca el widget `WebKitWebView` dentro de la ventana de Tauri
2. Configura el widget como fuente de arrastre con los targets apropiados (URI para archivos, texto para datos)
3. Inicia la operación de arrastre con GDK
4. Reporta eventos de resultado (soltado/cancelado) a través de un canal Tauri

## Rendimiento

| Aspecto | Mejora |
|---------|--------|
| Búsqueda de widget | Caché por ventana para evitar recorrer el árbol GTK en cada arrastre |
| Clonación de rutas | Las rutas se pasan por ownership, eliminando clonaciones duplicadas |
| Manejo de errores | Los canales utilizan `?` en lugar de `unwrap()` para evitar panics |
| Decodificación de imagen | Se utiliza el engine estándar de base64, que es un singleton estático |

## Licencia

GPL-3.0-or-later
