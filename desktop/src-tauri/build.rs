use std::{
    env,
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

fn main() {
    tauri_build::build();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let payload_dir = manifest_dir.join("payload");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let archive_path = out_dir.join("payload.tar.zst");

    println!("cargo:rerun-if-changed={}", payload_dir.display());
    create_payload_archive(&payload_dir, &archive_path).expect("failed to create payload archive");
}

fn create_payload_archive(payload_dir: &Path, archive_path: &Path) -> io::Result<()> {
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file = File::create(archive_path)?;
    let encoder = zstd::Encoder::new(file, 19)?;
    let mut tar = tar::Builder::new(encoder.auto_finish());

    if payload_dir.exists() {
        append_dir(&mut tar, payload_dir, payload_dir)?;
    }

    tar.finish()
}

fn append_dir<W: io::Write>(
    tar: &mut tar::Builder<W>,
    root: &Path,
    current: &Path,
) -> io::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path.strip_prefix(root).expect("payload child should be relative");

        if path.is_dir() {
            tar.append_dir(relative, &path)?;
            append_dir(tar, root, &path)?;
        } else if entry.file_name() != ".gitkeep" {
            tar.append_path_with_name(&path, relative)?;
        }
    }

    Ok(())
}
