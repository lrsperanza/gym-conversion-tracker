use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_APP_URL: &str = "http://localhost:4000";
const LOCAL_HEALTH_HOST: &str = "127.0.0.1";
const LOCAL_HEALTH_PORT: u16 = 4000;
const DEFAULT_BACK_URL: &str =
    "https://gym-conversion-tracker-437354431924.southamerica-east1.run.app";
const DEFAULT_FRONT_URL: &str = "https://nice-pebble-04842d70f.7.azurestaticapps.net";
const RUNTIME_MARKER: &[u8] = b"front-remote-v1";
const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.tar.zst"));

#[derive(Clone, Default)]
struct BridgeState(Arc<Mutex<Option<Child>>>);

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
    let runtime_dir = extract_payload().map_err(|error| error.to_string())?;
    let log_dir = data_dir().join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;

    set_splash_message(&app, "Iniciando bridge local na porta 4000...", false);
    let bridge = spawn_bridge(&runtime_dir, &log_dir).map_err(|error| error.to_string())?;
    {
        let mut current = state
            .0
            .lock()
            .map_err(|_| "Falha ao controlar o bridge.".to_string())?;
        *current = Some(bridge);
    }

    if wait_for_local_bridge(Duration::from_secs(30)) {
        open_main_window(&app, LOCAL_APP_URL)?;
        close_splash(&app);
        return Ok(());
    }

    let details = read_log_tail(&log_dir.join("bridge.err.log")).unwrap_or_default();
    let message = if details.trim().is_empty() {
        "Bridge local nao respondeu. Abrindo o front remoto...".to_string()
    } else {
        format!("Bridge local nao respondeu. Abrindo o front remoto...\n\n{details}")
    };
    set_splash_message(&app, &message, true);
    thread::sleep(Duration::from_millis(1200));
    open_main_window(&app, configured_front_url())?;
    close_splash(&app);
    Ok(())
}

fn extract_payload() -> std::io::Result<PathBuf> {
    let runtime_dir = runtime_dir();
    let marker = runtime_dir.join(".complete");
    let bridge = runtime_dir.join("bridge.exe");

    if marker.exists()
        && bridge.exists()
        && fs::read(&marker).ok().as_deref() == Some(RUNTIME_MARKER)
    {
        return Ok(runtime_dir);
    }

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)?;
    }
    fs::create_dir_all(&runtime_dir)?;

    let decoder = zstd::stream::read::Decoder::new(PAYLOAD)?;
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&runtime_dir)?;
    fs::write(marker, RUNTIME_MARKER)?;

    Ok(runtime_dir)
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

fn wait_for_local_bridge(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if local_bridge_ready() {
            return true;
        }
        thread::sleep(Duration::from_millis(400));
    }
    false
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
        .title("Skyfit EVO")
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
        .join(env!("CARGO_PKG_VERSION"))
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
