//! Automatic updates from GitHub releases (#1028), through Tauri's updater.
//! The updater checks its own signature on every download, against the public
//! key in tauri.conf.json and bound to the version it announces
//! (`requireSignedVersion`), so it works while the installers are unsigned
//! for the OS. The app never restarts on its own: a found update is announced
//! in the tray and the window, and installed when the user chooses. The
//! bundled sidecar is inside the update, so serve and the shell always match.
//!
//! The portable Windows zip never updates itself: the updater can only run an
//! installer, which would install a second copy beside the unpacked one.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use url::Url;

/// The first check waits for serve to be up and the desktop to settle.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Then every few hours.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A check that takes longer than this gives up until the next one.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole download, for the largest update on a slow connection; past it
/// the install fails and can be tried again.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The event the window's app UI hears an update's progress on
/// (`DESKTOP_UPDATE_EVENT` in packages/app-ui/src/desktopHost.ts).
pub const UPDATE_EVENT: &str = "lurkloot:desktop-update";
/// The window property that keeps the latest update state, for an app UI
/// that mounts after the event (`DESKTOP_UPDATE_PROPERTY` in
/// packages/app-ui/src/desktopHost.ts).
pub const UPDATE_PROPERTY: &str = "lurklootDesktopUpdate";
/// The fragment of the link the app UI opens to ask for the install
/// (`INSTALL_UPDATE_FRAGMENT` in packages/app-ui/src/desktopHost.ts).
pub const INSTALL_UPDATE_FRAGMENT: &str = "lurkloot-install-update";
/// The page that link points at; a plain browser that somehow opens it lands
/// on the desktop app's guide page.
pub const INSTALL_UPDATE_PAGE: &str = "https://lurkloot.jamezrin.com/guide/headless/desktop";

/// The file beside the executable in the portable Windows zip
/// (`PORTABLE_MARKER` in packages/desktop/scripts/collectInstallers.mjs).
pub const PORTABLE_MARKER: &str = "portable.txt";

/// Whether the executable in `exe_dir` runs from the portable zip, which turns
/// the updater off: no checks and no tray item for them.
pub fn is_portable(exe_dir: &Path) -> bool {
    exe_dir.join(PORTABLE_MARKER).is_file()
}

/// What the window shows about an update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Notice {
    /// Found and ready to install.
    Ready { version: String },
    /// Downloading and installing; the app restarts when done.
    Installing { version: String },
    /// The download or its signature check failed; it can be tried again.
    Failed { version: String },
}

/// Whether the app UI opened the install link.
pub fn wants_install(url: &Url) -> bool {
    url.fragment() == Some(INSTALL_UPDATE_FRAGMENT)
        && Url::parse(INSTALL_UPDATE_PAGE).is_ok_and(|page| {
            url.scheme() == page.scheme()
                && url.host_str() == page.host_str()
                && url.port() == page.port()
                && url.path() == page.path()
        })
}

/// The script that tells the window's app UI about the update: kept on the
/// window for an app UI that has not mounted yet, and sent as an event for one
/// that has.
pub fn notice_script(notice: &Notice) -> String {
    let event = serde_json::to_string(UPDATE_EVENT).expect("a string serializes");
    let property = serde_json::to_string(UPDATE_PROPERTY).expect("a string serializes");
    let detail = serde_json::to_string(notice).expect("a notice serializes");
    format!(
        "(function () {{ var detail = {detail}; window[{property}] = detail; window.dispatchEvent(new CustomEvent({event}, {{ detail: detail }})); }})();"
    )
}

/// The tray item's label for a notice.
pub fn tray_label(notice: &Notice) -> String {
    match notice {
        Notice::Ready { version } | Notice::Failed { version } => {
            format!("Update ready: restart to install {version}")
        }
        Notice::Installing { version } => format!("Installing {version}…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn only_the_marker_file_makes_a_copy_portable() {
        let dir = std::env::temp_dir().join(format!("lurkloot-portable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_portable(&dir));
        std::fs::create_dir(dir.join(PORTABLE_MARKER)).unwrap();
        assert!(
            !is_portable(&dir),
            "a folder by that name is not the marker"
        );
        std::fs::remove_dir(dir.join(PORTABLE_MARKER)).unwrap();
        std::fs::write(dir.join(PORTABLE_MARKER), "portable").unwrap();
        assert!(is_portable(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_install_link_asks_for_the_install() {
        assert!(wants_install(&url(
            "https://lurkloot.jamezrin.com/guide/headless/desktop#lurkloot-install-update"
        )));
        for other in [
            "https://lurkloot.jamezrin.com/guide/headless/desktop",
            "https://lurkloot.jamezrin.com/guide/headless/desktop#other",
            "https://lurkloot.jamezrin.com/#lurkloot-install-update",
            "https://lurkloot.jamezrin.com.evil.example/guide/headless/desktop#lurkloot-install-update",
            "http://lurkloot.jamezrin.com/guide/headless/desktop#lurkloot-install-update",
            "https://lurkloot.jamezrin.com:8443/guide/headless/desktop#lurkloot-install-update",
        ] {
            assert!(!wants_install(&url(other)), "{other}");
        }
    }

    #[test]
    fn the_notice_script_dispatches_the_event_with_its_state() {
        let script = notice_script(&Notice::Ready {
            version: "1.26.0".into(),
        });
        assert_eq!(
            script,
            r#"(function () { var detail = {"status":"ready","version":"1.26.0"}; window["lurklootDesktopUpdate"] = detail; window.dispatchEvent(new CustomEvent("lurkloot:desktop-update", { detail: detail })); })();"#
        );
        assert!(notice_script(&Notice::Installing {
            version: "1.26.0".into()
        })
        .contains(r#""status":"installing""#));
        assert!(notice_script(&Notice::Failed {
            version: "1.26.0".into()
        })
        .contains(r#""status":"failed""#));
    }

    #[test]
    fn a_crafted_version_cannot_break_out_of_the_script() {
        let script = notice_script(&Notice::Ready {
            version: "\"});alert(1);//</script>".into(),
        });
        assert!(script.contains(r#""version":"\"});alert(1);//</script>""#));
        assert!(script.ends_with("})();"));
    }

    #[test]
    fn the_tray_says_what_to_do() {
        assert_eq!(
            tray_label(&Notice::Ready {
                version: "1.26.0".into()
            }),
            "Update ready: restart to install 1.26.0"
        );
        assert_eq!(
            tray_label(&Notice::Installing {
                version: "1.26.0".into()
            }),
            "Installing 1.26.0…"
        );
    }
}
