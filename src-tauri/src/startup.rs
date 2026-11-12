//! Whether the installed companion starts when the person signs in, and their choice to stop that.
//!
//! Installing sets the start up: the installer's Run value on Windows, the Install block's login agent on macOS.
//! The choice is kept beside it, where the system keeps its own switch, so installing again does not undo it.

#[cfg(target_os = "macos")]
pub const LABEL: &str = "Start at login";
#[cfg(not(target_os = "macos"))]
pub const LABEL: &str = "Start at sign-in";

/// What the start is filed under: the installer's value name on Windows, the login agent's label on macOS.
pub fn entry(identifier: &str) -> String {
    if cfg!(windows) { "Grove Companion".into() } else { identifier.into() }
}

pub fn state(entry: &str) -> Option<bool> {
    system::state(entry)
}

pub fn set(entry: &str, on: bool) -> std::io::Result<()> {
    system::set(entry, on)
}

/// A click asks for the opposite of what the tick showed, whatever the menu did to the tick first,
/// and shows that, so a second click before the system is read again asks for the opposite once more.
pub fn chosen(shown: &mut Option<bool>) -> Option<bool> {
    let on = !(*shown)?;
    *shown = Some(on);
    Some(on)
}

#[cfg(windows)]
mod system {
    use std::io::{ErrorKind, Result};
    use winreg::{
        enums::{RegType, HKEY_CURRENT_USER},
        RegKey, RegValue,
    };

    pub const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// Where Settings > Startup apps and Task Manager keep their switch: a value whose first byte is odd turns the entry off.
    pub const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const OFF: [u8; 12] = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    pub fn state(entry: &str) -> Option<bool> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        user.open_subkey(RUN).ok()?.get_raw_value(entry).ok()?;
        let switch = user.open_subkey(APPROVED).and_then(|key| key.get_raw_value(entry));
        Some(!switch.is_ok_and(|value| value.bytes.first().is_some_and(|byte| byte % 2 == 1)))
    }

    pub fn set(entry: &str, on: bool) -> Result<()> {
        let (approved, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(APPROVED)?;
        if !on {
            return approved.set_raw_value(entry, &RegValue { vtype: RegType::REG_BINARY, bytes: OFF.to_vec().into() });
        }
        match approved.delete_value(entry) {
            Err(err) if err.kind() != ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::{
        io::{Error, Result},
        path::PathBuf,
        process::Command,
    };

    fn installed(entry: &str) -> bool {
        std::env::var_os("HOME").is_some_and(|home| PathBuf::from(home).join("Library/LaunchAgents").join(format!("{entry}.plist")).exists())
    }

    fn domain() -> String {
        format!("gui/{}", unsafe { libc::getuid() })
    }

    pub fn state(entry: &str) -> Option<bool> {
        if !installed(entry) {
            return None;
        }
        let listed = Command::new("launchctl").arg("print-disabled").arg(domain()).output().ok().filter(|out| out.status.success())?;
        Some(!off(&String::from_utf8_lossy(&listed.stdout), entry))
    }

    /// launchd lists each override as `"label" => disabled`, or `=> true` on older systems.
    pub fn off(listed: &str, entry: &str) -> bool {
        listed.lines().any(|line| {
            line.trim().strip_prefix(&format!("\"{entry}\" => ")).is_some_and(|value| matches!(value.trim(), "disabled" | "true"))
        })
    }

    pub fn set(entry: &str, on: bool) -> Result<()> {
        if !installed(entry) {
            return Err(Error::other("the login agent is not installed"));
        }
        let done = Command::new("launchctl").arg(if on { "enable" } else { "disable" }).arg(format!("{}/{entry}", domain())).output()?;
        if done.status.success() { Ok(()) } else { Err(Error::other(String::from_utf8_lossy(&done.stderr).trim().to_string())) }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod system {
    pub fn state(_: &str) -> Option<bool> {
        None
    }

    pub fn set(_: &str, _: bool) -> std::io::Result<()> {
        Err(std::io::Error::other("not supported here"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn each_click_asks_for_the_opposite_of_what_was_shown_once() {
        use super::chosen;

        let mut shown = Some(true);
        assert_eq!(chosen(&mut shown), Some(false));
        assert_eq!(chosen(&mut shown), Some(true), "a second click before the system is read again turns it back");
        let mut shown = Some(false);
        assert_eq!(chosen(&mut shown), Some(true));
        let mut shown = None;
        assert_eq!(chosen(&mut shown), None, "nothing to change when the setting cannot be read");
        assert_eq!(shown, None);
    }

    #[cfg(windows)]
    #[test]
    fn the_choice_is_kept_beside_the_installers_entry_and_read_back() {
        use super::*;
        use winreg::{enums::*, RegKey, RegValue};

        let entry = format!("Grove Companion test {}", std::process::id());
        let user = RegKey::predef(HKEY_CURRENT_USER);
        assert_eq!(state(&entry), None, "nothing starts it before it is installed");

        let (run, _) = user.create_subkey(system::RUN).unwrap();
        run.set_value(&entry, &"\"nowhere.exe\"").unwrap();
        let checked = std::panic::catch_unwind(|| {
            let approved = || RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(system::APPROVED, KEY_READ | KEY_WRITE).unwrap();
            assert_eq!(state(&entry), Some(true));

            set(&entry, false).unwrap();
            assert_eq!(state(&entry), Some(false));
            assert_eq!(approved().get_raw_value(&entry).unwrap().bytes.len(), 12, "the size Windows writes");
            assert!(RegKey::predef(HKEY_CURRENT_USER).open_subkey(system::RUN).unwrap().get_raw_value(&entry).is_ok(), "the installer's entry stays");

            set(&entry, true).unwrap();
            assert_eq!(state(&entry), Some(true));
            set(&entry, true).unwrap();

            // As Windows writes them: 02 on, 03 off, each followed by when.
            for (first, on) in [(2u8, true), (3, false), (1, false), (6, true)] {
                let mut bytes = vec![first, 0, 0, 0];
                bytes.extend([0x24, 0xC0, 0xFF, 0xAF, 0x9C, 0x0F, 0xDD, 0x01]);
                approved().set_raw_value(&entry, &RegValue { vtype: REG_BINARY, bytes: bytes.into() }).unwrap();
                assert_eq!(state(&entry), Some(on), "first byte {first}");
            }
        });
        let _ = run.delete_value(&entry);
        let _ = user.open_subkey_with_flags(system::APPROVED, KEY_WRITE).and_then(|key| key.delete_value(&entry));
        checked.unwrap();
        assert_eq!(state(&entry), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_launchds_list_of_what_is_turned_off() {
        use super::system::off;

        let label = "com.oddessentials.agentguild.companion";
        let listed = |value: &str| format!("disabled services = {{\n\t\"com.apple.other\" => disabled\n\t\"{label}\" => {value}\n}}\n");
        assert!(off(&listed("disabled"), label));
        assert!(off(&listed("true"), label));
        assert!(!off(&listed("enabled"), label));
        assert!(!off(&listed("false"), label));
        assert!(!off("disabled services = {\n}\n", label));
        assert!(!off(&listed("disabled"), "com.oddessentials.agentguild"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_login_agent_that_is_not_installed_is_neither_read_nor_changed() {
        use super::*;

        let entry = format!("com.oddessentials.agentguild.companion.test{}", std::process::id());
        assert_eq!(state(&entry), None);
        assert!(set(&entry, false).is_err());
    }
}
