import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WindowItem } from '../types';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark-dimmed.css';

const TEXT_LIMIT_BYTES = 2_000_000;
const BINARY_LIMIT_BYTES = 25_000_000;
const MAX_HIGHLIGHT_CHARS = 200_000;

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  cs: 'csharp',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',
  ini: 'ini',
  log: 'plaintext',
  txt: 'plaintext',
};

const getExt = (path: string) => {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  return path.slice(idx + 1).toLowerCase();
};

type Props = {
  win: WindowItem & { type: 'file'; path: string };
  scale: number;
  active: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number, height: number) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
};

export function FileWindow({ win, scale, active, onMove, onResize, onFocus, onClose }: Props) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef(false);
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0, mx: 0, my: 0, edge: 'right' as 'left' | 'right' });

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [text, setText] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');

  const highlighted = useMemo(() => {
    if (status !== 'ready' || win.fileKind !== 'text') return null;
    if (!text) return null;
    if (text.length > MAX_HIGHLIGHT_CHARS) return null;
    const ext = getExt(win.path || '');
    const lang = ext ? LANG_BY_EXT[ext] : undefined;
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang }).value;
    }
    return hljs.highlightAuto(text).value;
  }, [status, win.fileKind, text, win.path]);

  useEffect(() => {
    let activeLoad = true;
    const load = async () => {
      setStatus('loading');
      setError('');
      setText('');
      setDataUrl('');
      if (!win.path) {
        setStatus('error');
        setError('Missing file path.');
        return;
      }

      try {
        if (win.fileKind === 'text') {
          const content = await invoke<string>('read_file_text', {
            path: win.path,
            maxBytes: TEXT_LIMIT_BYTES,
          });
          if (!activeLoad) return;
          setText(content);
        } else if (win.fileKind === 'image' || win.fileKind === 'pdf' || win.fileKind === 'video') {
          const base64 = await invoke<string>('read_file_base64', {
            path: win.path,
            maxBytes: BINARY_LIMIT_BYTES,
          });
          if (!activeLoad) return;
          const mime = win.fileMime || 'application/octet-stream';
          setDataUrl(`data:${mime};base64,${base64}`);
        } else {
          setStatus('error');
          setError('Unsupported file type for preview.');
          return;
        }
        setStatus('ready');
      } catch (err: any) {
        if (!activeLoad) return;
        setStatus('error');
        setError(err?.message || 'Failed to load file.');
      }
    };

    load();
    return () => {
      activeLoad = false;
    };
  }, [win.path, win.fileKind, win.fileMime]);

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
    const rightHandle = document.getElementById(`resize-${win.id}`);
    const leftHandle = document.getElementById(`resize-left-${win.id}`);
    if (!rightHandle && !leftHandle) return;

    const attach = (handle: HTMLElement, edge: 'left' | 'right') => {
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
          edge,
        };
        handle.setPointerCapture(e.pointerId);
        onFocus(win.id);
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!resizingRef.current) return;
        const dx = (e.clientX - startRef.current.mx) / scale;
        const dy = (e.clientY - startRef.current.my) / scale;
        const minW = 320;
        const minH = 200;
        let nextW = startRef.current.edge === 'left'
          ? startRef.current.w - dx
          : startRef.current.w + dx;
        nextW = Math.max(minW, nextW);
        const nextH = Math.max(minH, startRef.current.h + dy);
        if (startRef.current.edge === 'left') {
          const nextX = startRef.current.x + (startRef.current.w - nextW);
          onMove(win.id, nextX, startRef.current.y);
        }
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
    };

    const cleanupRight = rightHandle ? attach(rightHandle, 'right') : undefined;
    const cleanupLeft = leftHandle ? attach(leftHandle, 'left') : undefined;

    return () => {
      cleanupRight?.();
      cleanupLeft?.();
    };
  }, [scale, win.id, win.x, win.y, win.width, win.height, onResize, onMove, onFocus]);

  return (
    <div
      className={`terminal-window file-window ${active ? 'active' : ''}`}
      style={{
        left: `${win.x * scale}px`,
        top: `${win.y * scale}px`,
        width: `${win.width * scale}px`,
        height: `${win.height * scale}px`,
        zIndex: win.z,
      }}
      onPointerDown={() => onFocus(win.id)}
    >
      <div className="terminal-header" ref={headerRef}>
        <div className="terminal-title" title={win.path}>
          {win.name}
        </div>
        <div className="terminal-actions">
          <button className="close-btn" data-role="close" onClick={() => onClose(win.id)} title="Close">
            &times;
          </button>
        </div>
      </div>
      <div className="file-body">
        {status === 'loading' && <div className="file-status">Loading…</div>}
        {status === 'error' && <div className="file-status error">{error}</div>}
        {status === 'ready' && win.fileKind === 'text' && (
          highlighted ? (
            <pre className="file-code">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          ) : (
            <pre className="file-text">{text}</pre>
          )
        )}
        {status === 'ready' && win.fileKind === 'image' && (
          <img className="file-media" src={dataUrl} alt={win.name} />
        )}
        {status === 'ready' && win.fileKind === 'pdf' && (
          <iframe className="file-media" src={dataUrl} title={win.name} />
        )}
        {status === 'ready' && win.fileKind === 'video' && (
          <video className="file-media" src={dataUrl} controls />
        )}
      </div>
      <div className="terminal-resize left" id={`resize-left-${win.id}`} />
      <div className="terminal-resize" id={`resize-${win.id}`} />
    </div>
  );
}
