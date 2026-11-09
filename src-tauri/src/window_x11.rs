//! Integração da janela principal com o X11/XWayland no Linux.
//!
//! O runtime CEF embute o Chromium numa janela filha X11 e cria a janela
//! principal sobre GTK4 com uma `GtkApplication` anônima. Isso tem duas
//! consequências visíveis:
//!
//! * o GTK deixa `WM_CLASS` vazio, então o GNOME não associa a janela ao
//!   arquivo `.desktop` do aplicativo (ícone genérico, sem agrupamento);
//! * o arrasto nativo falha: o botão é pressionado dentro da janela do CEF
//!   (outro cliente X11), o GTK nunca registra o clique e `startDragging()`
//!   aborta com "window dragging requires a pointer button press".
//!
//! Aqui falamos X11 diretamente para corrigir os dois casos.

use std::time::{Duration, Instant};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt, EventMask, KeyButMask, PropMode,
};

/// Intervalo entre pedidos de movimento durante o arrasto (~120 Hz).
const DRAG_INTERVAL: Duration = Duration::from_millis(8);
/// Limite de segurança caso o botão nunca seja solto.
const DRAG_TIMEOUT: Duration = Duration::from_secs(60);

type DragResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// Retorna o XID da janela X11 por trás da janela do Tauri.
fn x11_window<W: HasWindowHandle>(window: &W) -> Option<u32> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => Some(handle.window as u32),
        RawWindowHandle::Xcb(handle) => Some(handle.window.get()),
        _ => None,
    }
}

/// Agenda a definição de `WM_CLASS` fora da thread principal.
///
/// `window_handle()` envia uma mensagem para o event loop e espera a resposta,
/// então não pode ser chamado na própria thread do event loop.
pub fn schedule_identity<W>(window: W, app_name: String)
where
    W: HasWindowHandle + Send + 'static,
{
    std::thread::spawn(move || {
        // A janela pode ainda não estar realizada quando a página começa a
        // carregar; tenta por alguns segundos.
        for _ in 0..100 {
            if apply_identity(&window, &app_name) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

/// Define `WM_CLASS` para que o gerenciador de janelas associe a janela ao
/// arquivo `.desktop` do aplicativo.
fn apply_identity<W: HasWindowHandle>(window: &W, app_name: &str) -> bool {
    let Some(xid) = x11_window(window) else {
        return false;
    };

    let Ok((connection, _)) = x11rb::connect(None) else {
        return false;
    };
    let Ok(cookie) = connection.intern_atom(false, b"WM_CLASS") else {
        return false;
    };
    let Ok(atom) = cookie.reply() else {
        return false;
    };

    // WM_CLASS(STRING) = "instância\0classe\0"
    let mut value = Vec::with_capacity(app_name.len() * 2 + 2);
    value.extend_from_slice(app_name.as_bytes());
    value.push(0);
    value.extend_from_slice(app_name.as_bytes());
    value.push(0);

    let changed = connection
        .change_property(
            PropMode::REPLACE,
            xid,
            atom.atom,
            AtomEnum::STRING,
            8,
            value.len() as u32,
            &value,
        )
        .is_ok()
        && connection.flush().is_ok();

    changed
}

/// Inicia um arrasto manual da janela.
///
/// O arrasto é feito pedindo ao gerenciador de janelas que mova a janela para
/// a posição do ponteiro a cada quadro, via `_NET_MOVERESIZE_WINDOW`. Esse
/// caminho funciona mesmo com o ponteiro capturado pela janela do CEF, ao
/// contrário de `_NET_WM_MOVERESIZE`, que o Mutter ignora nesse caso.
pub fn start_drag<W>(window: W)
where
    W: HasWindowHandle + Send + 'static,
{
    std::thread::spawn(move || {
        let Some(xid) = x11_window(&window) else {
            return;
        };
        if let Err(error) = drag_loop(xid) {
            eprintln!("GitLuna: não foi possível arrastar a janela: {error}");
        }
    });
}

fn drag_loop(xid: u32) -> DragResult {
    let (connection, screen) = x11rb::connect(None)?;
    let root = connection.setup().roots[screen].root;

    let start = connection.query_pointer(root)?.reply()?;
    if !start.mask.contains(KeyButMask::BUTTON1) {
        return Ok(());
    }

    let origin = connection.translate_coordinates(xid, root, 0, 0)?.reply()?;
    let atom = connection
        .intern_atom(false, b"_NET_MOVERESIZE_WINDOW")?
        .reply()?
        .atom;

    let deadline = Instant::now() + DRAG_TIMEOUT;
    let mut previous = (i16::MIN, i16::MIN);

    loop {
        std::thread::sleep(DRAG_INTERVAL);

        if Instant::now() > deadline {
            break;
        }

        let pointer = match connection
            .query_pointer(root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
        {
            Some(pointer) => pointer,
            None => break,
        };

        if !pointer.mask.contains(KeyButMask::BUTTON1) {
            break;
        }

        let offset = (
            pointer.root_x.wrapping_sub(start.root_x),
            pointer.root_y.wrapping_sub(start.root_y),
        );

        if offset == previous {
            continue;
        }
        previous = offset;

        let x = i32::from(origin.dst_x) + i32::from(offset.0);
        let y = i32::from(origin.dst_y) + i32::from(offset.1);

        // data.l[0]: gravidade (NorthWest) | flags x/y | indicação de origem
        // (aplicativo). Ver EWMH, _NET_MOVERESIZE_WINDOW.
        let event = ClientMessageEvent::new(
            32,
            xid,
            atom,
            ClientMessageData::from([1 | (0b0011 << 8) | (1 << 12), x as u32, y as u32, 0, 0]),
        );

        connection.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )?;
        connection.flush()?;
    }

    Ok(())
}
