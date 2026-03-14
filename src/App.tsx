import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { FileTree } from './components/FileTree';
import { TerminalWindow } from './components/TerminalWindow';
import type { CanvasTransform, WindowItem } from './types';
import { createVoiceController } from './voice';
import './App.css';

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

export default function App() {
  const [transform, setTransform] = useState<CanvasTransform>({ x: 80, y: 80, scale: 1 });
  const [windows, setWindows] = useState<WindowItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState<string>(DEFAULT_SHORTCUT);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const zRef = useRef(10);
  const spawnedRef = useRef(false);
  const windowsRef = useRef<WindowItem[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const rootPathRef = useRef<string>('');
  const voiceRef = useRef<ReturnType<typeof createVoiceController> | null>(null);
  const toggleVoiceRef = useRef<() => void>(() => {});

  useEffect(() => {
    (window as any).__addLog = (m: string) => {
       invoke('log_frontend', { message: m }).catch(()=>{});
    };
    (window as any).__addLog('App mounted');
    const onPointerMove = (event: PointerEvent) => {
      if (!panRef.current.active) return;
      const dx = event.clientX - panRef.current.startX;
      const dy = event.clientY - panRef.current.startY;
      setTransform((prev) => ({
        ...prev,
        x: panRef.current.originX + dx,
        y: panRef.current.originY + dy,
      }));
    };

    const onPointerUp = () => {
      panRef.current.active = false;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    const stored = window.localStorage.getItem('voiceShortcut');
    if (stored && stored.trim()) {
      setShortcut(stored.trim());
    }
  }, []);

  const isBackgroundTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return true;
    return !target.closest('.terminal-window');
  };

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!isBackgroundTarget(event.target)) return;
    panRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;
    if (!isBackgroundTarget(event.target)) {
      return;
    }
    event.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;

    setTransform((prev) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio,
      };
    });
  };

  const screenToWorld = (clientX: number, clientY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (clientX - rect.left - transform.x) / transform.scale;
    const y = (clientY - rect.top - transform.y) / transform.scale;
    return { x, y };
  };

  const spawnTerminal = async (x: number, y: number, nameOverride?: string) => {
    (window as any).__addLog?.('spawning terminal...');
    const session = await invoke<{ id: string }>('create_session', {
      shell: null,
      cwd: rootPathRef.current || null,
    });

    const id = session.id;
    const name = nameOverride || `term-${windowsRef.current.length + 1}`;
    zRef.current += 1;
    const newWindow: WindowItem = {
      id,
      x,
      y,
      z: zRef.current,
      title: 'Terminal',
      name,
      sessionId: session.id,
      width: 520,
      height: 320,
      type: 'terminal',
    };

    setWindows((prev) => [...prev, newWindow]);
    setActiveId(id);
  };

  useEffect(() => {
    if (spawnedRef.current || !rootPath) return;
    spawnedRef.current = true;
    spawnTerminal(160, 160).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  }, [rootPath]);

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isBackgroundTarget(event.target)) return;
    const { x, y } = screenToWorld(event.clientX, event.clientY);
    spawnTerminal(x, y).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  };

  const updateWindow = (id: string, patch: Partial<WindowItem>) => {
    setWindows((prev) => prev.map((win) => (win.id === id ? { ...win, ...patch } : win)));
  };

  const handleFocus = (id: string) => {
    zRef.current += 1;
    updateWindow(id, { z: zRef.current });
    setActiveId(id);
  };

  const handleClose = (id: string) => {
    invoke('close_session', { id }).catch((err) => {
      console.error('close session failed', err);
    });
    setWindows((prev) => prev.filter((win) => win.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const handleNewTerminal = () => {
    const base = windows.length * 24;
    spawnTerminal(120 + base, 120 + base).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  };

  const handleRename = (id: string, name: string) => {
    updateWindow(id, { name });
  };

  const toggleVoice = async () => {
    if (!voiceRef.current) {
      voiceRef.current = createVoiceController({
        getWindows: () => windowsRef.current,
        getActiveId: () => activeIdRef.current,
        spawnTerminal: (x, y, name) => spawnTerminal(x, y, name),
        focusTerminal: handleFocus,
        renameTerminal: handleRename,
        closeTerminal: handleClose,
        log: (msg) => invoke('log_frontend', { message: msg }).catch(() => {}),
      });
    }

    if (voiceActive) {
      await voiceRef.current.stop();
      setVoiceActive(false);
      return;
    }

    try {
      setVoiceError(null);
      await voiceRef.current.start();
      setVoiceActive(true);
    } catch (err: any) {
      setVoiceError(err?.message || 'Voice start failed');
      setVoiceActive(false);
    }
  };

  useEffect(() => {
    toggleVoiceRef.current = () => {
      toggleVoice().catch((err) => {
        console.error('toggleVoice failed', err);
      });
    };
  }, [toggleVoice]);

  useEffect(() => {
    let cancelled = false;
    const setupShortcut = async () => {
      if (!shortcut) return;
      try {
        setShortcutError(null);
        if (await isRegistered(shortcut)) {
          await unregister(shortcut);
        }
        await register(shortcut, () => toggleVoiceRef.current());
      } catch (err: any) {
        if (!cancelled) {
          setShortcutError(err?.message || 'Failed to register shortcut');
        }
      }
    };
    setupShortcut();

    return () => {
      cancelled = true;
      if (shortcut) {
        unregister(shortcut).catch(() => {});
      }
    };
  }, [shortcut]);

  const promptShortcut = () => {
    const next = window.prompt('Set global shortcut (e.g. CommandOrControl+Shift+Space)', shortcut);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    window.localStorage.setItem('voiceShortcut', trimmed);
    setShortcut(trimmed);
  };

  const canvasStyle = useMemo(() => {
    return {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    } as React.CSSProperties;
  }, [transform]);

  return (
    <div className="app">
      <FileTree
        onRootChange={setRootPath}
        sessions={windows.map((win) => ({ id: win.id, name: win.name, active: activeId === win.id }))}
        onSelectSession={handleFocus}
        onRenameSession={handleRename}
      />

      <div className="topbar">
        <button
          className={`btn voice-btn ${voiceActive ? 'active' : ''}`}
          onClick={toggleVoice}
          title={voiceActive ? 'Stop voice control' : 'Start voice control'}
        >
          {voiceActive ? 'Voice: On' : 'Voice: Off'}
        </button>
        <div className="shortcut">
          <span>Shortcut</span>
          <span className="shortcut-key">{shortcut}</span>
          <button className="btn" onClick={promptShortcut}>
            Set Shortcut
          </button>
        </div>
        <button
          className="btn" onClick={handleNewTerminal}>
          + New Terminal
        </button>
        {voiceError && <div className="voice-error">{voiceError}</div>}
        {shortcutError && <div className="voice-error">{shortcutError}</div>}
        <div className="zoom">
          <span>Zoom</span>
          <span>{Math.round(transform.scale * 100)}%</span>
        </div>
      </div>

      <div
        className="canvas"
        ref={canvasRef}
        onPointerDown={beginPan}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      >
        <div className="canvas-grid" style={canvasStyle}>
          {windows.map((win) => (
            <TerminalWindow
              key={win.id}
              win={win}
              scale={transform.scale}
              active={activeId === win.id}
              onMove={(id, x, y) => updateWindow(id, { x, y })}
              onResize={(id, width, height) => updateWindow(id, { width, height })}
              onFocus={handleFocus}
              onClose={handleClose}
              onRename={handleRename}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
