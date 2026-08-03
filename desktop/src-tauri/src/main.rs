use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_APP_URL: &str = "http://localhost:4000";
const LOCAL_HEALTH_HOST: &str = "127.0.0.1";
const LOCAL_HEALTH_PORT: u16 = 4000;
const DEFAULT_BACK_URL: &str =
    "https://gym-conversion-tracker-437354431924.southamerica-east1.run.app";
const DEFAULT_FRONT_URL: &str = "https://nice-pebble-04842d70f.7.azurestaticapps.net";
/// The first launch after an update pays for the antivirus scanning the freshly
/// extracted bridge binary, which can take minutes on an older disk.
const COLD_START_TIMEOUT: Duration = Duration::from_secs(180);
const WARM_START_TIMEOUT: Duration = Duration::from_secs(45);
const LATE_BRIDGE_WATCH: Duration = Duration::from_secs(300);
const RUNTIME_MARKER: &[u8] =
    concat!("front-remote-v1:", env!("SKYFIT_PAYLOAD_FINGERPRINT")).as_bytes();
const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.tar.zst"));
const SHORTCUT_NAME: &str = "Skyfit EVO.lnk";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Default)]
struct BridgeState(Arc<Mutex<Option<Child>>>);

struct Runtime {
    dir: PathBuf,
    extracted: bool,
}

enum BridgeStartup {
    Ready,
    Exited(ExitStatus),
    TimedOut,
}

#[derive(Deserialize)]
struct LatestResponse {
    configured: bool,
    latest: Option<LatestBuild>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestBuild {
    version: String,
    download_url: String,
    sha256: Option<String>,
}

fn main() {
    let bridge_state = BridgeState::default();
    let bridge_state_for_setup = bridge_state.clone();
    let bridge_state_for_exit = bridge_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app
                .get_webview_window("main")
                .or_else(|| app.get_webview_window("splash"))
            {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(bridge_state.clone())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let state = bridge_state_for_setup.clone();
            thread::spawn(move || {
                if let Err(error) = start_desktop(app_handle.clone(), state) {
                    set_splash_message(&app_handle, &error, true);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(move |_app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_bridge(&bridge_state_for_exit);
            }
        });
}

fn start_desktop(app: tauri::AppHandle, state: BridgeState) -> Result<(), String> {
    // install_app() finishes by pruning every other exe from the app dir — the same
    // directory the update download lands in — so it has to complete before the update
    // check, otherwise a fast download can be deleted right before the relaunch.
    let install = thread::spawn(install_app);

    tag_splash_version(&app);
    set_splash_message(&app, "Verificando atualizações...", false);
    let _ = install.join();
    if maybe_apply_update(&app)? {
        // A detached helper will start the new build after this process exits.
        app.exit(0);
        return Ok(());
    }

    set_splash_message(
        &app,
        "Procurando aplicativo local em localhost:4000...",
        false,
    );
    if local_bridge_ready() {
        open_main_window(&app, LOCAL_APP_URL)?;
        close_splash(&app);
        return Ok(());
    }

    set_splash_message(&app, "Extraindo runtime local...", false);
    let runtime = extract_payload().map_err(|error| error.to_string())?;
    let log_dir = data_dir().join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;

    set_splash_message(&app, "Iniciando bridge local na porta 4000...", false);
    let bridge = spawn_bridge(&runtime.dir, &log_dir).map_err(|error| error.to_string())?;
    {
        let mut current = state
            .0
            .lock()
            .map_err(|_| "Falha ao controlar o bridge.".to_string())?;
        *current = Some(bridge);
    }

    let timeout = if runtime.extracted {
        COLD_START_TIMEOUT
    } else {
        WARM_START_TIMEOUT
    };

    // A bridge that crashed will never come back, so only a timeout is worth watching for later.
    let (failure, may_start_late) = match wait_for_local_bridge(&app, &state, timeout) {
        BridgeStartup::Ready => {
            open_main_window(&app, LOCAL_APP_URL)?;
            close_splash(&app);
            return Ok(());
        }
        BridgeStartup::Exited(status) => (describe_exit(status), false),
        BridgeStartup::TimedOut => (
            format!("não respondeu em {} segundos", timeout.as_secs()),
            true,
        ),
    };

    let details = read_log_tail(&log_dir.join("bridge.err.log")).unwrap_or_default();
    let mut message = format!("Bridge local indisponível: {failure}.\nAbrindo o front remoto...");
    if !details.trim().is_empty() {
        message.push_str("\n\n");
        message.push_str(details.trim());
    }
    set_splash_message(&app, &message, true);
    thread::sleep(Duration::from_secs(5));
    open_main_window(&app, configured_front_url())?;
    close_splash(&app);

    if may_start_late {
        watch_for_late_bridge(app);
    }

    Ok(())
}

/// Installs a versioned copy under LocalAppData and (re)creates the desktop shortcut.
fn install_app() {
    let Ok(current) = env::current_exe() else {
        return;
    };
    let installed = installed_exe_path(APP_VERSION);
    if let Some(parent) = installed.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let current_canon = current.canonicalize().ok();
    let installed_canon = installed.canonicalize().ok();
    if current_canon.as_ref() != installed_canon.as_ref() {
        let _ = fs::copy(&current, &installed);
    }

    let target = if installed.exists() {
        installed
    } else {
        current
    };
    let _ = create_desktop_shortcut(&target);
    prune_old_installs(&target);
}

fn maybe_apply_update(app: &tauri::AppHandle) -> Result<bool, String> {
    let response = match fetch_latest_build() {
        Ok(value) => value,
        Err(error) => {
            report_update_problem(app, &format!("Falha ao verificar atualizações: {error}"));
            return Ok(false);
        }
    };

    if !response.configured {
        report_update_problem(
            app,
            "O servidor não está configurado para distribuir atualizações",
        );
        return Ok(false);
    }

    let Some(build) = response.latest else {
        return Ok(false);
    };
    if compare_versions(&build.version, APP_VERSION) <= 0 {
        return Ok(false);
    }

    let destination = installed_exe_path(&build.version);
    // A build published under a version its binary does not report (a relabelled exe)
    // would download itself, relaunch, and find the same "update" again forever.
    if is_current_exe(&destination) {
        report_update_problem(
            app,
            &format!(
                "A build {} publicada é a que já está em execução (o binário reporta {APP_VERSION})",
                build.version
            ),
        );
        return Ok(false);
    }

    set_splash_message(
        app,
        &format!("Baixando atualização {}...", build.version),
        false,
    );
    download_build(&build, &destination)?;
    // The shortcut is cosmetic and install_app retries it on every launch, so a failure
    // here must not abort the update and leave the app stuck on the splash.
    let _ = create_desktop_shortcut(&destination);

    set_splash_message(app, "Reiniciando na nova versão...", false);
    schedule_relaunch(&destination, std::process::id())?;
    Ok(true)
}

fn fetch_latest_build() -> Result<LatestResponse, String> {
    let url = format!("{}/api/desktop/latest", configured_back_url());
    ureq::get(&url)
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())
}

/// An update problem must never stop the app from booting, but it cannot vanish without
/// a trace either: a misconfigured server used to look exactly like "no updates available".
fn report_update_problem(app: &tauri::AppHandle, message: &str) {
    let log_dir = data_dir().join("logs");
    if fs::create_dir_all(&log_dir).is_ok() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("update.log"))
            .and_then(|mut file| writeln!(file, "[{timestamp}] {message}"));
    }

    set_splash_message(app, &format!("{message}.\nContinuando sem atualizar..."), false);
    thread::sleep(Duration::from_secs(3));
}

fn download_build(build: &LatestBuild, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let partial = destination.with_extension("exe.partial");
    let response = ureq::get(&build.download_url)
        .timeout(Duration::from_secs(10 * 60))
        .call()
        .map_err(|error| error.to_string())?;

    let mut file = File::create(&partial).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut reader = response.into_reader();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..read]);
    }
    file.flush().map_err(|error| error.to_string())?;
    drop(file);

    let digest = hex::encode(hasher.finalize());
    if let Some(expected) = build.sha256.as_deref() {
        if !expected.eq_ignore_ascii_case(&digest) {
            let _ = fs::remove_file(&partial);
            return Err(format!(
                "Hash da build {} não confere (esperado {expected}, obtido {digest}).",
                build.version
            ));
        }
    }

    fs::rename(&partial, destination).map_err(|error| error.to_string())?;
    Ok(())
}

fn create_desktop_shortcut(target: &Path) -> Result<(), String> {
    // Path::canonicalize returns \\?\ verbatim paths on Windows, which WScript.Shell
    // rejects with ArgumentException. Callers already pass absolute paths.
    let target_path = target.to_path_buf();
    let workdir = target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| target_path.clone());

    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $desktop = [Environment]::GetFolderPath('Desktop')\n\
         $linkPath = Join-Path $desktop '{}'\n\
         if (Test-Path -LiteralPath $linkPath) {{ Remove-Item -LiteralPath $linkPath -Force }}\n\
         $shell = New-Object -ComObject WScript.Shell\n\
         $shortcut = $shell.CreateShortcut($linkPath)\n\
         $shortcut.TargetPath = '{}'\n\
         $shortcut.WorkingDirectory = '{}'\n\
         $shortcut.Description = 'Skyfit EVO'\n\
         $shortcut.Save()\n",
        ps_single_quoted(SHORTCUT_NAME),
        ps_single_quoted(&path_to_string(&target_path)),
        ps_single_quoted(&path_to_string(&workdir)),
    );

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "Falha ao criar o atalho na Área de Trabalho.".to_string()
        } else {
            format!("Falha ao criar o atalho na Área de Trabalho: {detail}")
        })
    }
}

fn schedule_relaunch(next_exe: &Path, current_pid: u32) -> Result<(), String> {
    let next = path_to_string(next_exe);
    let command = format!(
        "taskkill /PID {current_pid} /F >nul 2>&1 & ping 127.0.0.1 -n 3 >nul & start \"\" \"{next}\""
    );

    let mut process = Command::new("cmd");
    process
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Command::arg escapes the inner quotes as \", which cmd.exe does not understand:
        // `start` ends up trying to launch a bare backslash instead of the exe. raw_arg
        // hands the line over untouched.
        process.raw_arg(format!("/C {command}"));
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        process.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    #[cfg(not(windows))]
    process.args(["/C", &command]);

    process.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn prune_old_installs(current: &Path) {
    let Some(parent) = current.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path != current
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn is_current_exe(path: &Path) -> bool {
    let Ok(current) = env::current_exe() else {
        return false;
    };
    match (current.canonicalize(), path.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => current == path,
    }
}

fn installed_exe_path(version: &str) -> PathBuf {
    app_dir().join(format!("Skyfit-EVO-{version}.exe"))
}

fn app_dir() -> PathBuf {
    local_app_data().join("SkyfitEVO").join("app")
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let left: Vec<u32> = a.split('.').filter_map(|part| part.parse().ok()).collect();
    let right: Vec<u32> = b.split('.').filter_map(|part| part.parse().ok()).collect();
    let len = left.len().max(right.len());
    for index in 0..len {
        let l = left.get(index).copied().unwrap_or(0);
        let r = right.get(index).copied().unwrap_or(0);
        if l < r {
            return -1;
        }
        if l > r {
            return 1;
        }
    }
    0
}

fn ps_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn extract_payload() -> std::io::Result<Runtime> {
    let runtime_dir = runtime_dir();
    let marker = runtime_dir.join(".complete");
    let bridge = runtime_dir.join("bridge.exe");

    if marker.exists()
        && bridge.exists()
        && fs::read(&marker).ok().as_deref() == Some(RUNTIME_MARKER)
    {
        return Ok(Runtime {
            dir: runtime_dir,
            extracted: false,
        });
    }

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)?;
    }
    fs::create_dir_all(&runtime_dir)?;

    let decoder = zstd::stream::read::Decoder::new(PAYLOAD)?;
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&runtime_dir)?;
    fs::write(marker, RUNTIME_MARKER)?;
    prune_old_runtimes(&runtime_dir);

    Ok(Runtime {
        dir: runtime_dir,
        extracted: true,
    })
}

/// Each release extracts into its own folder, so without this the leftovers of every
/// previous version would sit in the user's profile forever.
fn prune_old_runtimes(current: &Path) {
    let Some(parent) = current.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path != current && path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

fn spawn_bridge(runtime_dir: &Path, log_dir: &Path) -> std::io::Result<Child> {
    let bridge_path = runtime_dir.join("bridge.exe");
    let data = data_dir();
    let perfis = data.join("perfis");
    let screenshots = data.join("screenshots");
    fs::create_dir_all(&perfis)?;
    fs::create_dir_all(&screenshots)?;

    let stdout = File::create(log_dir.join("bridge.out.log"))?;
    let stderr = File::create(log_dir.join("bridge.err.log"))?;
    let mut command = Command::new(bridge_path);
    command
        .current_dir(runtime_dir)
        .env("BRIDGE_PORT", "4000")
        .env("BACK_URL", configured_back_url())
        .env("FRONT_URL", configured_front_url())
        .env("DESKTOP_APP_VERSION", APP_VERSION)
        .env("DESKTOP_PID", std::process::id().to_string())
        .env("EVO_PERFIS_DIR", perfis)
        .env("EVO_SCREENSHOTS_DIR", screenshots)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

fn configured_back_url() -> &'static str {
    option_env!("SKYFIT_BACK_URL").unwrap_or(DEFAULT_BACK_URL)
}

fn configured_front_url() -> &'static str {
    option_env!("SKYFIT_FRONT_URL").unwrap_or(DEFAULT_FRONT_URL)
}

fn wait_for_local_bridge(
    app: &tauri::AppHandle,
    state: &BridgeState,
    timeout: Duration,
) -> BridgeStartup {
    let started_at = Instant::now();
    let mut reported_seconds = u64::MAX;

    while started_at.elapsed() < timeout {
        if local_bridge_ready() {
            return BridgeStartup::Ready;
        }

        // A binary the CPU or the antivirus rejects dies in milliseconds and writes nothing
        // to its log, so the exit status is the only evidence the user ever gets.
        if let Some(status) = bridge_exit_status(state) {
            return BridgeStartup::Exited(status);
        }

        let seconds = started_at.elapsed().as_secs();
        if seconds != reported_seconds {
            reported_seconds = seconds;
            set_splash_message(
                app,
                &format!(
                    "Iniciando bridge local na porta 4000... ({seconds}s de {}s)",
                    timeout.as_secs()
                ),
                false,
            );
        }

        thread::sleep(Duration::from_millis(400));
    }

    BridgeStartup::TimedOut
}

fn bridge_exit_status(state: &BridgeState) -> Option<ExitStatus> {
    let mut current = state.0.lock().ok()?;
    current.as_mut()?.try_wait().ok().flatten()
}

fn describe_exit(status: ExitStatus) -> String {
    let Some(code) = status.code() else {
        return "o processo encerrou logo após iniciar".to_string();
    };

    match exit_code_hint(code) {
        Some(hint) => format!("o processo encerrou com código {code} ({hint})"),
        None => format!("o processo encerrou com código {code}"),
    }
}

fn exit_code_hint(code: i32) -> Option<&'static str> {
    const STATUS_ILLEGAL_INSTRUCTION: i32 = -1_073_741_795;
    const STATUS_ACCESS_VIOLATION: i32 = -1_073_741_819;
    const STATUS_DLL_NOT_FOUND: i32 = -1_073_741_515;

    match code {
        STATUS_ILLEGAL_INSTRUCTION => Some(
            "instrução ilegal: o processador deste PC não suporta as instruções usadas pelo bridge",
        ),
        STATUS_ACCESS_VIOLATION => Some("violação de acesso"),
        STATUS_DLL_NOT_FOUND => Some("faltam DLLs do sistema"),
        _ => None,
    }
}

/// The hosted front runs over HTTPS and the browser blocks it from calling the bridge over
/// plain HTTP on loopback, so a late start would leave EVO broken for the whole session.
fn watch_for_late_bridge(app: tauri::AppHandle) {
    thread::spawn(move || {
        let deadline = Instant::now() + LATE_BRIDGE_WATCH;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_secs(2));
            if !local_bridge_ready() {
                continue;
            }

            if let (Some(window), Ok(url)) = (
                app.get_webview_window("main"),
                tauri::Url::parse(LOCAL_APP_URL),
            ) {
                let _ = window.navigate(url);
            }
            return;
        }
    });
}

fn local_bridge_ready() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], LOCAL_HEALTH_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(700)) else {
        return false;
    };

    let request = format!(
        "GET /evo/health HTTP/1.1\r\nHost: {LOCAL_HEALTH_HOST}:{LOCAL_HEALTH_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") && response.contains("evo-bridge")
}

fn open_main_window(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title(format!("Skyfit EVO v{APP_VERSION}"))
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .build()
        .map_err(|error| error.to_string())?;

    if devtools_enabled() {
        window.open_devtools();
    }

    Ok(())
}

fn devtools_enabled() -> bool {
    matches!(
        env::var("SKYFIT_DEVTOOLS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

fn close_splash(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.close();
    }
}

/// The splash title comes from its own document.title, so it has to be tagged via eval —
/// the window title follows whatever the document says.
fn tag_splash_version(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("splash") {
        let script = format!(
            "document.title = '{}';",
            js_string(&format!("Skyfit EVO v{APP_VERSION}"))
        );
        let _ = window.eval(&script);
    }
}

fn set_splash_message(app: &tauri::AppHandle, message: &str, is_error: bool) {
    if let Some(window) = app.get_webview_window("splash") {
        let script = format!(
            "window.setStartupStatus && window.setStartupStatus('{}', {});",
            js_string(message),
            is_error
        );
        let _ = window.eval(&script);
    }
}

fn js_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn runtime_dir() -> PathBuf {
    local_app_data()
        .join("SkyfitEVO")
        .join("runtime")
        .join(APP_VERSION)
}

fn data_dir() -> PathBuf {
    local_app_data().join("SkyfitEVO").join("data")
}

fn local_app_data() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir())
}

fn read_log_tail(path: &Path) -> std::io::Result<String> {
    const MAX_BYTES: usize = 4096;
    let content = fs::read_to_string(path)?;
    if content.len() <= MAX_BYTES {
        return Ok(content);
    }

    Ok(content[content.len() - MAX_BYTES..].to_string())
}

fn kill_bridge(state: &BridgeState) {
    let Ok(mut current) = state.0.lock() else {
        return;
    };

    if let Some(child) = current.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *current = None;
}
