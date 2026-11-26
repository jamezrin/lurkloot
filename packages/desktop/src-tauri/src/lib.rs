//! The Lurkloot desktop app (#1024): a shell around the bundled `lurkloot
//! serve`. It is packaging only. It starts serve, shows serve's app UI in its
//! own window, keeps farming from the tray, and stops serve on Quit. It
//! never farms itself, and it talks to serve only by starting it, reading
//! its ready line and closing its stdin. See docs/architecture.md, "Desktop
//! app".

pub mod navigation;
pub mod ready;
pub mod sidecar;
pub mod token;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use navigation::{Navigation, Site};
use sidecar::{SidecarEvents, SidecarSpec, Supervisor};

const MAIN_WINDOW: &str = "main";
/// How long Quit waits for serve to save its state and exit before it kills it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);
/// Failures in a row before the window says serve keeps stopping.
const FAILURES_BEFORE_ERROR: u32 = 3;

#[derive(Default)]
struct Shell {
    /// The running serve's origin; the only remote origin the window may load.
    serve: Mutex<Option<Site>>,
    /// The shell's own pages (`tauri://localhost` or `http://tauri.localhost`).
    shell_url: OnceLock<Url>,
    supervisor: OnceLock<Supervisor>,
    has_tray: AtomicBool,
    quitting: AtomicBool,
}

impl Shell {
    /// Remembers the address of the shell's own pages. Tauri serves them from
    /// `tauri://localhost`, or `http://tauri.localhost` on Windows, so it is
    /// read from the window rather than written here. A web view that has not
    /// committed its first page yet may report `about:blank`; that is not it.
    fn learn_shell_url(&self, url: &Url) {
        if url.host_str().is_some() && matches!(url.scheme(), "tauri" | "http" | "https") {
            let _ = self.shell_url.set(url.clone());
        }
    }

    fn decide(&self, url: &Url) -> Navigation {
        let Some(shell_url) = self.shell_url.get() else {
            // Only the window's first page, the shell's own, loads before its
            // address is known: serve is not started until it is.
            self.learn_shell_url(url);
            return Navigation::Allow;
        };
        let serve = self.serve.lock().unwrap().clone();
        navigation::decide(url, serve.as_ref(), Some(&Site::of(shell_url)))
    }

    fn status_page(&self, state: &str) -> Option<Url> {
        let mut url = self.shell_url.get()?.join("index.html").ok()?;
        url.set_fragment(Some(state));
        Some(url)
    }
}

pub fn run() {
    let shell = Arc::new(Shell::default());
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&shell))
        .setup(move |app| {
            setup(app.handle(), &shell)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let shell = window.state::<Arc<Shell>>();
                if shell.has_tray.load(Ordering::SeqCst) && !shell.quitting.load(Ordering::SeqCst) {
                    // Farming goes on in the tray.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("the desktop app could not start");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let shell = app.state::<Arc<Shell>>();
            if !shell.quitting.load(Ordering::SeqCst) {
                // Every way out (the last window closed with no tray, the
                // OS's own quit) stops serve first.
                api.prevent_exit();
                quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}

fn setup(app: &AppHandle, shell: &Arc<Shell>) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let token = token::generate_token();

    let window = main_window(app, shell, &token)?;
    if let Ok(url) = window.url() {
        shell.learn_shell_url(&url);
    }

    let has_tray = tray::tray_available() && build_tray(app).is_ok();
    shell.has_tray.store(has_tray, Ordering::SeqCst);

    let spec = SidecarSpec {
        program: sidecar_program(app)?,
        // Config and credentials in the OS's app-data folder: serve keeps
        // authDir and state.json beside the config file.
        args: sidecar::serve_args(&data_dir.join("config.json")),
        env: sidecar::serve_env(std::env::vars_os(), &token),
        log_path: log_dir.join("serve.log"),
    };
    let events = Arc::new(WindowEvents { app: app.clone() });
    let _ = shell.supervisor.set(Supervisor::start(spec, events));
    Ok(())
}

fn sidecar_program(app: &AppHandle) -> tauri::Result<PathBuf> {
    let name = if cfg!(windows) {
        "lurkloot.exe"
    } else {
        "lurkloot"
    };
    Ok(app.path().resource_dir()?.join("sidecar").join(name))
}

fn main_window(app: &AppHandle, shell: &Arc<Shell>, token: &str) -> tauri::Result<WebviewWindow> {
    let navigate_shell = Arc::clone(shell);
    let navigate_app = app.clone();
    let popup_app = app.clone();
    WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        WebviewUrl::App("index.html#starting".into()),
    )
    .title("Lurkloot")
    .inner_size(1120.0, 780.0)
    .min_inner_size(420.0, 560.0)
    // Main frame only: serve's page has no frames, and no other page
    // ever gets the token.
    .initialization_script(token::token_script(token))
    .on_navigation(move |url| match navigate_shell.decide(url) {
        Navigation::Allow => true,
        Navigation::OpenExternally => {
            open_externally(&navigate_app, url);
            false
        }
        Navigation::Refuse => false,
    })
    // window.open and target="_blank": the system browser, never a
    // window inside the app.
    .on_new_window(move |url, _features| {
        if navigation::external(&url) == Navigation::OpenExternally {
            open_externally(&popup_app, &url);
        }
        NewWindowResponse::Deny
    })
    .build()
}

fn open_externally(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lurkloot", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Lurkloot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quit: hide the window, close serve's stdin, wait for it to save and exit
/// (killing its process tree after SHUTDOWN_GRACE), then exit.
fn quit(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(supervisor) = shell.supervisor.get() {
            supervisor.shutdown(SHUTDOWN_GRACE);
        }
        app.exit(0);
    });
}

/// Moves the window as serve comes and goes.
struct WindowEvents {
    app: AppHandle,
}

impl SidecarEvents for WindowEvents {
    fn ready(&self, url: Url) {
        let shell = self.app.state::<Arc<Shell>>();
        *shell.serve.lock().unwrap() = Some(Site::of(&url));
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
            let _ = window.navigate(url);
        }
    }

    fn failed(&self, failures: u32, _detail: String) {
        let shell = self.app.state::<Arc<Shell>>();
        // That serve is gone; its port may be anyone's now.
        *shell.serve.lock().unwrap() = None;
        let state = if failures >= FAILURES_BEFORE_ERROR {
            "failed"
        } else {
            "restarting"
        };
        if let (Some(window), Some(page)) = (
            self.app.get_webview_window(MAIN_WINDOW),
            shell.status_page(state),
        ) {
            let _ = window.navigate(page);
        }
        // An error the user must see: bring the window back from the tray.
        if failures == FAILURES_BEFORE_ERROR {
            show_main(&self.app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn learns_the_shell_pages_address_from_the_window() {
        for page in [
            "tauri://localhost/index.html#starting",
            "http://tauri.localhost/index.html#starting",
        ] {
            let shell = Shell::default();
            shell.learn_shell_url(&url("about:blank"));
            assert!(shell.shell_url.get().is_none());
            shell.learn_shell_url(&url(page));
            let restarting = shell.status_page("restarting").unwrap();
            assert_eq!(restarting.fragment(), Some("restarting"));
            assert_eq!(restarting.path(), "/index.html");
            assert_eq!(shell.decide(&restarting), Navigation::Allow);
            assert_eq!(
                shell.decide(&url("https://www.twitch.tv/")),
                Navigation::OpenExternally
            );
        }
    }

    #[test]
    fn learns_it_from_the_first_navigation_when_the_window_did_not_say() {
        let shell = Shell::default();
        assert_eq!(
            shell.decide(&url("http://tauri.localhost/index.html#starting")),
            Navigation::Allow
        );
        assert_eq!(
            shell.status_page("failed").unwrap().as_str(),
            "http://tauri.localhost/index.html#failed"
        );
    }

    #[test]
    fn allows_serve_only_while_it_runs() {
        let shell = Shell::default();
        shell.learn_shell_url(&url("tauri://localhost/index.html"));
        let app = url("http://127.0.0.1:49152/");
        assert_eq!(shell.decide(&app), Navigation::OpenExternally);
        *shell.serve.lock().unwrap() = Some(Site::of(&app));
        assert_eq!(shell.decide(&app), Navigation::Allow);
    }
}
