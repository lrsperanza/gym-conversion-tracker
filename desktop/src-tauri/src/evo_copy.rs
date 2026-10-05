use serde::Deserialize;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct MacroState {
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    status: Arc<Mutex<String>>,
}
struct Request {
    steps: Vec<Step>,
    reply: mpsc::Sender<Result<(), String>>,
}
#[derive(Debug, PartialEq)]
enum Step {
    Text(String),
    Select(String),
    Tab,
    Wait(u64),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyData {
    nome: String,
    sobrenome: String,
    cpf: String,
    nascimento: String,
    genero: String,
    cep: String,
    telefone: String,
    email: String,
    tipo_visita: String,
    como_conheceu: String,
}

fn plan(data: CopyData) -> Result<Vec<Step>, String> {
    let values = [
        &data.nome,
        &data.sobrenome,
        &data.cpf,
        &data.nascimento,
        &data.genero,
        &data.cep,
        &data.telefone,
        &data.email,
        &data.tipo_visita,
        &data.como_conheceu,
    ];
    if data.nome.trim().is_empty()
        || values
            .iter()
            .any(|s| s.chars().count() > 250 || s.chars().any(char::is_control))
    {
        return Err("Dados inválidos para a cópia dinâmica.".into());
    }
    let mut phone: String = data.telefone.chars().filter(char::is_ascii_digit).collect();
    if data.telefone.starts_with('+') {
        if !phone.starts_with("55") {
            return Err("A macro usa o DDI +55 do cadastro novo. Para outro país, use o preenchimento automático.".into());
        }
        phone = phone[2..].into();
    }
    let mut steps = Vec::new();
    for text in [data.nome, data.sobrenome, data.cpf, data.nascimento] {
        steps.push(Step::Text(text));
        steps.push(Step::Tab);
    }
    // Birth date -> calendar button -> gender. The hidden date input has tabindex=-1.
    steps.push(Step::Tab);
    steps.push(Step::Select(data.genero));
    steps.push(Step::Tab);
    let has_cep = !data.cep.is_empty();
    steps.push(Step::Text(data.cep));
    steps.push(Step::Tab);
    if has_cep {
        steps.push(Step::Wait(1500));
    }
    // New EVO form defaults to +55. DDI is itself a focusable mat-select.
    steps.push(Step::Tab);
    steps.push(Step::Text(phone));
    steps.push(Step::Tab);
    steps.push(Step::Text(data.email));
    steps.push(Step::Tab);
    steps.push(Step::Select(data.tipo_visita));
    steps.push(Step::Tab);
    // Stop on the final selection. Escape can bubble to the EVO drawer and
    // close the whole registration form; do not send Escape or a trailing Tab.
    steps.push(Step::Select(data.como_conheceu));
    Ok(steps)
}

// The launcher can show the configured HTTPS front directly when the bridge
// cannot start. Native keyboard input does not depend on that bridge.
pub fn remote_capability() -> tauri::ipc::CapabilityBuilder {
    let origin = tauri::Url::parse(crate::configured_front_url())
        .expect("invalid configured front URL")
        .origin()
        .ascii_serialization();
    tauri::ipc::CapabilityBuilder::new("evo-copy-configured-front")
        .local(false)
        .window("main")
        .remote(format!("{origin}/*"))
        .permission("allow-prepare-evo-copy")
        .permission("allow-evo-copy-status")
}

fn allowed_url(url: &tauri::Url) -> bool {
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.port_or_known_default() == Some(4000);
    let front =
        tauri::Url::parse(crate::configured_front_url()).expect("invalid configured front URL");
    loopback || url.origin() == front.origin()
}

fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() != "main" || !allowed_url(&url) {
        return Err("Use a janela principal do Skyfit EVO.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn prepare_evo_copy(
    window: tauri::WebviewWindow,
    state: tauri::State<MacroState>,
    data: CopyData,
) -> Result<(), String> {
    authorize(&window)?;
    let steps = plan(data)?;
    #[cfg(not(windows))]
    {
        let _ = (state, steps);
        Err("Cópia dinâmica disponível no Windows.".into())
    }
    #[cfg(windows)]
    {
        if state.status.lock().unwrap().as_str() == "Preenchendo EVO..." {
            return Err("Aguarde o preenchimento atual.".into());
        }
        let mut sender = state.sender.lock().map_err(|e| e.to_string())?;
        if sender.is_none() {
            let (tx, rx) = mpsc::channel();
            let status = state.status.clone();
            std::thread::spawn(move || native::worker(rx, status));
            *sender = Some(tx);
        }
        let (reply, result) = mpsc::channel();
        sender
            .as_ref()
            .unwrap()
            .send(Request { steps, reply })
            .map_err(|e| e.to_string())?;
        result
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "A macro não respondeu.".to_string())?
    }
}

#[tauri::command]
pub fn evo_copy_status(
    window: tauri::WebviewWindow,
    state: tauri::State<MacroState>,
) -> Result<String, String> {
    authorize(&window)?;
    Ok(state.status.lock().map_err(|e| e.to_string())?.clone())
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    const HOTKEY: i32 = 0x5346;
    fn status(state: &Mutex<String>, text: &str) {
        *state.lock().unwrap() = text.into();
    }

    pub fn worker(rx: mpsc::Receiver<Request>, state: Arc<Mutex<String>>) {
        let mut pending: Option<(Vec<Step>, Instant)> = None;
        loop {
            match rx.try_recv() {
                Ok(request) => {
                    if pending.is_some() {
                        unsafe {
                            UnregisterHotKey(std::ptr::null_mut(), HOTKEY);
                        }
                    }
                    pending = None;
                    if unsafe {
                        RegisterHotKey(
                            std::ptr::null_mut(),
                            HOTKEY,
                            MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                            0x56,
                        )
                    } == 0
                    {
                        let message = "Ctrl+Shift+V já está em uso por outro aplicativo.";
                        status(&state, message);
                        let _ = request.reply.send(Err(message.into()));
                    } else {
                        pending = Some((request.steps, Instant::now()));
                        status(&state, "Pronta: selecione Nome no EVO e pressione Ctrl+Shift+V (válido por 5 minutos).");
                        let _ = request.reply.send(Ok(()));
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if pending
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(300))
            {
                unsafe {
                    UnregisterHotKey(std::ptr::null_mut(), HOTKEY);
                }
                pending = None;
                status(
                    &state,
                    "Cópia expirada. Clique em Cópia dinâmica novamente.",
                );
            }
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            while unsafe {
                PeekMessageW(
                    &mut msg,
                    std::ptr::null_mut(),
                    WM_HOTKEY,
                    WM_HOTKEY,
                    PM_REMOVE,
                )
            } != 0
            {
                if msg.wParam != HOTKEY as usize {
                    continue;
                }
                if let Some((steps, _)) = pending.take() {
                    unsafe {
                        UnregisterHotKey(std::ptr::null_mut(), HOTKEY);
                    }
                    status(&state, "Preenchendo EVO...");
                    let result = run(&steps);
                    status(
                        &state,
                        &match result {
                            Ok(()) => {
                                "Formulário preenchido. Revise e salve manualmente no EVO.".into()
                            }
                            Err(error) => format!(
                                "Cópia interrompida: {error} Revise os campos e copie novamente."
                            ),
                        },
                    );
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), HOTKEY);
        }
    }
    fn pressed(key: u16) -> bool {
        unsafe { GetAsyncKeyState(key as i32) < 0 }
    }
    fn guard(window: HWND) -> Result<(), String> {
        if unsafe { GetForegroundWindow() } != window || pressed(VK_ESCAPE) {
            Err("janela alterada ou Esc pressionado.".into())
        } else {
            Ok(())
        }
    }
    fn pause(window: HWND, ms: u64) -> Result<(), String> {
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(ms) {
            guard(window)?;
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
    fn input(vk: u16, scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    fn send(inputs: &[INPUT]) -> Result<(), String> {
        if unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        } != inputs.len() as u32
        {
            Err("Windows bloqueou a simulação de teclado.".into())
        } else {
            Ok(())
        }
    }
    fn key(window: HWND, vk: u16) -> Result<(), String> {
        guard(window)?;
        send(&[input(vk, 0, 0), input(vk, 0, KEYEVENTF_KEYUP)])?;
        pause(window, 65)
    }
    fn text(window: HWND, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return Ok(());
        }
        guard(window)?;
        send(&[
            input(VK_CONTROL, 0, 0),
            input(0x41, 0, 0),
            input(0x41, 0, KEYEVENTF_KEYUP),
            input(VK_CONTROL, 0, KEYEVENTF_KEYUP),
        ])?;
        for unit in value.encode_utf16() {
            guard(window)?;
            send(&[
                input(0, unit, KEYEVENTF_UNICODE),
                input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ])?;
            pause(window, 12)?;
        }
        Ok(())
    }
    fn select(window: HWND, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return Ok(());
        }
        key(window, VK_SPACE)?;
        pause(window, 200)?;
        key(window, VK_HOME)?;
        // Angular Material typeahead reads keyCode. Unicode VK_PACKET would not
        // work here. The initial ASCII word uniquely identifies the UI choices.
        for byte in value.bytes().take_while(u8::is_ascii_alphabetic) {
            key(window, byte.to_ascii_uppercase() as u16)?;
        }
        pause(window, 300)?;
        key(window, VK_SPACE)
    }
    fn run(steps: &[Step]) -> Result<(), String> {
        let window = unsafe { GetForegroundWindow() };
        let mut title = [0u16; 512];
        let mut class = [0u16; 128];
        unsafe {
            GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
            GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
        }
        if !String::from_utf16_lossy(&title)
            .to_uppercase()
            .contains("EVO")
            || !String::from_utf16_lossy(&class).starts_with("Chrome_WidgetWin_")
        {
            return Err("selecione a janela do EVO no Chrome ou Edge.".into());
        }
        let start = Instant::now();
        while [VK_CONTROL, VK_SHIFT, 0x56].into_iter().any(pressed) {
            if start.elapsed() > Duration::from_secs(3) {
                return Err("solte Ctrl, Shift e V após o atalho.".into());
            }
            pause(window, 20)?;
        }
        for step in steps {
            guard(window)?;
            match step {
                Step::Text(value) => text(window, value)?,
                Step::Select(value) => select(window, value)?,
                Step::Tab => key(window, VK_TAB)?,
                Step::Wait(ms) => pause(window, *ms)?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acl_allows_both_launcher_origins_only_in_main_window() {
        let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        let remote = tauri::ipc::Origin::Remote {
            url: tauri::Url::parse(crate::configured_front_url()).unwrap(),
        };
        // Reproduce the previously blocked hosted-front fallback.
        assert!(authority
            .resolve_access("prepare_evo_copy", "main", "main", &remote)
            .is_none());
        authority.add_capability(remote_capability()).unwrap();
        for address in [
            "http://localhost:4000/atendimento",
            "http://127.0.0.1:4000/atendimento",
            crate::configured_front_url(),
        ] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(allowed_url(&url));
            let origin = tauri::ipc::Origin::Remote { url };
            for command in ["prepare_evo_copy", "evo_copy_status"] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &origin)
                        .is_some(),
                    "{command}: {address}"
                );
                assert!(authority
                    .resolve_access(command, "splash", "splash", &origin)
                    .is_none());
            }
        }
        for address in [
            "https://example.com/",
            "http://localhost:4001/",
            "http://localhost.evil.test:4000/",
        ] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(!allowed_url(&url));
            assert!(authority
                .resolve_access(
                    "prepare_evo_copy",
                    "main",
                    "main",
                    &tauri::ipc::Origin::Remote { url }
                )
                .is_none());
        }
    }
    fn data() -> CopyData {
        CopyData {
            nome: "João".into(),
            sobrenome: "Silva".into(),
            cpf: "123".into(),
            nascimento: "01/02/2000".into(),
            genero: "Masculino".into(),
            cep: "14000000".into(),
            telefone: "+5516999998888".into(),
            email: "a@b.com".into(),
            tipo_visita: "Pessoal".into(),
            como_conheceu: "Indicação".into(),
        }
    }
    #[test]
    fn follows_supplied_tab_order() {
        let steps = plan(data()).unwrap();
        assert_eq!(
            &steps[6..11],
            &[
                Step::Text("01/02/2000".into()),
                Step::Tab,
                Step::Tab,
                Step::Select("Masculino".into()),
                Step::Tab
            ]
        );
        assert_eq!(
            &steps[11..17],
            &[
                Step::Text("14000000".into()),
                Step::Tab,
                Step::Wait(1500),
                Step::Tab,
                Step::Text("16999998888".into()),
                Step::Tab
            ]
        );
        assert_eq!(steps.last(), Some(&Step::Select("Indicação".into())));
    }
    #[test]
    fn stops_on_final_field_with_or_without_a_selection() {
        for source in ["Indicação", ""] {
            let mut d = data();
            d.como_conheceu = source.into();
            let steps = plan(d).unwrap();
            assert_eq!(steps.last(), Some(&Step::Select(source.into())));
            assert_eq!(steps.len(), 22);
        }
    }
    #[test]
    fn empty_fields_keep_tab_stops() {
        let mut d = data();
        d.cpf.clear();
        d.cep.clear();
        d.como_conheceu.clear();
        let steps = plan(d).unwrap();
        assert_eq!(steps.iter().filter(|s| **s == Step::Tab).count(), 11);
        assert!(!steps
            .iter()
            .any(|s| matches!(s, Step::Wait(_))));
    }
    #[test]
    fn rejects_control_characters_and_foreign_ddi() {
        let mut d = data();
        d.nome = "João\tSilva".into();
        assert!(plan(d).is_err());
        let mut d = data();
        d.telefone = "+12125551234".into();
        assert!(plan(d).is_err());
    }
}
