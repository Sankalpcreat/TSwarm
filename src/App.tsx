import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileTree } from './components/FileTree';
import { TerminalWindow } from './components/TerminalWindow';
import type { CanvasTransform, WindowItem } from './types';
import './App.css';

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

export default function App() {
  const [transform, setTransform] = useState<CanvasTransform>({ x: 80, y: 80, scale: 1 });
  const [windows, setWindows] = useState<WindowItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const zRef = useRef(10);
  const spawnedRef = useRef(false);

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

  const spawnTerminal = async (x: number, y: number) => {
    (window as any).__addLog?.('spawning terminal...');
    const session = await invoke<{ id: string }>('create_session', {
      shell: null,
      cwd: rootPath || null,
    });

    const id = session.id;
    zRef.current += 1;
    const newWindow: WindowItem = {
      id,
      x,
      y,
      z: zRef.current,
      title: 'Terminal',
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

  const handleVoiceCommand = useCallback((text: string) => {
    if (!activeId) return;
    const win = windows.find((w) => w.id === activeId);
    if (!win) return;

    // Send text + enter key
    invoke('write_session', { id: win.sessionId, data: text + '\r' }).catch((err) => {
      console.error('Failed to send voice command', err);
    });
  }, [activeId, windows]);

  useEffect(() => {
    // Initialize Speech Recognition
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognitionAPI) {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        const script = event.results[0][0].transcript;
        console.log('[Voice]', script);
        invoke('log_frontend', { message: `Voice transcribed: ${script}` }).catch(()=>{});;
        handleVoiceCommand(script);
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        invoke('log_frontend', { message: `Voice error: ${event.error}` }).catch(()=>{});;
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } else {
      console.warn('Speech Recognition API not supported in this browser/environment.');
    }
  }, [handleVoiceCommand]);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const canvasStyle = useMemo(() => {
    return {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    } as React.CSSProperties;
  }, [transform]);

  return (
    <div className="app">
      <FileTree onRootChange={setRootPath} />

      <div className="topbar">
        <button
           className="btn microphone-btn"
           onClick={toggleListening}
           style={{ background: isListening ? 'rgba(255, 0, 0, 0.2)' : undefined, borderColor: isListening ? 'rgba(255, 0, 0, 0.5)' : undefined, marginRight: 8 }}
           title={isListening ? 'Stop Listening' : 'Speak a command'}
        >
          {isListening ? '🔴 Recording...' : '🎤 Voice Command'}
        </button>
        <button
          className="btn" onClick={handleNewTerminal}>
          + New Terminal
        </button>
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
            />
          ))}
        </div>
      </div>
    </div>
  );
}
