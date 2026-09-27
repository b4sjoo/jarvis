fn main() {
    dotenv::dotenv().ok();
    #[cfg(feature = "native-app-smoke")]
    validate_smoke_frontend();
    #[cfg(target_os = "macos")]
    build_macos_preparation_ocr();
    tauri_build::build()
}

#[cfg(feature = "native-app-smoke")]
fn validate_smoke_frontend() {
    println!("cargo:rerun-if-env-changed=JARVIS_NATIVE_SMOKE_BUILD_ID");
    println!("cargo:rerun-if-env-changed=JARVIS_NATIVE_SMOKE_FRONTEND");
    let id = std::env::var("JARVIS_NATIVE_SMOKE_BUILD_ID").expect("Smoke build ID required");
    let frontend = std::env::var("JARVIS_NATIVE_SMOKE_FRONTEND").expect("Smoke frontend required");
    let marker = std::path::Path::new(&frontend).join("native-smoke-build-id.txt");
    println!("cargo:rerun-if-changed={}", marker.display());
    assert!(!id.is_empty(), "Empty smoke build ID");
    assert_eq!(
        std::fs::read_to_string(marker).expect("Smoke frontend missing"),
        id,
        "Native and frontend smoke build identities differ"
    );
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
