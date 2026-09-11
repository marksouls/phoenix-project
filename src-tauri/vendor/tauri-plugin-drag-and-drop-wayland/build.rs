const COMMANDS: &[&str] = &["start_drag", "cancel_drag"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
