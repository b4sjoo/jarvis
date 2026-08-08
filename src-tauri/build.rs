fn main() {
    dotenv::dotenv().ok();
    #[cfg(target_os = "macos")]
    build_macos_preparation_ocr();
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn build_macos_preparation_ocr() {
    println!("cargo:rerun-if-changed=native/macos/preparation_ocr.m");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=PDFKit");
    println!("cargo:rustc-link-lib=framework=Vision");
    cc::Build::new()
        .file("native/macos/preparation_ocr.m")
        .flag("-fobjc-arc")
        .compile("jarvis_preparation_ocr");
}
