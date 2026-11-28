//! Where the app window may go. It shows serve's app UI and the shell's own
//! status page, nothing else: a link to any other site opens in the system
//! browser, and anything that is not a web address is refused.

use url::Url;

/// A scheme, host and port, compared as written. `url::Origin` cannot be used:
/// it makes the shell's own `tauri://localhost` an opaque origin, which never
/// equals another.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Site {
    scheme: String,
    host: Option<String>,
    port: Option<u16>,
}

impl Site {
    pub fn of(url: &Url) -> Self {
        Site {
            scheme: url.scheme().to_ascii_lowercase(),
            host: url.host_str().map(str::to_ascii_lowercase),
            port: url.port_or_known_default(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// Load it in the app window.
    Allow,
    /// Open it in the system browser and keep the window where it is.
    OpenExternally,
    /// Neither (file:, javascript:, data:, a custom scheme).
    Refuse,
}

/// Decides a navigation of the app window's main frame. `serve` is the origin
/// of the running serve, when there is one; `shell` is the origin of the
/// shell's bundled pages, once known.
pub fn decide(url: &Url, serve: Option<&Site>, shell: Option<&Site>) -> Navigation {
    let site = Site::of(url);
    if serve.is_some_and(|serve| *serve == site) || shell.is_some_and(|shell| *shell == site) {
        return Navigation::Allow;
    }
    external(url)
}

/// What to do with a link the page asked to open in a new window
/// (`window.open`, `target="_blank"`): never a window inside the app.
pub fn external(url: &Url) -> Navigation {
    match url.scheme() {
        "http" | "https" if url.host().is_some() => Navigation::OpenExternally,
        _ => Navigation::Refuse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn keeps_the_window_on_serve_and_the_shell_pages() {
        let serve = Site::of(&url("http://127.0.0.1:49152/"));
        let shell = Site::of(&url("tauri://localhost/index.html"));
        assert_eq!(
            decide(
                &url("http://127.0.0.1:49152/drops"),
                Some(&serve),
                Some(&shell)
            ),
            Navigation::Allow
        );
        assert_eq!(
            decide(
                &url("tauri://localhost/index.html#failed"),
                Some(&serve),
                Some(&shell)
            ),
            Navigation::Allow
        );
    }

    #[test]
    fn sends_other_sites_to_the_system_browser() {
        let serve = Site::of(&url("http://127.0.0.1:49152/"));
        for other in [
            "https://www.twitch.tv/directory",
            "https://kick.com/",
            "http://127.0.0.1:49153/",
            "http://localhost:49152/",
        ] {
            assert_eq!(
                decide(&url(other), Some(&serve), None),
                Navigation::OpenExternally,
                "{other}"
            );
        }
    }

    #[test]
    fn loads_no_loopback_page_before_serve_is_ready() {
        assert_eq!(
            decide(&url("http://127.0.0.1:49152/"), None, None),
            Navigation::OpenExternally
        );
    }

    #[test]
    fn refuses_what_is_not_a_web_address() {
        let serve = Site::of(&url("http://127.0.0.1:49152/"));
        for other in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "lurkloot://x",
            "mailto:a@b.c",
        ] {
            assert_eq!(
                decide(&url(other), Some(&serve), None),
                Navigation::Refuse,
                "{other}"
            );
        }
    }
}
