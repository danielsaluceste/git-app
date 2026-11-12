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

/// Removes Chromium's unused GLib work source from the default main context.
///
/// With `external_message_pump`, CEF runs the UI thread on `MessagePumpExternal`,
/// but `base::MessagePumpGlib` still attaches its work source from its
/// constructor. Since `MessagePumpGlib::Run` never executes, `state_` stays null,
/// `WorkSourcePrepare` keeps returning a 0 ms timeout and the GTK loop spins at
/// 100% of one core while idle. This is a known issue:
/// <https://github.com/tauri-apps/tauri/issues/16189>.
///
/// Must run on the thread that owns the default GLib context, after CEF is
/// initialized. Returns how many sources were destroyed.
pub fn destroy_chromium_work_source() -> usize {
    #[cfg(target_os = "linux")]
    {
        linux::destroy_chromium_work_source()
    }

    #[cfg(not(target_os = "linux"))]
    {
        0
    }
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

    /// Destroys the work source Chromium's `MessagePumpGlib` attached to the
    /// default GLib context. See [`super::destroy_chromium_work_source`].
    pub fn destroy_chromium_work_source() -> usize {
        use glib_sys as ffi;
        use std::ffi::c_void;
        use std::mem;

        let Some(cef_base) = libcef_base() else {
            return 0;
        };

        let mut destroyed = 0;
        unsafe {
            let context = ffi::g_main_context_default();
            if context.is_null() {
                return 0;
            }

            // Source ids are allocated in sequence; a fresh attach yields the next id.
            let probe = ffi::g_idle_source_new();
            if probe.is_null() {
                return 0;
            }
            let upper = ffi::g_source_attach(probe, context);
            ffi::g_source_destroy(probe);
            ffi::g_source_unref(probe);

            for id in 1..upper {
                let source = ffi::g_main_context_find_source_by_id(context, id);
                if source.is_null() {
                    continue;
                }

                let funcs = (*source).source_funcs;
                if funcs.is_null() {
                    continue;
                }

                let Some(prepare) = (*funcs).prepare else {
                    continue;
                };

                if module_base(prepare as *const c_void) != Some(cef_base) {
                    continue;
                }

                if ffi::g_source_get_priority(source) != ffi::G_PRIORITY_DEFAULT_IDLE {
                    continue;
                }

                // Chromium's work source polls a single pipe (its wakeup pipe).
                // The X11 event source polls a socket and is left untouched.
                let poll_fds = (*source).poll_fds;
                if poll_fds.is_null() || !(*poll_fds).next.is_null() {
                    continue;
                }

                let fd = (*(*poll_fds).data.cast::<ffi::GPollFD>()).fd;
                let mut stat: libc::stat = mem::zeroed();
                if libc::fstat(fd, &mut stat) != 0 {
                    continue;
                }
                if (stat.st_mode & libc::S_IFMT) != libc::S_IFIFO {
                    continue;
                }

                ffi::g_source_destroy(source);
                destroyed += 1;
            }
        }

        destroyed
    }

    fn module_base(address: *const std::ffi::c_void) -> Option<*mut std::ffi::c_void> {
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        let found = unsafe { libc::dladdr(address, &mut info) };

        (found != 0).then_some(info.dli_fbase)
    }

    fn libcef_base() -> Option<*mut std::ffi::c_void> {
        let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
        let mut base: Option<usize> = None;

        for line in maps.lines() {
            if !line.contains("/libcef.so") {
                continue;
            }

            let start = line.split('-').next()?;
            let address = usize::from_str_radix(start.trim(), 16).ok()?;
            base = Some(base.map_or(address, |current| current.min(address)));
        }

        base.map(|address| address as *mut std::ffi::c_void)
    }
}
