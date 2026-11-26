//! Whether this desktop can show a tray icon. Closing the window keeps
//! farming in the tray, so on a desktop with no tray closing it must quit
//! instead, or the app would run with no way back to it.

/// Windows and macOS always have one.
#[cfg(not(target_os = "linux"))]
pub fn tray_available() -> bool {
    true
}

/// Linux tray icons are StatusNotifierItems, shown only while a
/// StatusNotifierWatcher owns its name on the session bus (KDE, most other
/// desktops, GNOME with the AppIndicator extension). Plain GNOME has none: the
/// icon would be created and never shown.
#[cfg(target_os = "linux")]
pub fn tray_available() -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(dbus) = zbus::blocking::fdo::DBusProxy::new(&connection) else {
        return false;
    };
    match "org.kde.StatusNotifierWatcher".try_into() {
        Ok(name) => dbus.name_has_owner(name).unwrap_or(false),
        Err(_) => false,
    }
}
