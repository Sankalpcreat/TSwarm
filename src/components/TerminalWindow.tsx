import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import type { WindowItem } from '../types';
import { initTerminalEvents, registerTerminal, setTerminalPaused, unregisterTerminal } from '../terminalBridge';

const SCROLLBACK = 1500;

type Props = {
  win: WindowItem & { type: 'terminal'; sessionId: string };
  scale: number;
  active: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number, height: number) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onCommand?: (id: string, command: string) => void;
};

export function TerminalWindow({ win, scale, active, onMove, onResize, onFocus, onClose, onRename, onCommand }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const resizingRef = useRef(false);
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0, mx: 0, my: 0 });
  const inputBufferRef = useRef('');

  useEffect(() => {
    let isMounted = true;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let ro: ResizeObserver | null = null;

    const setup = async () => {
      term = new Terminal({
        fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        scrollback: SCROLLBACK,
        cursorBlink: true,
        theme: {
          background: '#0a0b10',
          foreground: '#a0a8b7',
          cursor: '#ffffff',
          selectionBackground: 'rgba(255, 255, 255, 0.2)',
        },
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      if (containerRef.current) {
        term.open(containerRef.current);
      }
      termRef.current = term;

      await initTerminalEvents();
      if (!isMounted) return;

      if (containerRef.current && fitAddon) {
        fitAddon.fit();
        registerTerminal(win.sessionId, term);
        invoke('log_frontend', { message: `registered ${win.sessionId} cols=${term.cols} rows=${term.rows}` }).catch(()=>{});
        setTerminalPaused(win.sessionId, false);
        invoke('resize_session', { id: win.sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
      }
      setTimeout(() => {
        term.focus();
      }, 0);

      term.onData((data) => {
        invoke('write_session', { id: win.sessionId, data }).catch((err) => {
          console.error('write_session failed', err);
        });

        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            const cmd = inputBufferRef.current.trim();
            if (cmd) {
              onCommand?.(win.id, cmd);
            }
            inputBufferRef.current = '';
          } else if (ch === '\u007f') {
            inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          } else if (ch >= ' ') {
            inputBufferRef.current += ch;
          }
        }
      });

      ro = new ResizeObserver(() => {
        if (!fitAddon || !term) return;
        fitAddon.fit();
        invoke('resize_session', { id: win.sessionId, cols: term.cols, rows: term.rows }).catch((err) => {
          console.error('resize_session failed', err);
        });
      });

      if (containerRef.current) {
        ro.observe(containerRef.current);
      }
    };

    setup();

    return () => {
      isMounted = false;
      if (ro && containerRef.current) ro.unobserve(containerRef.current);
      if (term) term.dispose();
      unregisterTerminal(win.sessionId);
    };
  }, [win.sessionId]);

  useEffect(() => {
    setTerminalPaused(win.sessionId, !active);
    if (active) {
      termRef.current?.focus();
    }
  }, [active, win.sessionId]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).dataset.role === 'close') return;
      draggingRef.current = true;
      startRef.current = {
        ...startRef.current,
        mx: e.clientX,
        my: e.clientY,
        x: win.x,
        y: win.y,
        w: win.width,
        h: win.height,
      };
      header.setPointerCapture(e.pointerId);
      onFocus(win.id);
      termRef.current?.focus();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = (e.clientX - startRef.current.mx) / scale;
      const dy = (e.clientY - startRef.current.my) / scale;
      onMove(win.id, startRef.current.x + dx, startRef.current.y + dy);
    };

    const onPointerUp = (e: PointerEvent) => {
      draggingRef.current = false;
      header.releasePointerCapture(e.pointerId);
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);

    return () => {
      header.removeEventListener('pointerdown', onPointerDown);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', onPointerUp);
    };
  }, [scale, win.id, win.x, win.y, win.width, win.height, onMove, onFocus]);

  useEffect(() => {
    const handle = document.getElementById(`resize-${win.id}`);
    if (!handle) return;

    const onPointerDown = (e: PointerEvent) => {
      resizingRef.current = true;
      startRef.current = {
        ...startRef.current,
        mx: e.clientX,
        my: e.clientY,
        x: win.x,
        y: win.y,
        w: win.width,
        h: win.height,
      };
      handle.setPointerCapture(e.pointerId);
      onFocus(win.id);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!resizingRef.current) return;
      const dx = (e.clientX - startRef.current.mx) / scale;
      const dy = (e.clientY - startRef.current.my) / scale;
      const nextW = Math.max(280, startRef.current.w + dx);
      const nextH = Math.max(160, startRef.current.h + dy);
      onResize(win.id, nextW, nextH);
    };

    const onPointerUp = (e: PointerEvent) => {
      resizingRef.current = false;
      handle.releasePointerCapture(e.pointerId);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
    };
  }, [scale, win.id, win.x, win.y, win.width, win.height, onResize, onFocus]);

  return (
    <div
      className={`terminal-window ${active ? 'active' : ''}`}
      style={{
        left: `${win.x}px`,
        top: `${win.y}px`,
        width: `${win.width}px`,
        height: `${win.height}px`,
        zIndex: win.z,
      }}
      onPointerDown={() => {
        onFocus(win.id);
        termRef.current?.focus();
      }}
    >
      <div className="terminal-header" ref={headerRef}>
        <div
          className="terminal-title"
          onDoubleClick={(e) => {
            e.stopPropagation();
            const next = window.prompt('Rename session', win.name);
            if (next && next.trim()) onRename(win.id, next.trim());
          }}
          title="Double-click to rename"
        >
          {win.name}
        </div>
        <div className="terminal-actions">
          <button
            className="close-btn"
            data-role="close"
            onClick={() => onClose(win.id)}
            title="Close"
          >&times;</button>
        </div>
      </div>
      <div
        className="terminal-body"
        ref={containerRef}
        onPointerDown={(e) => {
          e.stopPropagation();
          onFocus(win.id);
          setTimeout(() => termRef.current?.focus(), 0);
        }}
      />
      <div className="terminal-resize" id={`resize-${win.id}`} />
    </div>
  );
}
