//! Twitch sign-in without pasting the redirect (#1026). The app UI's "Sign in
//! to Twitch" link is caught by the shell, which opens Twitch's sign-in page in
//! a private window of its own. When that window is sent to the redirect URI
//! with the token in its fragment, the shell stops the navigation, closes the
//! window and posts the address to serve's browser-login route, the same one
//! the paste flow uses. Nothing here knows about Tauri.
//!
//! The token never reaches the main window, the logs or the disk outside the
//! CLI's auth store: only the redirect address goes to serve, and the page is
//! told the outcome (signed in as whom, cancelled, or why it failed).

use url::{Host, Url};

/// The property the main window's initialization script defines, which tells
/// the app UI it runs inside the desktop app (`DESKTOP_HOST_PROPERTY` in
/// packages/app-ui/src/desktopHost.ts).
pub const DESKTOP_HOST_PROPERTY: &str = "lurklootDesktop";

/// The event the shell dispatches on the main window with the outcome
/// (`TWITCH_SIGN_IN_EVENT` in packages/app-ui/src/desktopHost.ts).
pub const TWITCH_SIGN_IN_EVENT: &str = "lurkloot:twitch-sign-in";

/// The route that gives the sign-in link and takes the address back
/// (packages/cli/src/runtime/controlPlaneAuth.ts).
pub const BROWSER_LOGIN_PATH: &str = "/v1/session/auth/twitch/browser-login";

/// The fragment the app UI adds to the sign-in link to ask for the sign-in
/// window (`SIGN_IN_WINDOW_FRAGMENT` in packages/app-ui/src/desktopHost.ts).
/// The unmarked link, from the paste steps, goes to the system browser.
pub const SIGN_IN_WINDOW_FRAGMENT: &str = "lurkloot-sign-in-window";

/// Whether a link the app UI asked to open asks for the sign-in window:
/// Twitch's sign-in page, marked with SIGN_IN_WINDOW_FRAGMENT. The shell opens
/// its window from the link serve gives the shell itself; the page's link is
/// only the signal.
pub fn wants_sign_in_window(url: &Url) -> bool {
    is_authorize_url(url) && url.fragment() == Some(SIGN_IN_WINDOW_FRAGMENT)
}

/// Whether a link is Twitch's sign-in page.
pub fn is_authorize_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host() == Some(Host::Domain("id.twitch.tv"))
        && url.port().is_none()
        && url.path() == "/oauth2/authorize"
}

/// What a navigation of the sign-in window means.
#[derive(Debug, PartialEq, Eq)]
pub enum Redirect {
    /// Not the redirect URI: let the window go there.
    Elsewhere,
    /// The redirect URI with Twitch's answer (a token or a refusal): this
    /// whole address is what serve's route reads, and the only thing posted.
    Answer(String),
    /// The redirect URI, but this web view did not show the fragment, so the
    /// answer cannot be read here and the paste flow has to be used.
    Unreadable,
}

/// Reads a navigation of the sign-in window. The redirect URI is exactly
/// `https://www.twitch.tv/` (TWITCH_BROWSER_LOGIN_REDIRECT_URI in
/// packages/cli/src/auth/twitchBrowserLogin.ts); every navigation there is
/// stopped, so twitch.tv never loads with the token in its address.
pub fn read_navigation(url: &Url) -> Redirect {
    let is_redirect_uri = url.scheme() == "https"
        && url.host() == Some(Host::Domain("www.twitch.tv"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/";
    if !is_redirect_uri {
        return Redirect::Elsewhere;
    }
    let has = |part: Option<&str>, key: &str| {
        part.is_some_and(|part| url::form_urlencoded::parse(part.as_bytes()).any(|(k, _)| k == key))
    };
    if has(url.fragment(), "access_token")
        || has(url.fragment(), "error")
        || has(url.query(), "error")
    {
        Redirect::Answer(url.as_str().to_owned())
    } else {
        Redirect::Unreadable
    }
}

/// Whether the sign-in window may load a page: Twitch's sign-in runs over
/// https across several hosts (id.twitch.tv, www.twitch.tv/login, its CDN's
/// frames), and frames start at about:blank. Nothing else.
pub fn sign_in_window_may_load(url: &Url) -> bool {
    url.scheme() == "https" || url.as_str() == "about:blank"
}

/// The outcome the app UI is told. It never carries the token or the address.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SignInResult {
    #[serde(rename_all = "camelCase")]
    SignedIn {
        #[serde(skip_serializing_if = "Option::is_none")]
        login: Option<String>,
        environment_override: bool,
    },
    Cancelled,
    /// `error` is serve's `{ code, message }` with the HTTP status when serve
    /// answered; the shell's own failures use the codes below.
    Failed {
        error: SignInError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SignInError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl SignInResult {
    pub fn failed(status: Option<u16>, code: &str, message: impl Into<String>) -> Self {
        SignInResult::Failed {
            error: SignInError {
                status,
                code: code.to_owned(),
                message: message.into(),
            },
        }
    }

    /// The web view did not show Twitch's answer: the UI falls back to pasting.
    pub fn unreadable() -> Self {
        SignInResult::failed(
            None,
            "redirect_unreadable",
            "The sign-in window could not read Twitch's answer; paste the address instead",
        )
    }
}

/// The script that tells the main window the outcome.
pub fn result_script(result: &SignInResult) -> String {
    let event = serde_json::to_string(TWITCH_SIGN_IN_EVENT).expect("a string serializes");
    let detail = serde_json::to_string(result).expect("a result serializes");
    format!("window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));")
}

/// Reads serve's answer to the posted address: `{ login?, environmentOverride }`
/// on success, `{ error: { code, message } }` otherwise.
pub fn read_completion(status: u16, body: &str) -> SignInResult {
    let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    if (200..300).contains(&status) {
        return SignInResult::SignedIn {
            login: value
                .get("login")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            environment_override: value
                .get("environmentOverride")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        };
    }
    let error = value.get("error");
    let text = |key: &str| error.and_then(|e| e.get(key)).and_then(|v| v.as_str());
    SignInResult::failed(
        Some(status),
        text("code").unwrap_or("internal_error"),
        text("message").unwrap_or("lurkloot serve refused the sign-in"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn recognises_twitchs_sign_in_link() {
        assert!(is_authorize_url(&url(
            "https://id.twitch.tv/oauth2/authorize?client_id=x&response_type=token&redirect_uri=https%3A%2F%2Fwww.twitch.tv%2F"
        )));
        for other in [
            "http://id.twitch.tv/oauth2/authorize",
            "https://id.twitch.tv.evil.example/oauth2/authorize",
            "https://id.twitch.tv:8443/oauth2/authorize",
            "https://id.twitch.tv/oauth2/token",
            "https://www.twitch.tv/",
        ] {
            assert!(!is_authorize_url(&url(other)), "{other}");
        }
    }

    #[test]
    fn opens_the_window_only_for_the_marked_link() {
        let link = "https://id.twitch.tv/oauth2/authorize?client_id=x";
        assert!(wants_sign_in_window(&url(&format!(
            "{link}#lurkloot-sign-in-window"
        ))));
        // The paste steps' unmarked link goes to the system browser.
        assert!(!wants_sign_in_window(&url(link)));
        assert!(!wants_sign_in_window(&url(&format!("{link}#other"))));
        assert!(!wants_sign_in_window(&url(
            "https://evil.example/oauth2/authorize#lurkloot-sign-in-window"
        )));
    }

    #[test]
    fn takes_the_redirect_with_a_token_or_a_refusal() {
        for answer in [
            "https://www.twitch.tv/#access_token=abc123&scope=&token_type=bearer",
            "https://www.twitch.tv/#error=access_denied&error_description=The+user+denied",
            "https://www.twitch.tv/?error=redirect_mismatch&error_description=x",
        ] {
            assert_eq!(
                read_navigation(&url(answer)),
                Redirect::Answer(url(answer).to_string()),
                "{answer}"
            );
        }
    }

    #[test]
    fn stops_the_redirect_uri_even_when_its_answer_cannot_be_read() {
        assert_eq!(
            read_navigation(&url("https://www.twitch.tv/")),
            Redirect::Unreadable
        );
        assert_eq!(
            read_navigation(&url("https://www.twitch.tv/#scope=")),
            Redirect::Unreadable
        );
    }

    #[test]
    fn leaves_every_other_address_alone() {
        for other in [
            // Twitch's own sign-in steps.
            "https://id.twitch.tv/oauth2/authorize?client_id=x",
            "https://www.twitch.tv/login?client_id=x&redirect_params=y",
            "https://passport.twitch.tv/login",
            // Lookalikes of the redirect URI.
            "https://www.twitch.tv/directory#access_token=abc",
            "https://twitch.tv/#access_token=abc",
            "https://www.twitch.tv.evil.example/#access_token=abc",
            "https://evil.example/www.twitch.tv/#access_token=abc",
            "https://www.twitch.tv:444/#access_token=abc",
            "https://user:pass@www.twitch.tv/#access_token=abc",
            "http://www.twitch.tv/#access_token=abc",
        ] {
            assert_eq!(read_navigation(&url(other)), Redirect::Elsewhere, "{other}");
        }
    }

    #[test]
    fn the_sign_in_window_loads_only_https_and_blank_frames() {
        assert!(sign_in_window_may_load(&url(
            "https://id.twitch.tv/oauth2/authorize"
        )));
        assert!(sign_in_window_may_load(&url(
            "https://k.twitchcdn.net/x/fp"
        )));
        assert!(sign_in_window_may_load(&url("about:blank")));
        for other in [
            "http://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
        ] {
            assert!(!sign_in_window_may_load(&url(other)), "{other}");
        }
    }

    #[test]
    fn tells_the_page_the_outcome_and_never_the_token() {
        let signed_in = SignInResult::SignedIn {
            login: Some("viewer".into()),
            environment_override: false,
        };
        assert_eq!(
            result_script(&signed_in),
            r#"window.dispatchEvent(new CustomEvent("lurkloot:twitch-sign-in", { detail: {"status":"signedIn","login":"viewer","environmentOverride":false} }));"#
        );
        assert!(result_script(&SignInResult::Cancelled).contains(r#"{"status":"cancelled"}"#));
        let failed = result_script(&SignInResult::unreadable());
        assert!(failed.contains(r#""status":"failed","error":{"code":"redirect_unreadable""#));
        // Text from serve stays one JSON string value, never code.
        let message = "\"}); alert(1); ({\"";
        let script = result_script(&SignInResult::failed(Some(400), "x", message));
        let detail = script
            .strip_prefix(
                r#"window.dispatchEvent(new CustomEvent("lurkloot:twitch-sign-in", { detail: "#,
            )
            .and_then(|rest| rest.strip_suffix(" }));"))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(detail).unwrap();
        assert_eq!(parsed["error"]["message"], message);
    }

    #[test]
    fn reads_serves_answer() {
        assert_eq!(
            read_completion(
                200,
                r#"{"platform":"twitch","environmentOverride":true,"login":"viewer"}"#
            ),
            SignInResult::SignedIn {
                login: Some("viewer".into()),
                environment_override: true
            }
        );
        assert_eq!(
            read_completion(
                400,
                r#"{"error":{"code":"invalid_redirect","message":"Twitch refused the sign-in"}}"#
            ),
            SignInResult::failed(Some(400), "invalid_redirect", "Twitch refused the sign-in")
        );
        assert_eq!(
            read_completion(502, "not json"),
            SignInResult::failed(
                Some(502),
                "internal_error",
                "lurkloot serve refused the sign-in"
            )
        );
    }
}
