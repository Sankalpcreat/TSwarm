#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, EventField,
};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
const FN_KEYCODE: i64 = 179;
#[cfg(target_os = "macos")]
const LEGACY_FN_KEYCODE: i64 = 63;
#[cfg(target_os = "macos")]
const SPACE_KEYCODE: i64 = 49;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FnHotkeyMode {
    Off,
    Fn,
    FnSpace,
}

#[cfg(target_os = "macos")]
impl FnHotkeyMode {
    fn from_str(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "fn" => Self::Fn,
            "fn_space" | "fn+space" | "fn + space" => Self::FnSpace,
            _ => Self::Off,
        }
    }
}

#[cfg(target_os = "macos")]
struct FnHotkeyState {
    mode: FnHotkeyMode,
    is_fn_pressed: bool,
    last_transition: Option<Instant>,
}

#[cfg(target_os = "macos")]
impl Default for FnHotkeyState {
    fn default() -> Self {
        Self {
            mode: FnHotkeyMode::Off,
            is_fn_pressed: false,
            last_transition: None,
        }
    }
}

#[cfg(target_os = "macos")]
static STATE: OnceLock<Mutex<FnHotkeyState>> = OnceLock::new();
#[cfg(target_os = "macos")]
static APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "macos")]
static TAP_STARTED: OnceLock<()> = OnceLock::new();

#[cfg(target_os = "macos")]
fn emit_toggle() {
    if let Some(app) = APP.get() {
        let _ = app.emit("fn-hotkey", ());
    }
}

#[cfg(target_os = "macos")]
fn emit_error(message: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("fn-hotkey-error", message.to_string());
    }
}

#[cfg(target_os = "macos")]
fn with_state<F: FnOnce(&mut FnHotkeyState)>(f: F) {
    let state = STATE.get_or_init(|| Mutex::new(FnHotkeyState::default()));
    if let Ok(mut guard) = state.lock() {
        f(&mut guard);
    }
}

#[cfg(target_os = "macos")]
fn hotkey_callback(
    _proxy: core_graphics::event::CGEventTapProxy,
    event_type: CGEventType,
    event: &CGEvent,
) -> Option<CGEvent> {
    if !matches!(event_type, CGEventType::FlagsChanged | CGEventType::KeyDown) {
        return Some(event.clone());
    }

    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
    let flags = event.get_flags();
    let fn_flag = CGEventFlags::CGEventFlagSecondaryFn;

    with_state(|state| {
        match state.mode {
            FnHotkeyMode::Off => {}
            FnHotkeyMode::Fn => {
                if matches!(event_type, CGEventType::FlagsChanged) {
                    let function_pressed = flags.contains(fn_flag);
                    let is_fn_key = keycode == FN_KEYCODE || keycode == LEGACY_FN_KEYCODE;

                    if is_fn_key || (function_pressed != state.is_fn_pressed) {
                        let now = Instant::now();
                        if let Some(last) = state.last_transition {
                            if now.duration_since(last) < Duration::from_millis(60) {
                                return;
                            }
                        }
                        state.last_transition = Some(now);
                            state.is_fn_pressed = function_pressed;
                            if function_pressed {
                                emit_toggle();
                            }
                    }
                }
            }
            FnHotkeyMode::FnSpace => {
                if matches!(event_type, CGEventType::KeyDown)
                    && keycode == SPACE_KEYCODE
                    && flags.contains(fn_flag)
                {
                    emit_toggle();
                }
            }
        }
    });

    Some(event.clone())
}

#[cfg(target_os = "macos")]
fn start_tap_once() {
    if TAP_STARTED.get().is_some() {
        return;
    }
    TAP_STARTED.set(()).ok();

    std::thread::spawn(|| {
        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
            hotkey_callback,
        );

        let tap = match tap {
            Ok(t) => t,
            Err(_) => {
                emit_error("Failed to register Fn hotkey. Grant Accessibility permission in System Settings > Privacy & Security > Accessibility.");
                return;
            }
        };

        let run_loop_source = tap
            .mach_port
            .create_runloop_source(0)
            .expect("run loop source");
        let run_loop = CFRunLoop::get_current();
        unsafe {
            run_loop.add_source(&run_loop_source, kCFRunLoopCommonModes);
        }
        tap.enable();
        CFRunLoop::run_current();
    });
}

#[cfg(target_os = "macos")]
pub fn set_mode(app: AppHandle, mode: &str) {
    APP.set(app).ok();
    start_tap_once();
    let next_mode = FnHotkeyMode::from_str(mode);
    with_state(|state| {
        state.mode = next_mode;
        state.is_fn_pressed = false;
        state.last_transition = None;
    });
}

#[cfg(not(target_os = "macos"))]
pub fn set_mode(_app: tauri::AppHandle, _mode: &str) {
    // no-op on non-macOS
}
