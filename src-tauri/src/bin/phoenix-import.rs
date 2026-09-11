use phoenix_project_lib::library::Library;
use std::path::PathBuf;

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let source = arguments.next().map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("Usage: phoenix-import <source-directory> <library.phoenixlib>");
        std::process::exit(2);
    });
    let destination = arguments.next().map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("Usage: phoenix-import <source-directory> <library.phoenixlib>");
        std::process::exit(2);
    });

    let result = Library::open(destination.clone(), None)
        .and_then(|library| library.import_directory(&source));
    match result {
        Ok(summary) => {
            println!(
                "Imported {} of {} items ({} duplicates, {} failed) into {}",
                summary.imported,
                summary.discovered,
                summary.duplicates,
                summary.failed.len(),
                destination.display()
            );
            for failure in summary.failed {
                eprintln!("{failure}");
            }
        }
        Err(error) => {
            eprintln!("Import failed: {error}");
            std::process::exit(1);
        }
    }
}
