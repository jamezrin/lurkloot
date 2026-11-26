//! The OS's startup entry for "Launch at startup" (#1027): one per user, and
//! only ever this user's.
//!
//! - Windows: the `Lurkloot` value under `HKCU\…\CurrentVersion\Run`. Never
//!   HKLM, and never `StartupApproved`, which is the user's own switch in
//!   Task Manager and Settings.
//! - macOS: `~/Library/LaunchAgents/name.jamezrin.lurkloot.plist`.
//! - Linux: `name.jamezrin.lurkloot.desktop` in `$XDG_CONFIG_HOME/autostart`
//!   (`~/.config/autostart` when it is unset).
//!
//! Each starts the app with `--autostart`. The command lines are quoted for
//! their OS here, so a path with spaces or other special characters works.

use std::io;
use std::path::{Path, PathBuf};

use crate::shell_settings::AUTOSTART_ARG;

/// The name of the entry: the Run value on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
const ENTRY_NAME: &str = "Lurkloot";
/// The launchd label and the desktop file's name: the app's identifier.
#[cfg_attr(windows, allow(dead_code))]
const IDENTIFIER: &str = "name.jamezrin.lurkloot";

/// What the entry starts: the AppImage itself when running from one (its
/// own executable lives in a mount that is gone after it exits), otherwise
/// this executable.
pub fn current_program() -> io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(appimage));
    }
    std::env::current_exe()
}

/// Quotes one argument for Windows' command-line parser (CreateProcess and
/// CommandLineToArgvW): wrapped in quotes, with backslashes doubled only where
/// they come before a quote.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_quote(argument: &str) -> String {
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

/// The Run value's command line.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_command(program: &str) -> String {
    format!("{} {AUTOSTART_ARG}", windows_quote(program))
}

/// Quotes one argument of a desktop entry's `Exec` key: in double quotes with
/// `"`, `` ` ``, `$` and `\` escaped, `%` doubled since it starts a field
/// code, then every backslash doubled again because `Exec` is a string value
/// (Desktop Entry Specification, "The Exec key").
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_exec_quote(argument: &str) -> String {
    let mut quoted = String::from('"');
    for character in argument.chars() {
        match character {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted.replace('\\', "\\\\")
}

/// The XDG autostart desktop entry.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_entry(program: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Lurkloot\nComment=Farms Twitch and Kick drops in the background\nExec={} {AUTOSTART_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        desktop_exec_quote(program)
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// The LaunchAgent property list. launchd passes ProgramArguments as they
/// are, so the path needs no shell quoting, only XML escaping.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn launch_agent(program: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{IDENTIFIER}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>{AUTOSTART_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(program)
    )
}

/// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`. A relative
/// `XDG_CONFIG_HOME` is ignored, as the Base Directory spec says.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn xdg_autostart_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let config = match xdg_config_home.filter(|value| Path::new(value).is_absolute()) {
        Some(config) => PathBuf::from(config),
        None => PathBuf::from(home.filter(|value| !value.is_empty())?).join(".config"),
    };
    Some(config.join("autostart"))
}

/// Writes through a temporary file, so a crash leaves no half an entry.
#[cfg(unix)]
fn write_file(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, contents)?;
    std::fs::rename(&temporary, path)
}

#[cfg(unix)]
fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(target_os = "linux")]
fn entry_path() -> io::Result<PathBuf> {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    xdg_autostart_dir(xdg.as_deref(), home.as_deref())
        .map(|dir| dir.join(format!("{IDENTIFIER}.desktop")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no HOME for the autostart folder"))
}

#[cfg(target_os = "macos")]
fn entry_path() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no HOME for LaunchAgents"))?;
    Ok(PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("{IDENTIFIER}.plist")))
}

fn utf8(program: &Path) -> io::Result<&str> {
    program.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not valid UTF-8", program.display()),
        )
    })
}

/// Whether the entry is there. An entry the user switched off in the OS
/// (Task Manager, `Hidden=true`, Login Items) still counts: it is theirs to
/// switch on again, and the app never overrides it.
#[cfg(unix)]
pub fn is_registered() -> io::Result<bool> {
    entry_path()?.try_exists()
}

#[cfg(target_os = "linux")]
pub fn register(program: &Path) -> io::Result<()> {
    write_file(&entry_path()?, &desktop_entry(linux_program(program)?))
}

/// GLib looks the program up before it expands `%%`, so a path with a `%` in
/// it never starts, however it is escaped. Refuse it rather than write an
/// entry that does nothing.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_program(program: &Path) -> io::Result<&str> {
    let program = utf8(program)?;
    if program.contains('%') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{program} has a % in it, which an autostart entry cannot start"),
        ));
    }
    Ok(program)
}

#[cfg(target_os = "macos")]
pub fn register(program: &Path) -> io::Result<()> {
    write_file(&entry_path()?, &launch_agent(utf8(program)?))
}

#[cfg(unix)]
pub fn unregister() -> io::Result<()> {
    remove_file(&entry_path()?)
}

#[cfg(windows)]
mod registry {
    use std::io;

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(status: u32) -> io::Result<()> {
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status as i32))
        }
    }

    pub fn get(name: &str) -> io::Result<bool> {
        let (key, name) = (wide(RUN_KEY), wide(name));
        let mut size = 0u32;
        // SAFETY: both strings are NUL-terminated and outlive the call; a null
        // data pointer with a size pointer only asks for the value's size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        match status {
            ERROR_FILE_NOT_FOUND => Ok(false),
            status => check(status).map(|()| true),
        }
    }

    pub fn set(name: &str, value: &str) -> io::Result<()> {
        let (key, name, value) = (wide(RUN_KEY), wide(name), wide(value));
        // SAFETY: NUL-terminated buffers that outlive the call; the size is the
        // value's length in bytes, terminator included, as REG_SZ wants.
        check(unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        })
    }

    pub fn delete(name: &str) -> io::Result<()> {
        let (key, name) = (wide(RUN_KEY), wide(name));
        // SAFETY: NUL-terminated buffers that outlive the call.
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
            ERROR_FILE_NOT_FOUND => Ok(()),
            status => check(status),
        }
    }
}

#[cfg(windows)]
pub fn is_registered() -> io::Result<bool> {
    registry::get(ENTRY_NAME)
}

#[cfg(windows)]
pub fn register(program: &Path) -> io::Result<()> {
    registry::set(ENTRY_NAME, &windows_command(utf8(program)?))
}

#[cfg(windows)]
pub fn unregister() -> io::Result<()> {
    registry::delete(ENTRY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_windows_paths_with_spaces() {
        assert_eq!(
            windows_command(r"C:\Program Files\Lurkloot\lurkloot-desktop.exe"),
            r#""C:\Program Files\Lurkloot\lurkloot-desktop.exe" --autostart"#
        );
    }

    #[test]
    fn doubles_only_the_backslashes_before_a_quote() {
        assert_eq!(windows_quote(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(windows_quote(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(windows_quote(r"a\\b"), r#""a\\b""#);
    }

    #[test]
    fn quotes_desktop_exec_paths() {
        assert_eq!(
            desktop_exec_quote("/home/alex/My Apps/Lurkloot.AppImage"),
            r#""/home/alex/My Apps/Lurkloot.AppImage""#
        );
        // `$` escaped, then the escape's backslash doubled for the string value.
        assert_eq!(desktop_exec_quote("/a/$b"), r#""/a/\\$b""#);
        assert_eq!(desktop_exec_quote(r"/a\b"), r#""/a\\\\b""#);
        assert_eq!(desktop_exec_quote("/a/100%"), r#""/a/100%%""#);
        assert_eq!(desktop_exec_quote(r#"/a"b"#), r#""/a\\"b""#);
    }

    #[test]
    fn refuses_a_linux_program_path_with_a_percent_sign() {
        assert!(linux_program(Path::new("/opt/100% Apps/Lurkloot.AppImage")).is_err());
        assert_eq!(
            linux_program(Path::new("/opt/My $Apps/x")).unwrap(),
            "/opt/My $Apps/x"
        );
    }

    #[test]
    fn writes_a_desktop_entry_that_starts_in_the_tray() {
        let entry = desktop_entry("/opt/My Apps/Lurkloot.AppImage");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nExec=\"/opt/My Apps/Lurkloot.AppImage\" --autostart\n"));
        assert!(entry.contains("\nType=Application\n"));
    }

    #[test]
    fn escapes_the_launch_agent_path() {
        let plist = launch_agent("/Applications/Tom & Jerry/Lurkloot.app/Contents/MacOS/lurkloot");
        assert!(plist.contains(
            "<string>/Applications/Tom &amp; Jerry/Lurkloot.app/Contents/MacOS/lurkloot</string>"
        ));
        assert!(plist.contains("<string>--autostart</string>"));
        assert!(plist.contains("<string>name.jamezrin.lurkloot</string>"));
        assert!(!plist.contains("Tom & Jerry"));
    }

    // The only test that touches XDG_CONFIG_HOME, so it cannot race another.
    #[cfg(target_os = "linux")]
    #[test]
    fn registers_and_removes_the_entry_in_xdg_config_home() {
        let config =
            std::env::temp_dir().join(format!("lurkloot-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&config);
        std::env::set_var("XDG_CONFIG_HOME", &config);
        let entry = config.join("autostart/name.jamezrin.lurkloot.desktop");
        assert!(!is_registered().unwrap());
        register(Path::new("/opt/My Apps/Lurkloot.AppImage")).unwrap();
        assert!(is_registered().unwrap());
        let text = std::fs::read_to_string(&entry).unwrap();
        assert!(text.contains("Exec=\"/opt/My Apps/Lurkloot.AppImage\" --autostart"));
        unregister().unwrap();
        assert!(!is_registered().unwrap());
        // Removing what is not there is not an error.
        unregister().unwrap();
        std::env::remove_var("XDG_CONFIG_HOME");
        std::fs::remove_dir_all(&config).unwrap();
    }

    // Unix paths: on Windows "/home/alex" is not absolute.
    #[cfg(unix)]
    #[test]
    fn finds_the_xdg_autostart_folder() {
        assert_eq!(
            xdg_autostart_dir(Some("/home/alex/.config-work"), Some("/home/alex")),
            Some(PathBuf::from("/home/alex/.config-work/autostart"))
        );
        assert_eq!(
            xdg_autostart_dir(None, Some("/home/alex")),
            Some(PathBuf::from("/home/alex/.config/autostart"))
        );
        // Relative or empty XDG_CONFIG_HOME is ignored.
        assert_eq!(
            xdg_autostart_dir(Some("relative"), Some("/home/alex")),
            Some(PathBuf::from("/home/alex/.config/autostart"))
        );
        assert_eq!(
            xdg_autostart_dir(Some(""), Some("/home/alex")),
            Some(PathBuf::from("/home/alex/.config/autostart"))
        );
        assert_eq!(xdg_autostart_dir(None, None), None);
    }
}
