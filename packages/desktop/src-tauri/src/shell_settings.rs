//! The shell's own settings (#1027), kept in `desktop.json` in the app's
//! config folder. They are about the app itself, not farming, so they never
//! go in serve's `config.json`, and serve never reads them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file name in the app's config folder.
pub const FILE_NAME: &str = "desktop.json";

/// The argument the OS's startup entry passes, so a launch at sign-in starts
/// in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellSettings {
    /// Start the app when the user signs in to the computer. Off by default.
    pub launch_at_startup: bool,
    /// Check GitHub releases for a new version on start and every few hours
    /// (#1028). On by default; an update is still installed only when the
    /// user chooses.
    pub automatic_updates: bool,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            launch_at_startup: false,
            automatic_updates: true,
        }
    }
}

/// Reads and writes the settings file.
pub struct SettingsFile {
    path: PathBuf,
}

impl SettingsFile {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join(FILE_NAME),
        }
    }

    /// The saved settings. A missing or unreadable file is the defaults, so a
    /// broken file never stops the app from starting.
    pub fn load(&self) -> ShellSettings {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Saves the settings through a temporary file, so a crash mid-write
    /// leaves the old file whole.
    pub fn save(&self, settings: &ShellSettings) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut body = serde_json::to_vec_pretty(settings)?;
        body.push(b'\n');
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, body)?;
        std::fs::rename(&temporary, &self.path)
    }
}

/// Whether the OS started this launch from the startup entry.
pub fn is_autostart_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

/// A launch at sign-in starts with no window, but only when there is a tray
/// to open it from; with none, the window is the only way to the app.
pub fn start_hidden(autostart_launch: bool, has_tray: bool) -> bool {
    autostart_launch && has_tray
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lurkloot-shell-settings-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_to_off_without_a_file() {
        let dir = temp_dir("missing");
        assert_eq!(SettingsFile::in_dir(&dir).load(), ShellSettings::default());
        assert!(!ShellSettings::default().launch_at_startup);
    }

    #[test]
    fn saves_and_loads_launch_at_startup() {
        let dir = temp_dir("round-trip");
        let file = SettingsFile::in_dir(&dir);
        file.save(&ShellSettings {
            launch_at_startup: true,
            ..ShellSettings::default()
        })
        .unwrap();
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(text.contains("\"launchAtStartup\": true"), "{text}");
        assert!(file.load().launch_at_startup);
        assert!(!dir.join("desktop.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn checks_for_updates_unless_turned_off() {
        let dir = temp_dir("updates");
        std::fs::create_dir_all(&dir).unwrap();
        let file = SettingsFile::in_dir(&dir);
        assert!(file.load().automatic_updates);
        // A file from before the setting existed keeps it on.
        std::fs::write(dir.join(FILE_NAME), "{\"launchAtStartup\": true}").unwrap();
        let settings = file.load();
        assert!(settings.launch_at_startup && settings.automatic_updates);
        std::fs::write(dir.join(FILE_NAME), "{\"automaticUpdates\": false}").unwrap();
        assert!(!file.load().automatic_updates);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_or_partial_file_is_the_defaults() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        let file = SettingsFile::in_dir(&dir);
        std::fs::write(dir.join(FILE_NAME), "{not json").unwrap();
        assert_eq!(file.load(), ShellSettings::default());
        std::fs::write(dir.join(FILE_NAME), "{\"somethingElse\": 1}").unwrap();
        assert_eq!(file.load(), ShellSettings::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn spots_the_startup_argument_but_not_as_the_program() {
        assert!(is_autostart_launch(["lurkloot-desktop", "--autostart"]));
        assert!(!is_autostart_launch(["lurkloot-desktop"]));
        assert!(!is_autostart_launch(["--autostart"]));
        assert!(!is_autostart_launch(["lurkloot-desktop", "--autostart=1"]));
    }

    #[test]
    fn starts_hidden_only_with_a_tray() {
        assert!(start_hidden(true, true));
        assert!(!start_hidden(true, false));
        assert!(!start_hidden(false, true));
    }
}
