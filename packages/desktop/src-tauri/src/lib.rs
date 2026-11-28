//! The Lurkloot desktop app (#1024): a shell around the bundled `lurkloot
//! serve`. It is packaging only. It starts serve, shows serve's app UI in its
//! own window, keeps farming from the tray, and stops serve on Quit. It
//! never farms itself, and it talks to serve only by starting it, reading
//! its ready line and closing its stdin. See docs/architecture.md, "Desktop
//! app".

mod autostart;
pub mod navigation;
pub mod ready;
mod serve_api;
pub mod shell_settings;
pub mod sidecar;
pub mod token;
mod tray;
pub mod twitch_sign_in;
pub mod updates;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use navigation::{Navigation, Site};
use shell_settings::{SettingsFile, ShellSettings};
use sidecar::{SidecarEvents, SidecarSpec, Supervisor};
use twitch_sign_in::{Redirect, SignInResult};

const MAIN_WINDOW: &str = "main";
const SIGN_IN_WINDOW: &str = "twitch-sign-in";
/// How long Quit waits for serve to save its state and exit before it kills it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);
/// Failures in a row before the window says serve keeps stopping.
const FAILURES_BEFORE_ERROR: u32 = 3;

#[derive(Default)]
struct UpdateState {
    /// The version the last check found; the install checks again for the
    /// current manifest rather than reuse that one.
    found: Option<String>,
    notice: Option<updates::Notice>,
    /// A check is running: only one at a time.
    checking: bool,
}

#[derive(Default)]
struct Shell {
    /// The running serve's origin; the only remote origin the window may load.
    serve: Mutex<Option<Site>>,
    /// The running serve's address, for the shell's own calls to it.
    serve_url: Mutex<Option<Url>>,
    /// This launch's token for serve.
    token: OnceLock<String>,
    /// A Twitch sign-in is starting or its window is open.
    signing_in: AtomicBool,
    /// What the sign-in window was sent to at the redirect URI, if anything.
    sign_in_outcome: Mutex<Option<Redirect>>,
    /// The shell's own pages (`tauri://localhost` or `http://tauri.localhost`).
    shell_url: OnceLock<Url>,
    supervisor: OnceLock<Supervisor>,
    has_tray: AtomicBool,
    /// The shell's own settings file (`desktop.json`).
    settings_file: OnceLock<SettingsFile>,
    settings: Mutex<ShellSettings>,
    /// The tray's "Launch at startup" item, to put its check back when the
    /// OS refuses the change.
    launch_at_startup_item: OnceLock<CheckMenuItem<Wry>>,
    automatic_updates_item: OnceLock<CheckMenuItem<Wry>>,
    /// The tray's menu, which gains the update item once an update is found.
    tray_menu: OnceLock<Menu<Wry>>,
    update_item: OnceLock<MenuItem<Wry>>,
    /// The update found, and what the tray and window show about it (#1028).
    update: Mutex<UpdateState>,
    /// Quit has started: serve is being stopped.
    quitting: AtomicBool,
    /// serve is stopped; only now may the app exit.
    shutdown_done: AtomicBool,
}

impl Shell {
    /// Remembers the address of the shell's own pages, read from the window.
    /// Tauri serves them from `tauri://localhost`, or `http(s)://tauri.localhost`
    /// on Windows; only those are taken, never `about:blank` (a web view that has
    /// not committed its first page yet) or any other address. Returns whether
    /// `url` is the shell's own page.
    fn learn_shell_url(&self, url: &Url) -> bool {
        let is_shell = match (url.scheme(), url.host_str()) {
            ("tauri", Some("localhost")) => true,
            ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
            _ => false,
        };
        if is_shell {
            let _ = self.shell_url.set(url.clone());
        }
        is_shell
    }

    fn decide(&self, url: &Url) -> Navigation {
        let Some(shell_url) = self.shell_url.get() else {
            // Before the shell's address is known, only the shell's own first
            // page may load.
            return if self.learn_shell_url(url) {
                Navigation::Allow
            } else {
                Navigation::Refuse
            };
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
        // Rust only: no capability grants the page its commands (#1028).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&shell))
        .setup(move |app| {
            setup(app.handle(), &shell)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed if window.label() == SIGN_IN_WINDOW => {
                sign_in_window_closed(window.app_handle());
            }
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW => {
                let shell = window.state::<Arc<Shell>>();
                // Checked again now: a Linux tray can go away while the app
                // runs, and hiding the window with no tray would leave no way
                // back to it.
                if shell.has_tray.load(Ordering::SeqCst)
                    && tray::tray_available()
                    && !shell.quitting.load(Ordering::SeqCst)
                {
                    // Farming goes on in the tray.
                    api.prevent_close();
                    let _ = window.hide();
                } else if !shell.quitting.load(Ordering::SeqCst) {
                    // No tray: closing the window quits, through the one
                    // shutdown path, even while a sign-in window is open
                    // (the app would otherwise wait for that one to close).
                    api.prevent_close();
                    quit(window.app_handle());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("the desktop app could not start");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let shell = app.state::<Arc<Shell>>();
            if !shell.shutdown_done.load(Ordering::SeqCst) {
                // Every way out (the last window closed with no tray, the
                // OS's own quit, a second quit while the first one waits)
                // stops serve first; quit() exits once it has.
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
    let _ = shell.token.set(token.clone());

    let settings_file = SettingsFile::in_dir(&app.path().app_config_dir()?);
    let mut settings = settings_file.load();
    // The OS entry is never written on launch, only from the tray, so a user
    // who switched it off in the OS stays switched off. One they removed
    // entirely turns the setting off to match.
    if settings.launch_at_startup && matches!(autostart::is_registered(), Ok(false)) {
        settings.launch_at_startup = false;
        let _ = settings_file.save(&settings);
    }
    // An install that failed before the last restart is reported until this
    // version is the one it tried to install.
    if settings.failed_update.as_deref() == Some(app.package_info().version.to_string().as_str()) {
        settings.failed_update = None;
        let _ = settings_file.save(&settings);
    }
    let launch_at_startup = settings.launch_at_startup;
    let automatic_updates = settings.automatic_updates;
    *shell.settings.lock().unwrap() = settings;
    let _ = shell.settings_file.set(settings_file);

    // The portable zip never updates itself (#1025), so it offers no update
    // setting and never checks.
    let portable = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(updates::is_portable))
        .unwrap_or(false);
    let automatic_updates = (!portable).then_some(automatic_updates);
    let has_tray =
        tray::tray_available() && build_tray(app, launch_at_startup, automatic_updates).is_ok();
    shell.has_tray.store(has_tray, Ordering::SeqCst);

    // A launch at sign-in farms from the tray, with no window until it is
    // opened from there.
    let hidden = shell_settings::start_hidden(
        shell_settings::is_autostart_launch(std::env::args_os()),
        has_tray,
    );
    let window = main_window(app, shell, &token, !hidden)?;
    if let Ok(url) = window.url() {
        shell.learn_shell_url(&url);
    }

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
    if !portable {
        start_update_checks(app);
    }
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

fn main_window(
    app: &AppHandle,
    shell: &Arc<Shell>,
    token: &str,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let navigate_shell = Arc::clone(shell);
    let navigate_app = app.clone();
    let popup_app = app.clone();
    WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        WebviewUrl::App("index.html#starting".into()),
    )
    .title("Lurkloot")
    .visible(visible)
    .inner_size(1120.0, 780.0)
    .min_inner_size(420.0, 560.0)
    // Main frame only: serve's page has no frames, and no other page
    // ever gets the token.
    .initialization_script(token::token_script(token))
    // A page that loads (serve's after a restart, a reload) hears about an
    // update found before it.
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let notice = window
                .state::<Arc<Shell>>()
                .update
                .lock()
                .unwrap()
                .notice
                .clone();
            if let Some(notice) = notice {
                let _ = window.eval(updates::notice_script(&notice));
            }
        }
    })
    .on_navigation(move |url| match navigate_shell.decide(url) {
        Navigation::Allow => true,
        Navigation::OpenExternally => {
            open_link(&navigate_app, url);
            false
        }
        Navigation::Refuse => false,
    })
    // window.open and target="_blank": the system browser, never a
    // window inside the app.
    .on_new_window(move |url, _features| {
        if navigation::external(&url) == Navigation::OpenExternally {
            open_link(&popup_app, &url);
        }
        NewWindowResponse::Deny
    })
    .build()
}

/// A link the app UI opened: Twitch's sign-in page marked for the sign-in
/// window goes to the shell's own window (#1026), everything else to the
/// system browser.
fn open_link(app: &AppHandle, url: &Url) {
    if twitch_sign_in::wants_sign_in_window(url) {
        start_twitch_sign_in(app);
    } else if updates::wants_install(url) {
        install_update(app);
    } else {
        open_externally(app, url);
    }
}

fn open_externally(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Opens Twitch's sign-in page in a private window of the shell's own, from
/// the link serve gives the shell (never the one the page sent). One at a
/// time: asking again brings the open one forward.
fn start_twitch_sign_in(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SIGN_IN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    if shell.quitting.load(Ordering::SeqCst) || shell.signing_in.swap(true, Ordering::SeqCst) {
        return;
    }
    *shell.sign_in_outcome.lock().unwrap() = None;
    let app = app.clone();
    std::thread::spawn(move || {
        let serve = shell.serve_url.lock().unwrap().clone();
        let (Some(serve), Some(token)) = (serve, shell.token.get()) else {
            shell.signing_in.store(false, Ordering::SeqCst);
            report_sign_in(
                &app,
                &SignInResult::failed(None, "network_error", "lurkloot serve is not running"),
            );
            return;
        };
        let link = match serve_api::sign_in_link(&serve, token) {
            // A fresh state per sign-in: only a redirect that brings it back
            // is posted.
            Ok(link) => twitch_sign_in::with_state(&link, &token::generate_token()),
            Err(result) => {
                shell.signing_in.store(false, Ordering::SeqCst);
                report_sign_in(&app, &result);
                return;
            }
        };
        // Quit may have started while the link was fetched.
        if shell.quitting.load(Ordering::SeqCst) {
            shell.signing_in.store(false, Ordering::SeqCst);
            return;
        }
        match sign_in_window(&app, &shell, link) {
            // Built hidden, then checked: a Quit that started before this
            // check is seen here, and one after it finds the window and
            // closes it. Destroying it reports the sign-in as cancelled.
            Ok(window) if shell.quitting.load(Ordering::SeqCst) => {
                let _ = window.destroy();
            }
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(error) => {
                shell.signing_in.store(false, Ordering::SeqCst);
                report_sign_in(
                    &app,
                    &SignInResult::failed(
                        None,
                        "internal_error",
                        format!("Could not open the sign-in window: {error}"),
                    ),
                );
            }
        }
    });
}

fn sign_in_window(app: &AppHandle, shell: &Arc<Shell>, link: Url) -> tauri::Result<WebviewWindow> {
    let state = link
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let navigate_shell = Arc::clone(shell);
    let navigate_app = app.clone();
    let popup_app = app.clone();
    WebviewWindowBuilder::new(app, SIGN_IN_WINDOW, WebviewUrl::External(link))
        .title("Sign in to Twitch")
        // Shown by start_twitch_sign_in once it has checked Quit has not started.
        .visible(false)
        .inner_size(480.0, 720.0)
        // A throwaway web data store, discarded when the window closes:
        // Twitch's cookies never persist in the app.
        .incognito(true)
        // No initialization script: this window never gets serve's token.
        .on_navigation(
            move |url| match twitch_sign_in::read_navigation(url, &state) {
                Redirect::Elsewhere => twitch_sign_in::sign_in_window_may_load(url),
                // The redirect URI: never loaded. Keep Twitch's answer (only the
                // first) and close the window, which reports the outcome.
                outcome => {
                    let mut stored = navigate_shell.sign_in_outcome.lock().unwrap();
                    if stored.is_none() {
                        *stored = Some(outcome);
                    }
                    drop(stored);
                    let app = navigate_app.clone();
                    let _ = navigate_app.run_on_main_thread(move || {
                        if let Some(window) = app.get_webview_window(SIGN_IN_WINDOW) {
                            let _ = window.close();
                        }
                    });
                    false
                }
            },
        )
        .on_new_window(move |url, _features| {
            if navigation::external(&url) == Navigation::OpenExternally {
                open_externally(&popup_app, &url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

/// The sign-in window is gone: closed early (cancelled), or closed by the
/// shell at the redirect URI. Twitch's answer goes to serve, and the main
/// window hears the outcome.
fn sign_in_window_closed(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    let outcome = shell.sign_in_outcome.lock().unwrap().take();
    let app = app.clone();
    std::thread::spawn(move || {
        let result = match outcome {
            None | Some(Redirect::Elsewhere) => SignInResult::Cancelled,
            Some(Redirect::Unreadable) => SignInResult::unreadable(),
            Some(Redirect::Unverified) => SignInResult::unverified(),
            Some(Redirect::Answer(address)) => {
                let serve = shell.serve_url.lock().unwrap().clone();
                match (serve, shell.token.get()) {
                    (Some(serve), Some(token)) if !shell.quitting.load(Ordering::SeqCst) => {
                        serve_api::complete(&serve, token, &address)
                    }
                    _ => {
                        SignInResult::failed(None, "network_error", "lurkloot serve is not running")
                    }
                }
            }
        };
        shell.signing_in.store(false, Ordering::SeqCst);
        report_sign_in(&app, &result);
    });
}

/// Tells the main window's app UI how a sign-in ended.
fn report_sign_in(app: &AppHandle, result: &SignInResult) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.eval(twitch_sign_in::result_script(result));
        if !app.state::<Arc<Shell>>().quitting.load(Ordering::SeqCst) {
            show_main(app);
        }
    }
}

fn build_tray(
    app: &AppHandle,
    launch_at_startup: bool,
    // None leaves the update setting out, for a copy that never updates.
    automatic_updates: Option<bool>,
) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lurkloot", true, None::<&str>)?;
    let startup = CheckMenuItem::with_id(
        app,
        "launch-at-startup",
        "Launch at startup",
        true,
        launch_at_startup,
        None::<&str>,
    )?;
    let updates_item = automatic_updates
        .map(|checked| {
            CheckMenuItem::with_id(
                app,
                "automatic-updates",
                "Check for updates automatically",
                true,
                checked,
                None::<&str>,
            )
        })
        .transpose()?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &startup])?;
    if let Some(item) = &updates_item {
        menu.append(item)?;
    }
    menu.append_items(&[&separator, &quit_item])?;
    let shell = app.state::<Arc<Shell>>();
    let _ = shell.launch_at_startup_item.set(startup);
    if let Some(item) = updates_item {
        let _ = shell.automatic_updates_item.set(item);
    }
    let _ = shell.tray_menu.set(menu.clone());
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Lurkloot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "launch-at-startup" => toggle_launch_at_startup(app),
            "automatic-updates" => toggle_automatic_updates(app),
            "install-update" => install_update(app),
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

/// The tray's "Launch at startup": registers or removes this user's startup
/// entry, then saves the choice. Off the GUI thread, one change at a time.
/// Whatever fails, the check and the saved choice end up showing what the
/// OS really has.
fn toggle_launch_at_startup(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    std::thread::spawn(move || {
        let mut settings = shell.settings.lock().unwrap();
        let wanted = !settings.launch_at_startup;
        let file = shell.settings_file.get();
        let changed = if wanted {
            autostart::current_program().and_then(|program| autostart::register(&program))
        } else {
            autostart::unregister()
        };
        let mut next = settings.clone();
        next.launch_at_startup = wanted;
        let saved = changed.is_ok() && file.is_some_and(|file| file.save(&next).is_ok());
        if saved {
            *settings = next;
        } else {
            let reason = match &changed {
                Err(error) => error.to_string(),
                Ok(()) => "the setting could not be saved".to_owned(),
            };
            eprintln!(
                "Launch at startup could not be turned {}: {reason}",
                if wanted { "on" } else { "off" }
            );
            if wanted {
                // Not saved: take the entry back out so the two agree.
                let _ = autostart::unregister();
            }
            if let Ok(registered) = autostart::is_registered() {
                if registered != settings.launch_at_startup {
                    settings.launch_at_startup = registered;
                    if let Some(file) = file {
                        let _ = file.save(&settings);
                    }
                }
            }
        }
        if let Some(item) = shell.launch_at_startup_item.get() {
            let _ = item.set_checked(settings.launch_at_startup);
        }
    });
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
    if !begin_shutdown(app) {
        return;
    }
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    let app = app.clone();
    std::thread::spawn(move || {
        stop_serve(&shell);
        app.exit(0);
    });
}

/// The start of every way out: hides the windows. False when one has already
/// started.
fn begin_shutdown(app: &AppHandle) -> bool {
    let shell = app.state::<Arc<Shell>>();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return false;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window(SIGN_IN_WINDOW) {
        let _ = window.close();
    }
    true
}

/// Closes serve's stdin and waits for it to save and exit, killing its process
/// tree after SHUTDOWN_GRACE. Only then may the app exit or restart.
fn stop_serve(shell: &Shell) {
    if let Some(supervisor) = shell.supervisor.get() {
        supervisor.shutdown(SHUTDOWN_GRACE);
    }
    shell.shutdown_done.store(true, Ordering::SeqCst);
}

/// Checks on start and every CHECK_INTERVAL while automatic updates are on.
/// Development builds never check.
fn start_update_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(updates::FIRST_CHECK_DELAY);
        loop {
            check_for_update(&app);
            std::thread::sleep(updates::CHECK_INTERVAL);
        }
    });
}

/// Asks GitHub for a newer release, one check at a time. A found one is
/// announced, never installed, and never replaces an install in progress.
fn check_for_update(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    if !shell.settings.lock().unwrap().automatic_updates || shell.quitting.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut state = shell.update.lock().unwrap();
        if state.checking || matches!(state.notice, Some(updates::Notice::Installing { .. })) {
            return;
        }
        state.checking = true;
    }
    let found = tauri::async_runtime::block_on(async {
        app.updater_builder()
            .timeout(updates::CHECK_TIMEOUT)
            .build()?
            .check()
            .await
    });
    let mut state = shell.update.lock().unwrap();
    state.checking = false;
    match found {
        Ok(Some(update)) => {
            if matches!(state.notice, Some(updates::Notice::Installing { .. })) {
                return;
            }
            let version = update.version;
            let failed_before = shell.settings.lock().unwrap().failed_update.as_deref()
                == Some(version.as_str())
                || matches!(&state.notice, Some(updates::Notice::Failed { version: failed }) if *failed == version);
            state.notice = Some(if failed_before {
                updates::Notice::Failed {
                    version: version.clone(),
                }
            } else {
                updates::Notice::Ready {
                    version: version.clone(),
                }
            });
            state.found = Some(version);
            drop(state);
            announce_update(app);
        }
        Ok(None) => {}
        Err(error) => eprintln!("Update check failed: {error}"),
    }
}

/// Shows the update's state in the tray and in the window.
fn announce_update(app: &AppHandle) {
    let shell = app.state::<Arc<Shell>>();
    let Some(notice) = shell.update.lock().unwrap().notice.clone() else {
        return;
    };
    let installing = matches!(notice, updates::Notice::Installing { .. });
    let label = updates::tray_label(&notice);
    if let Some(item) = shell.update_item.get() {
        let _ = item.set_text(&label);
        let _ = item.set_enabled(!installing);
    } else if let Some(menu) = shell.tray_menu.get() {
        if let Ok(item) =
            MenuItem::with_id(app, "install-update", &label, !installing, None::<&str>)
        {
            let separator = PredefinedMenuItem::separator(app);
            if menu.insert(&item, 0).is_ok() {
                if let Ok(separator) = separator {
                    let _ = menu.insert(&separator, 1);
                }
                let _ = shell.update_item.set(item);
            }
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.eval(updates::notice_script(&notice));
    }
}

/// The user chose to install: check the manifest again, download and verify
/// the update, stop serve as Quit does, install, and restart. A check,
/// download or signature failure leaves everything running and the update
/// ready to try again. The app may not exit until the installer returns.
fn install_update(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    let shown = {
        let mut state = shell.update.lock().unwrap();
        let Some(version) = state.found.clone() else {
            return;
        };
        if matches!(state.notice, Some(updates::Notice::Installing { .. }))
            || shell.quitting.load(Ordering::SeqCst)
        {
            return;
        }
        state.notice = Some(updates::Notice::Installing {
            version: version.clone(),
        });
        version
    };
    announce_update(app);
    let app = app.clone();
    std::thread::spawn(move || {
        // A fresh manifest, so a release repaired since the last check is the
        // one downloaded, with a deadline so a stalled download ends. The
        // builder's timeout covers only that check: the Update it returns has
        // none of its own, so the download's is set on it.
        let downloaded = tauri::async_runtime::block_on(async {
            let mut update = app
                .updater_builder()
                .timeout(updates::CHECK_TIMEOUT)
                .build()
                .map_err(|error| error.to_string())?
                .check()
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "no update is available any more".to_owned())?;
            update.timeout = Some(updates::DOWNLOAD_TIMEOUT);
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((update, bytes))
        });
        let (update, bytes) = match downloaded {
            Ok(downloaded) => downloaded,
            Err(error) => {
                eprintln!("The update could not be downloaded: {error}");
                shell.update.lock().unwrap().notice =
                    Some(updates::Notice::Failed { version: shown });
                announce_update(&app);
                return;
            }
        };
        if !begin_shutdown(&app) {
            return;
        }
        // serve stops as on Quit, but shutdown_done stays false while the
        // installer runs, so no other way out (the Dock's Quit, the OS's)
        // can end the app halfway through replacing it.
        if let Some(supervisor) = shell.supervisor.get() {
            supervisor.shutdown(SHUTDOWN_GRACE);
        }
        // On Windows a successful install hands over to the installer and
        // exits here. Elsewhere the app restarts into the new version, or into
        // this one if the install failed, which then says so.
        if let Err(error) = update.install(bytes) {
            eprintln!("The update could not be installed: {error}");
            if let Some(file) = shell.settings_file.get() {
                let mut settings = shell.settings.lock().unwrap();
                settings.failed_update = Some(update.version.clone());
                let _ = file.save(&settings);
            }
        }
        shell.shutdown_done.store(true, Ordering::SeqCst);
        app.restart();
    });
}

/// The tray's "Check for updates automatically". Turning it on checks now.
fn toggle_automatic_updates(app: &AppHandle) {
    let shell = Arc::clone(&app.state::<Arc<Shell>>());
    let app = app.clone();
    std::thread::spawn(move || {
        let enabled = {
            let mut settings = shell.settings.lock().unwrap();
            let mut next = settings.clone();
            next.automatic_updates = !settings.automatic_updates;
            if shell
                .settings_file
                .get()
                .is_some_and(|file| file.save(&next).is_ok())
            {
                *settings = next;
            } else {
                eprintln!("The update setting could not be saved");
            }
            settings.automatic_updates
        };
        if let Some(item) = shell.automatic_updates_item.get() {
            let _ = item.set_checked(enabled);
        }
        if enabled && !cfg!(debug_assertions) {
            check_for_update(&app);
        }
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
        *shell.serve_url.lock().unwrap() = Some(url.clone());
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
            let _ = window.navigate(url);
        }
    }

    fn failed(&self, failures: u32, _detail: String) {
        let shell = self.app.state::<Arc<Shell>>();
        // That serve is gone; its port may be anyone's now.
        *shell.serve.lock().unwrap() = None;
        *shell.serve_url.lock().unwrap() = None;
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
            for other in [
                "about:blank",
                "http://127.0.0.1:49152/",
                "https://evil.example/",
            ] {
                assert!(!shell.learn_shell_url(&url(other)));
            }
            assert!(shell.shell_url.get().is_none());
            assert!(shell.learn_shell_url(&url(page)));
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
        // Nothing else loads before it is known, serve's address included.
        assert_eq!(
            shell.decide(&url("http://127.0.0.1:49152/")),
            Navigation::Refuse
        );
        assert_eq!(
            shell.decide(&url("https://www.twitch.tv/")),
            Navigation::Refuse
        );
        assert_eq!(
            shell.decide(&url("http://tauri.localhost/index.html#starting")),
            Navigation::Allow
        );
        assert_eq!(
            shell.status_page("failed").unwrap().as_str(),
            "http://tauri.localhost/index.html#failed"
        );
    }

    // The install link (#1028) and the sign-in link are caught in open_link,
    // which only the main window, on serve's own page, may reach. The Twitch
    // sign-in window shows remote pages, so its links only ever go to the
    // system browser.
    #[test]
    fn only_the_main_window_reaches_open_link() {
        let source = include_str!("lib.rs");
        let start = source.find("fn sign_in_window(").unwrap();
        let end = source.find("fn sign_in_window_closed(").unwrap();
        let sign_in_window = &source[start..end];
        assert!(sign_in_window.contains("open_externally("));
        assert!(!sign_in_window.contains("open_link("));
        assert!(!sign_in_window.contains("install_update("));
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
