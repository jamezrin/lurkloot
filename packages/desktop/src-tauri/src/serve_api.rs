//! The two control-plane calls the shell makes itself, for the Twitch sign-in
//! window (#1026): read the sign-in link, and post back the address Twitch
//! ended on. Plain HTTP to serve's loopback address with the launch's token;
//! no proxy, no Origin header. Neither the URL's answer nor the posted body is
//! ever logged.

use std::time::Duration;

use url::Url;

use crate::ready::is_loopback;
use crate::twitch_sign_in::{is_authorize_url, read_completion, SignInResult, BROWSER_LOGIN_PATH};

const TIMEOUT: Duration = Duration::from_secs(30);

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        // Never through a proxy from the environment: this is serve on this
        // machine, and the posted address carries the token.
        .proxy(None)
        .build()
        .into()
}

fn route(serve: &Url) -> Result<Url, SignInResult> {
    if serve.scheme() != "http" || !is_loopback(serve) {
        return Err(SignInResult::failed(
            None,
            "internal_error",
            "lurkloot serve is not on this machine",
        ));
    }
    serve.join(BROWSER_LOGIN_PATH).map_err(|_| {
        SignInResult::failed(
            None,
            "internal_error",
            "lurkloot serve's address is not valid",
        )
    })
}

fn unreachable(error: ureq::Error) -> SignInResult {
    SignInResult::failed(
        None,
        "network_error",
        format!("Could not reach lurkloot serve: {error}"),
    )
}

/// The Twitch sign-in link serve gives, checked to be Twitch's sign-in page.
pub fn sign_in_link(serve: &Url, token: &str) -> Result<Url, SignInResult> {
    let mut response = agent()
        .get(route(serve)?.as_str())
        .header("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(unreachable)?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(read_completion(status, &body));
    }
    let value: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    value
        .get("authorizeUrl")
        .and_then(|v| v.as_str())
        .and_then(|link| Url::parse(link).ok())
        .filter(is_authorize_url)
        .ok_or_else(|| {
            SignInResult::failed(
                Some(status),
                "internal_error",
                "lurkloot serve gave no Twitch sign-in link",
            )
        })
}

/// Posts the redirect address to serve, which reads, checks and saves the
/// token, and returns what the page is told.
pub fn complete(serve: &Url, token: &str, address: &str) -> SignInResult {
    let route = match route(serve) {
        Ok(route) => route,
        Err(result) => return result,
    };
    let body = serde_json::json!({ "address": address }).to_string();
    match agent()
        .post(route.as_str())
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(body)
    {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let text = response.body_mut().read_to_string().unwrap_or_default();
            read_completion(status, &text)
        }
        Err(error) => unreachable(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A stand-in serve that answers one request and reports what it got.
    fn stand_in(
        status: u16,
        body: &'static str,
    ) -> (Url, mpsc::Receiver<(String, Vec<String>, String)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = Vec::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let line = line.trim_end().to_owned();
                if line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                headers.push(line);
            }
            let mut body_in = vec![0; length];
            reader.read_exact(&mut body_in).unwrap();
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            tx.send((
                request_line.trim_end().to_owned(),
                headers,
                String::from_utf8(body_in).unwrap(),
            ))
            .unwrap();
        });
        (url, rx)
    }

    #[test]
    fn reads_the_sign_in_link_with_the_token() {
        let (serve, got) = stand_in(
            200,
            r#"{"platform":"twitch","authorizeUrl":"https://id.twitch.tv/oauth2/authorize?client_id=x","redirectUri":"https://www.twitch.tv/"}"#,
        );
        let link = sign_in_link(&serve, "launch-token").unwrap();
        assert_eq!(
            link.as_str(),
            "https://id.twitch.tv/oauth2/authorize?client_id=x"
        );
        let (line, headers, _) = got.recv().unwrap();
        assert_eq!(line, "GET /v1/session/auth/twitch/browser-login HTTP/1.1");
        assert!(headers
            .iter()
            .any(|h| h == "authorization: Bearer launch-token"));
        assert!(!headers
            .iter()
            .any(|h| h.to_ascii_lowercase().starts_with("origin:")));
    }

    #[test]
    fn refuses_a_link_that_is_not_twitchs_sign_in_page() {
        let (serve, _got) = stand_in(
            200,
            r#"{"authorizeUrl":"https://evil.example/oauth2/authorize"}"#,
        );
        assert!(matches!(
            sign_in_link(&serve, "t"),
            Err(SignInResult::Failed { .. })
        ));
    }

    #[test]
    fn posts_only_the_address() {
        let (serve, got) = stand_in(
            200,
            r#"{"platform":"twitch","environmentOverride":false,"login":"viewer"}"#,
        );
        let address = "https://www.twitch.tv/#access_token=abc123&scope=";
        assert_eq!(
            complete(&serve, "launch-token", address),
            SignInResult::SignedIn {
                login: Some("viewer".into()),
                environment_override: false
            }
        );
        let (line, headers, body) = got.recv().unwrap();
        assert_eq!(line, "POST /v1/session/auth/twitch/browser-login HTTP/1.1");
        assert!(headers
            .iter()
            .any(|h| h == "content-type: application/json"));
        assert_eq!(body, serde_json::json!({ "address": address }).to_string());
    }

    #[test]
    fn passes_serves_refusal_on() {
        let (serve, _got) = stand_in(
            400,
            r#"{"error":{"code":"login_rejected","message":"Twitch rejected the token"}}"#,
        );
        assert_eq!(
            complete(&serve, "t", "https://www.twitch.tv/#access_token=x"),
            SignInResult::failed(Some(400), "login_rejected", "Twitch rejected the token")
        );
    }

    #[test]
    fn never_calls_an_address_off_this_machine() {
        let serve = Url::parse("http://192.168.1.4:8420/").unwrap();
        assert!(matches!(
            complete(&serve, "t", "x"),
            SignInResult::Failed { .. }
        ));
        assert!(sign_in_link(&serve, "t").is_err());
    }
}
