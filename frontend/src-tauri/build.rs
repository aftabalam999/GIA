use std::env;
use std::path::Path;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("apple-darwin") {
        if let Ok(plist_path) = Path::new("Info.plist").canonicalize() {
            println!("cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}", plist_path.display());
            println!("cargo:rerun-if-changed=Info.plist");
        }
    }
    tauri_build::build();
}
