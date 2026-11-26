//! Runs the bundled `lurkloot serve` as the app's child and keeps it running
//! (#1024). Nothing here knows about Tauri, so the tests drive it with a stand-in
//! serve.
//!
//! - `serve` is started with `--port 0 --ready-json --exit-with-stdin`. Its stdin
//!   stays a pipe this process holds, so `serve` stops when the app closes it,
//!   or when the OS closes it after a crash.
//! - Both of its output streams are read for its whole life and written to a
//!   log file, so a full pipe can never stall farming. The first ready line
//!   on stdout gives the URL to show.
//! - When it exits unexpectedly it is started again after a backoff. The
//!   caller is told each failure, to show an error once they repeat.
//! - Shutdown closes stdin and waits for `serve` to save its state and exit,
//!   then kills its whole process tree (cycletls's helper included) if it has
//!   not: a process group on Linux and macOS, a job object on Windows (or
//!   taskkill's tree kill when the job could not be set up).

use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use url::Url;

use crate::ready::parse_ready_line;

/// How long a started `serve` has to print its ready line.
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// A `serve` that ran this long after it was ready had started fine: its exit
/// starts the failure count again.
pub const STABLE_AFTER: Duration = Duration::from_secs(60);
/// The longest wait between restarts.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// What to start, and where its output goes.
#[derive(Clone, Debug)]
pub struct SidecarSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub log_path: PathBuf,
}

/// The arguments the desktop app starts `serve` with.
pub fn serve_args(config_path: &std::path::Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "serve",
        "--port",
        "0",
        "--ready-json",
        "--exit-with-stdin",
        "--config",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(config_path.as_os_str().to_owned());
    args
}

/// The environment `serve` runs with: this process's own, without any
/// `LURKLOOT_*` or `SA_*` variable a CLI user's shell may have set (a token,
/// another cycletls port, credential overrides), plus the launch's token and
/// a cycletls port of its own (0: cycletls's helper on a free port, never
/// attached to another process's helper on 9119).
pub fn serve_env(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    token: &str,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(key, _)| !is_scrubbed(key))
        .collect();
    env.push((crate::token::SERVE_TOKEN_ENV.into(), token.into()));
    env.push((CYCLETLS_PORT_ENV.into(), "0".into()));
    env
}

/// The variable that gives cycletls's helper a port of its own
/// (`CYCLETLS_PORT_ENV` in packages/cli/src/transport/cycle.ts).
pub const CYCLETLS_PORT_ENV: &str = "LURKLOOT_CYCLETLS_PORT";

/// The wait before restart number `failures` (1 for the first): 1 s, doubling,
/// at most MAX_BACKOFF.
pub fn backoff(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(16);
    Duration::from_secs(1u64 << exponent).min(MAX_BACKOFF)
}

/// What the supervisor reports.
pub trait SidecarEvents: Send + Sync + 'static {
    /// `serve` is ready at this URL (again, after a restart: a new port).
    fn ready(&self, url: Url);
    /// `serve` failed to start or exited unexpectedly, for the `failures`th
    /// time in a row; it is started again after a backoff.
    fn failed(&self, failures: u32, detail: String);
}

/// Kills a started `serve` and everything it started.
struct TreeKiller {
    #[cfg(unix)]
    group: libc::pid_t,
    #[cfg(windows)]
    pid: u32,
    // None when the job object could not be set up: serve still runs, and a
    // kill falls back to taskkill's tree kill.
    #[cfg(windows)]
    job: Option<windows_job::Job>,
}

impl TreeKiller {
    fn kill(&self) {
        #[cfg(unix)]
        // SAFETY: kill(2) with a negative pid signals that process group only.
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        #[cfg(windows)]
        match &self.job {
            Some(job) => job.terminate(),
            None => {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &self.pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

#[derive(Default)]
struct Shared {
    stopping: bool,
    stdin: Option<ChildStdin>,
    killer: Option<Arc<TreeKiller>>,
}

struct Inner {
    state: Mutex<Shared>,
    wake: Condvar,
}

/// The running supervisor. Dropping it does not stop `serve`; call shutdown.
pub struct Supervisor {
    inner: Arc<Inner>,
    done: Mutex<Option<(mpsc::Receiver<()>, JoinHandle<()>)>>,
}

impl Supervisor {
    pub fn start(spec: SidecarSpec, events: Arc<dyn SidecarEvents>) -> Supervisor {
        let inner = Arc::new(Inner {
            state: Mutex::new(Shared::default()),
            wake: Condvar::new(),
        });
        let (done_tx, done_rx) = mpsc::channel();
        let thread_inner = Arc::clone(&inner);
        let handle = thread::Builder::new()
            .name("serve-supervisor".into())
            .spawn(move || {
                supervise(&spec, &thread_inner, events.as_ref());
                let _ = done_tx.send(());
            })
            .expect("the supervisor thread starts");
        Supervisor {
            inner,
            done: Mutex::new(Some((done_rx, handle))),
        }
    }

    /// Stops `serve`: closes its stdin so it saves its state and exits, waits
    /// up to `grace` for that, then kills its process tree. Returns once it
    /// is gone. Later calls return at once.
    pub fn shutdown(&self, grace: Duration) {
        let killer = {
            let mut state = self.inner.state.lock().unwrap();
            state.stopping = true;
            // Dropping our end of the pipe is what `--exit-with-stdin` waits for.
            state.stdin.take();
            self.inner.wake.notify_all();
            state.killer.clone()
        };
        let Some((done, handle)) = self.done.lock().unwrap().take() else {
            return;
        };
        if done.recv_timeout(grace).is_err() {
            if let Some(killer) = killer.or_else(|| self.inner.state.lock().unwrap().killer.clone())
            {
                killer.kill();
            }
            let _ = done.recv_timeout(Duration::from_secs(5));
        }
        let _ = handle.join();
    }
}

fn stopping(inner: &Inner) -> bool {
    inner.state.lock().unwrap().stopping
}

fn supervise(spec: &SidecarSpec, inner: &Inner, events: &dyn SidecarEvents) {
    let log = Arc::new(Mutex::new(open_log(spec)));
    let mut failures = 0u32;
    while !stopping(inner) {
        let outcome = run_once(spec, inner, events, &log);
        if stopping(inner) {
            break;
        }
        let detail = match outcome {
            Outcome::SpawnFailed(error) => format!("Could not start lurkloot serve: {error}"),
            Outcome::NotReady {
                timed_out: true, ..
            } => "lurkloot serve did not report ready in time".to_owned(),
            Outcome::NotReady { status, .. } => {
                format!("lurkloot serve exited before it was ready ({status})")
            }
            Outcome::Exited { status, stable } => {
                if stable {
                    failures = 0;
                }
                format!("lurkloot serve exited unexpectedly ({status})")
            }
        };
        failures += 1;
        write_log_line(
            &log,
            &format!("[desktop] {detail}; restarting in {:?}", backoff(failures)),
        );
        events.failed(failures, detail);
        let deadline = Instant::now() + backoff(failures);
        let mut state = inner.state.lock().unwrap();
        while !state.stopping {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = inner.wake.wait_timeout(state, deadline - now).unwrap().0;
        }
    }
}

enum Outcome {
    SpawnFailed(std::io::Error),
    NotReady { status: ExitStatus, timed_out: bool },
    Exited { status: ExitStatus, stable: bool },
}

fn run_once(
    spec: &SidecarSpec,
    inner: &Inner,
    events: &dyn SidecarEvents,
    log: &Arc<Mutex<Option<File>>>,
) -> Outcome {
    let mut child = match spawn(spec) {
        Ok(child) => child,
        Err(error) => return Outcome::SpawnFailed(error),
    };
    let killer = Arc::new(tree_killer(&child, log));
    {
        let mut state = inner.state.lock().unwrap();
        state.killer = Some(Arc::clone(&killer));
        // A shutdown that came while it started: its stdin is dropped at once.
        state.stdin = if state.stopping {
            None
        } else {
            child.stdin.take()
        };
    }
    let (ready_tx, ready_rx) = mpsc::channel();
    let readers = [
        child
            .stdout
            .take()
            .map(|out| pump(out, Arc::clone(log), Some(ready_tx))),
        child
            .stderr
            .take()
            .map(|err| pump(err, Arc::clone(log), None)),
    ];

    let mut ready_at = None;
    let mut timed_out = false;
    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(url) => {
            ready_at = Some(Instant::now());
            if !stopping(inner) {
                events.ready(url);
            }
        }
        // stdout closed: serve is exiting; its status says why.
        Err(RecvTimeoutError::Disconnected) => {}
        Err(RecvTimeoutError::Timeout) => {
            timed_out = true;
            killer.kill();
        }
    }
    let status = child.wait();
    match &status {
        Ok(status) => write_log_line(log, &format!("[desktop] lurkloot serve exited ({status})")),
        Err(error) => write_log_line(
            log,
            &format!("[desktop] waiting for lurkloot serve failed: {error}"),
        ),
    }
    // Whatever serve left behind (a cycletls helper after a crash) goes too.
    killer.kill();
    for reader in readers.into_iter().flatten() {
        let _ = reader.join();
    }
    {
        let mut state = inner.state.lock().unwrap();
        state.stdin = None;
        state.killer = None;
    }
    match (status, ready_at) {
        (Err(error), _) => Outcome::SpawnFailed(error),
        (Ok(status), None) => Outcome::NotReady { status, timed_out },
        (Ok(status), Some(at)) => Outcome::Exited {
            status,
            stable: at.elapsed() >= STABLE_AFTER,
        },
    }
}

fn spawn(spec: &SidecarSpec) -> std::io::Result<Child> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = spec.program.parent() {
        command.current_dir(dir);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the whole tree can be signalled at once.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

fn tree_killer(child: &Child, log: &Mutex<Option<File>>) -> TreeKiller {
    #[cfg(unix)]
    {
        let _ = log;
        TreeKiller {
            group: child.id() as libc::pid_t,
        }
    }
    #[cfg(windows)]
    {
        let job = windows_job::Job::new().and_then(|job| job.assign(child).map(|()| job));
        if let Err(error) = &job {
            write_log_line(
                log,
                &format!("[desktop] no job object for lurkloot serve ({error}); a forced stop uses taskkill"),
            );
        }
        TreeKiller {
            pid: child.id(),
            job: job.ok(),
        }
    }
}

/// Reads a stream to its end, line by line, into the log. On stdout the first
/// ready line is sent on `ready`.
fn pump(
    stream: impl Read + Send + 'static,
    log: Arc<Mutex<Option<File>>>,
    mut ready: Option<mpsc::Sender<Url>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            write_log_line(&log, text);
            if let Some(url) = ready.as_ref().and_then(|_| parse_ready_line(text)) {
                if let Some(sender) = ready.take() {
                    let _ = sender.send(url);
                }
            }
        }
    })
}

fn open_log(spec: &SidecarSpec) -> Option<File> {
    if let Some(dir) = spec.log_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Truncated on each launch of the app; restarts within it append.
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&spec.log_path)
        .ok()
}

fn write_log_line(log: &Mutex<Option<File>>, line: &str) {
    if let Some(file) = log.lock().unwrap().as_mut() {
        let _ = writeln!(file, "{line}");
    }
}

/// Whether a variable name is one `serve_env` keeps out of `serve`.
pub fn is_scrubbed(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key.starts_with("LURKLOOT_") || key.starts_with("SA_")
}

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };

    /// A job object holding `serve` and every process it starts, so a forced
    /// stop ends the whole tree at once. It has no kill-on-close limit: when
    /// the app crashes, the OS closes serve's stdin pipe and serve saves its
    /// state and exits on its own, as on every other OS.
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Job> {
            // SAFETY: creates a job this value then owns.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(Job(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> std::io::Result<()> {
            // SAFETY: the child's process handle is valid while `child` lives.
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub fn terminate(&self) {
            // SAFETY: the handle is open until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closes the handle this value owns, once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_serve_for_a_launcher() {
        let args = serve_args(std::path::Path::new("/data/config.json"));
        let args: Vec<_> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "serve",
                "--port",
                "0",
                "--ready-json",
                "--exit-with-stdin",
                "--config",
                "/data/config.json"
            ]
        );
    }

    #[test]
    fn keeps_the_users_lurkloot_and_credential_variables_out() {
        let inherited = [
            ("PATH", "/usr/bin"),
            ("LURKLOOT_SERVE_TOKEN", "someone-elses"),
            ("lurkloot_cycletls_port", "9119"),
            ("SA_TWITCH_AUTH_TOKEN", "secret"),
            ("HOME", "/home/me"),
        ]
        .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let env = serve_env(inherited, "fresh-token");
        let pairs: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            [
                ("PATH", "/usr/bin"),
                ("HOME", "/home/me"),
                ("LURKLOOT_SERVE_TOKEN", "fresh-token"),
                ("LURKLOOT_CYCLETLS_PORT", "0"),
            ]
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
        );
        assert!(is_scrubbed(OsStr::new("Lurkloot_Anything")));
        assert!(!is_scrubbed(OsStr::new("PATH")));
    }

    #[test]
    fn backs_off_up_to_a_minute() {
        let waits: Vec<u64> = (1..=9).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    // The rest drive a stand-in serve: a shell script that behaves as the
    // launcher options describe.
    #[cfg(unix)]
    mod fake_serve {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicU32, Ordering};

        #[derive(Default)]
        struct Recorder {
            ready: Mutex<Vec<Url>>,
            failures: AtomicU32,
            details: Mutex<Vec<String>>,
        }

        impl SidecarEvents for Recorder {
            fn ready(&self, url: Url) {
                self.ready.lock().unwrap().push(url);
            }
            fn failed(&self, failures: u32, detail: String) {
                self.failures.store(failures, Ordering::SeqCst);
                self.details.lock().unwrap().push(detail);
            }
        }

        fn script(dir: &std::path::Path, body: &str) -> PathBuf {
            let path = dir.join("serve.sh");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn temp_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("lurkloot-desktop-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn spec(dir: &std::path::Path, program: PathBuf) -> SidecarSpec {
            SidecarSpec {
                program,
                args: vec![],
                env: vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default())],
                log_path: dir.join("logs").join("serve.log"),
            }
        }

        fn wait_until(what: &str, check: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !check() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn alive(pid: libc::pid_t) -> bool {
            // SAFETY: signal 0 only checks that the process exists.
            unsafe { libc::kill(pid, 0) == 0 }
        }

        #[test]
        fn reports_the_ready_url_and_stops_when_stdin_closes() {
            let dir = temp_dir("ready");
            // Output before and after the ready line, then wait for stdin EOF
            // and leave a mark, as serve saves its state on the way out.
            let program = script(
                &dir,
                &format!(
                    "echo 'starting up'\necho 'warn: on stderr' >&2\n\
                     echo '{{\"event\":\"ready\",\"url\":\"http://127.0.0.1:49152/\"}}'\n\
                     echo 'after ready'\ncat >/dev/null\necho saved > '{}'",
                    dir.join("saved").display()
                ),
            );
            let events = Arc::new(Recorder::default());
            let supervisor = Supervisor::start(spec(&dir, program), events.clone());
            wait_until("ready", || !events.ready.lock().unwrap().is_empty());
            assert_eq!(
                events.ready.lock().unwrap()[0].as_str(),
                "http://127.0.0.1:49152/"
            );

            supervisor.shutdown(Duration::from_secs(10));
            assert!(
                dir.join("saved").exists(),
                "serve got to save before it exited"
            );
            assert_eq!(events.failures.load(Ordering::SeqCst), 0);
            let log = std::fs::read_to_string(dir.join("logs").join("serve.log")).unwrap();
            for line in ["starting up", "warn: on stderr", "after ready"] {
                assert!(log.contains(line), "{line} in {log}");
            }
        }

        #[test]
        fn kills_the_whole_tree_when_serve_will_not_stop() {
            let dir = temp_dir("stuck");
            let pid_file = dir.join("helper.pid");
            // Ignores stdin EOF and SIGTERM, and starts a helper of its own, as
            // serve starts cycletls's.
            let program = script(
                &dir,
                &format!(
                    "trap '' TERM\nsleep 300 &\necho $! > '{}'\n\
                     echo '{{\"event\":\"ready\",\"url\":\"http://127.0.0.1:49153/\"}}'\n\
                     while true; do sleep 1; done",
                    pid_file.display()
                ),
            );
            let events = Arc::new(Recorder::default());
            let supervisor = Supervisor::start(spec(&dir, program), events.clone());
            wait_until("ready", || !events.ready.lock().unwrap().is_empty());
            let helper: libc::pid_t = std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(alive(helper));

            let started = Instant::now();
            supervisor.shutdown(Duration::from_millis(300));
            assert!(started.elapsed() < Duration::from_secs(5));
            wait_until("the helper to be gone", || !alive(helper) || zombie(helper));
        }

        fn zombie(pid: libc::pid_t) -> bool {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| stat.split_whitespace().nth(2) == Some("Z"))
                .unwrap_or(false)
        }

        #[test]
        fn restarts_serve_after_it_exits_and_counts_failures() {
            let dir = temp_dir("restart");
            let program = script(
                &dir,
                "echo '{\"event\":\"ready\",\"url\":\"http://127.0.0.1:49154/\"}'\nexit 3",
            );
            let events = Arc::new(Recorder::default());
            let supervisor = Supervisor::start(spec(&dir, program), events.clone());
            // 1 s before the second start, 2 s before the third.
            wait_until("two failures", || {
                events.failures.load(Ordering::SeqCst) >= 2
            });
            supervisor.shutdown(Duration::from_secs(5));
            assert!(events.ready.lock().unwrap().len() >= 2);
            assert!(events.details.lock().unwrap()[0].contains("exited unexpectedly"));
        }

        #[test]
        fn reports_a_serve_that_cannot_start() {
            let dir = temp_dir("missing");
            let events = Arc::new(Recorder::default());
            let supervisor =
                Supervisor::start(spec(&dir, dir.join("no-such-serve")), events.clone());
            wait_until("a failure", || events.failures.load(Ordering::SeqCst) >= 1);
            supervisor.shutdown(Duration::from_secs(5));
            assert!(events.details.lock().unwrap()[0].starts_with("Could not start lurkloot serve"));
        }

        #[test]
        fn a_serve_that_exits_before_ready_is_a_failed_start() {
            let dir = temp_dir("early");
            let program = script(&dir, "echo 'config is broken' >&2\nexit 1");
            let events = Arc::new(Recorder::default());
            let supervisor = Supervisor::start(spec(&dir, program), events.clone());
            wait_until("a failure", || events.failures.load(Ordering::SeqCst) >= 1);
            supervisor.shutdown(Duration::from_secs(5));
            assert!(events.ready.lock().unwrap().is_empty());
            assert!(events.details.lock().unwrap()[0]
                .starts_with("lurkloot serve exited before it was ready"));
        }
    }
}
