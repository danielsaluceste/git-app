//! Linux-specific bootstrap for the Chromium Embedded Framework runtime.
//!
//! `libcef` resolves the C library's `close` symbol with `dlsym(RTLD_NEXT, "close")`
//! while it adjusts the OOM score during startup. That only works when `libcef.so`
//! comes *before* `libc.so.6` in the process' link map, which is not the order a
//! Rust binary gets: our `DT_NEEDED` list starts with libc, so the lookup fails
//! and Chromium aborts with `close symbol missing`.
//!
//! The reliable workaround is to put `libcef.so` in `LD_PRELOAD`, which makes the
//! dynamic loader map it before every other dependency. Since `LD_PRELOAD` splits
//! on spaces, a preload path taken straight from the binary directory (which may
//! live under a path with spaces, like `~/Área de trabalho/...`) would break, so we
//! re-execute ourselves with a symlink to `libcef.so` in a space-free directory.
//!
//! `libcef` also derives its resources directory from the *preloaded* library's
//! location, so the rest of the runtime files are exposed there through symlinks
//! as well.

/// Environment variable set on the re-executed process so the bootstrap runs once.
const PRELOAD_MARKER: &str = "GITLUNA_CEF_PRELOADED";

/// CEF runtime files shipped next to the executable that must be reachable from the
/// preload directory (libcef resolves them relative to its own location).
#[cfg(target_os = "linux")]
const RUNTIME_FILES: &[&str] = &[
    "libcef.so",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
    "chrome-sandbox",
    "locales",
];

/// Re-executes the application with `libcef.so` preloaded. No-op on other platforms,
/// on Chromium helper processes (which inherit the environment) and once preloaded.
pub fn ensure_preloaded() {
    #[cfg(target_os = "linux")]
    linux::ensure_preloaded();
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{PRELOAD_MARKER, RUNTIME_FILES};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};

    pub fn ensure_preloaded() {
        if std::env::var_os(PRELOAD_MARKER).is_some() {
            return;
        }

        let Some(exe) = std::env::current_exe().ok() else {
            return;
        };
        let Some(exe_dir) = exe.parent() else {
            return;
        };
        if !exe_dir.join("libcef.so").is_file() {
            // Nothing to preload: let CEF report the missing runtime itself.
            return;
        }

        let dir = preload_dir();
        if let Err(err) = std::fs::create_dir_all(&dir) {
            eprintln!("GitLuna: could not create {}: {err}", dir.display());
            return;
        }
        for name in RUNTIME_FILES {
            link(exe_dir, &dir, name);
        }

        let preload = dir.join("libcef.so");
        let mut value = preload.clone().into_os_string();
        if let Some(existing) = std::env::var_os("LD_PRELOAD") {
            if !existing.is_empty() {
                value.push(" ");
                value.push(existing);
            }
        }

        // `exec` keeps the process id, so dev tooling that watches the child keeps working.
        let err = std::process::Command::new(&exe)
            .args(std::env::args_os().skip(1))
            .env("LD_PRELOAD", value)
            .env(PRELOAD_MARKER, "1")
            .exec();
        eprintln!("GitLuna: could not re-exec with CEF preloaded: {err}");
    }

    /// Directory used to expose `libcef.so` and its resources under a path without spaces.
    fn preload_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        if dir.to_string_lossy().contains(char::is_whitespace) {
            dir = PathBuf::from("/tmp");
        }
        dir.join("gitluna-cef-preload")
    }

    /// Creates (or refreshes) a symlink `dir/name -> source_dir/name`, if the source exists.
    fn link(source_dir: &Path, dir: &Path, name: &str) {
        let source = source_dir.join(name);
        if !source.exists() {
            return;
        }
        let target = dir.join(name);
        let _ = std::fs::remove_file(&target);
        if let Err(err) = std::os::unix::fs::symlink(&source, &target) {
            eprintln!(
                "GitLuna: could not link {} -> {}: {err}",
                target.display(),
                source.display()
            );
        }
    }
}
