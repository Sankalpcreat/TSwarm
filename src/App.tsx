import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { FileTree } from './components/FileTree';
import { FileWindow } from './components/FileWindow';
import { TerminalWindow } from './components/TerminalWindow';
import type { CanvasTransform, FileKind, WindowItem } from './types';
import { createVoiceController } from './voice';
import { getTerminalOutput } from './terminalBridge';
import './App.css';

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const DEFAULT_SHORTCUT = 'Fn';

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
  'css', 'html', 'xml', 'yml', 'yaml', 'toml', 'sh', 'zsh', 'bash', 'env', 'ini', 'log',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);
const PDF_EXTS = new Set(['pdf']);

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const getFileName = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const inferFileKind = (path: string): { kind: FileKind; mime?: string } => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (PDF_EXTS.has(ext)) return { kind: 'pdf', mime: MIME_BY_EXT[ext] };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', mime: MIME_BY_EXT[ext] };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', mime: MIME_BY_EXT[ext] };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'unknown' };
};

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
  const [shortcutHint, setShortcutHint] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const zRef = useRef(10);
  const spawnedRef = useRef(false);
  const windowsRef = useRef<WindowItem[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const rootPathRef = useRef<string>('');
  const voiceRef = useRef<ReturnType<typeof createVoiceController> | null>(null);
  const toggleVoiceRef = useRef<() => void>(() => {});
  const lastGlobalShortcutRef = useRef<string | null>(null);
  const speakerRef = useRef(true);
  const voiceEnabledRef = useRef(true);
  const saveTimerRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const codexAssignedRef = useRef(new Set<string>());
  const codexStatusRequestedRef = useRef(new Set<string>());
  const claudeStatusRequestedRef = useRef(new Set<string>());
  const pendingResumeRef = useRef(
    new Map<string, { kind: 'codex' | 'claude' | 'gemini'; startedAt: number; baseline: Set<string> }>()
  );

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
    speakerRef.current = speakerEnabled;
  }, [speakerEnabled]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    const stored = window.localStorage.getItem('voiceShortcut');
    if (stored && stored.trim()) {
      const trimmed = stored.trim();
      setShortcut(trimmed);
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
    const win = windowsRef.current.find((w) => w.id === id);
    if (win?.type === 'terminal' && win.sessionId) {
      invoke('close_session', { id: win.sessionId }).catch((err) => {
        console.error('close session failed', err);
      });
    }
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

  const getCanvasCenter = () => {
    if (!canvasRef.current) return { x: 160, y: 160 };
    const rect = canvasRef.current.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const openFileWindow = (path: string) => {
    const existing = windowsRef.current.find((w) => w.type === 'file' && w.path === path);
    if (existing) {
      handleFocus(existing.id);
      return;
    }
    const { kind, mime } = inferFileKind(path);
    const { x, y } = getCanvasCenter();
    const id = crypto.randomUUID();
    zRef.current += 1;
    const offset = windowsRef.current.length * 18;
    const newWindow: WindowItem = {
      id,
      x: x + offset,
      y: y + offset,
      z: zRef.current,
      title: 'File',
      name: getFileName(path),
      width: 520,
      height: 360,
      type: 'file',
      path,
      fileKind: kind,
      fileMime: mime,
    };
    setWindows((prev) => [...prev, newWindow]);
    setActiveId(id);
  };

  const spawnFileWindowFromState = (path: string, state: Partial<WindowItem>) => {
    const { kind, mime } = inferFileKind(path);
    const id = crypto.randomUUID();
    zRef.current = Math.max(zRef.current + 1, state.z ?? zRef.current);
    const newWindow: WindowItem = {
      id,
      x: state.x ?? 160,
      y: state.y ?? 160,
      z: state.z ?? zRef.current,
      title: 'File',
      name: state.name || getFileName(path),
      width: state.width ?? 520,
      height: state.height ?? 360,
      type: 'file',
      path,
      fileKind: kind,
      fileMime: mime,
    };
    return newWindow;
  };

  const buildResumeCommand = (kind: WindowItem['terminalKind'], resumeId: string) => {
    if (kind === 'claude') return `claude --resume ${resumeId}`;
    if (kind === 'gemini') return `gemini --resume ${resumeId}`;
    return `codex resume ${resumeId}`;
  };

  const startCliInTerminal = async (
    sessionId: string,
    kind?: WindowItem['terminalKind'],
    resumeId?: string
  ) => {
    if (!kind) return;
    const command = resumeId ? buildResumeCommand(kind, resumeId) :
      (kind === 'claude' ? 'claude' : kind === 'gemini' ? 'gemini' : 'codex');
    await invoke('write_session', { id: sessionId, data: `${command}\r` }).catch(() => {});
  };

  const handleCommand = (winId: string, command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (trimmed === 'codex' || trimmed.startsWith('codex ')) {
      updateWindow(winId, { terminalKind: 'codex' });
      pendingResumeRef.current.set(winId, { kind: 'codex', startedAt: Date.now(), baseline: new Set() });
    } else if (trimmed === 'claude' || trimmed.startsWith('claude ')) {
      updateWindow(winId, { terminalKind: 'claude' });
      pendingResumeRef.current.set(winId, { kind: 'claude', startedAt: Date.now(), baseline: new Set() });
    } else if (trimmed === 'gemini' || trimmed.startsWith('gemini ')) {
      updateWindow(winId, { terminalKind: 'gemini' });
      pendingResumeRef.current.set(winId, { kind: 'gemini', startedAt: Date.now(), baseline: new Set() });
    }
  };

  const buildState = () => {
    return {
      version: 1,
      projectPath: rootPath,
      transform,
      activeId,
      windows: windows.map((win) => {
        if (win.type === 'terminal') {
          return {
            type: 'terminal',
            name: win.name,
            x: win.x,
            y: win.y,
            width: win.width,
            height: win.height,
            z: win.z,
            terminalKind: win.terminalKind,
            resumeSessionId: win.resumeSessionId,
          };
        }
        return {
          type: 'file',
          name: win.name,
          path: win.path,
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
          z: win.z,
        };
      }),
    };
  };

  const saveState = () => {
    if (!rootPath || restoringRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const payload = JSON.stringify(buildState());
      invoke('save_canvas_state', { projectPath: rootPath, state: payload }).catch((err) => {
        console.warn('save state failed', err);
      });
    }, 500);
  };

  useEffect(() => {
    saveState();
  }, [windows, transform, activeId, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    const load = async () => {
      restoringRef.current = true;
      try {
        const raw = await invoke<string | null>('load_canvas_state', { projectPath: rootPath });
        if (!raw || cancelled) {
          restoringRef.current = false;
          return;
        }
        const state = JSON.parse(raw);
        if (!state || !Array.isArray(state.windows)) {
          restoringRef.current = false;
          return;
        }
        spawnedRef.current = true;
        const restored: WindowItem[] = [];
        for (const w of state.windows) {
          if (w.type === 'terminal') {
            const session = await invoke<{ id: string }>('create_session', {
              shell: null,
              cwd: rootPathRef.current || null,
            });
            const id = crypto.randomUUID();
            restored.push({
              id,
              x: w.x ?? 160,
              y: w.y ?? 160,
              z: w.z ?? zRef.current,
              title: 'Terminal',
              name: w.name || 'Terminal',
              sessionId: session.id,
              width: w.width ?? 520,
              height: w.height ?? 320,
              type: 'terminal',
              terminalKind: w.terminalKind,
              resumeSessionId: w.resumeSessionId,
            });

            if (w.terminalKind) {
              startCliInTerminal(session.id, w.terminalKind, w.resumeSessionId);
            }
          } else if (w.type === 'file' && w.path) {
            restored.push(spawnFileWindowFromState(w.path, w));
          }
        }
        if (!cancelled) {
          setTransform(state.transform || { x: 80, y: 80, scale: 1 });
          setWindows(restored);
          setActiveId(state.activeId || (restored[0]?.id ?? null));
          const assigned = new Set(
            restored
              .filter((w) => w.type === 'terminal' && w.terminalKind === 'codex' && w.resumeSessionId)
              .map((w) => w.resumeSessionId as string)
          );
          codexAssignedRef.current = assigned;
        }
      } catch (err) {
        console.warn('load state failed', err);
      } finally {
        restoringRef.current = false;
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const candidates = windowsRef.current.filter(
        (w) => w.type === 'terminal' && (!w.terminalKind || !w.resumeSessionId)
      ) as (WindowItem & { type: 'terminal'; sessionId: string })[];
      if (candidates.length === 0) return;
      for (const win of candidates) {
        if (pendingResumeRef.current.has(win.id)) {
          continue;
        }
        const output = getTerminalOutput(win.sessionId, 120).text;
        const codexReady =
          /OpenAI Codex|gpt-.*codex|Tip:|model:/i.test(output) || output.includes('Use /fork');
        if (codexReady) {
          updateWindow(win.id, { terminalKind: 'codex' });
        } else if (/claude code|claude/i.test(output)) {
          updateWindow(win.id, { terminalKind: 'claude' });
        } else if (/gemini/i.test(output)) {
          updateWindow(win.id, { terminalKind: 'gemini' });
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (pendingResumeRef.current.size === 0) return;
      for (const [winId, pending] of Array.from(pendingResumeRef.current.entries())) {
        if (pending.kind === 'codex') {
          const win = windowsRef.current.find((w) => w.id === winId) as
            | (WindowItem & { type: 'terminal'; sessionId: string })
            | undefined;
          if (win?.sessionId) {
            const output = getTerminalOutput(win.sessionId, 200).text;
            const match =
              output.match(/Session\\s*ID\\s*[:=]\\s*([a-f0-9-]{8,})/i) ||
              output.match(/session_id\\s*[:=]\\s*([a-f0-9-]{8,})/i);
            if (match) {
              updateWindow(winId, { resumeSessionId: match[1] });
              pendingResumeRef.current.delete(winId);
              codexStatusRequestedRef.current.delete(winId);
              continue;
            }
            const codexReady =
              /OpenAI Codex|gpt-.*codex|Tip:|model:/i.test(output) || output.includes('Use /fork');
            if (!codexStatusRequestedRef.current.has(winId) && codexReady) {
              codexStatusRequestedRef.current.add(winId);
              invoke('write_session', { id: win.sessionId, data: '/status\r' }).catch(() => {});
            }
          }
          const sessions = await invoke<Array<{ session_id: string; created_at: number; cwd: string }>>(
            'get_codex_threads_after',
            { cwd: rootPathRef.current || '', minTsMs: pending.startedAt, limit: 50 }
          ).catch(() => []);
          const candidate = sessions.find((s) => !codexAssignedRef.current.has(s.session_id));
          if (candidate) {
            codexAssignedRef.current.add(candidate.session_id);
            updateWindow(winId, { resumeSessionId: candidate.session_id });
            pendingResumeRef.current.delete(winId);
            codexStatusRequestedRef.current.delete(winId);
          }
        } else if (pending.kind === 'claude') {
          const win = windowsRef.current.find((w) => w.id === winId) as
            | (WindowItem & { type: 'terminal'; sessionId: string })
            | undefined;
          if (win?.sessionId) {
            const output = getTerminalOutput(win.sessionId, 200).text;
            const match =
              output.match(/Session\\s*ID\\s*[:=]\\s*([a-f0-9-]{8,})/i) ||
              output.match(/session_id\\s*[:=]\\s*([a-f0-9-]{8,})/i);
            if (match) {
              updateWindow(winId, { resumeSessionId: match[1] });
              pendingResumeRef.current.delete(winId);
              claudeStatusRequestedRef.current.delete(winId);
              continue;
            }
            const claudeReady = /Claude Code|claude/i.test(output);
            if (!claudeStatusRequestedRef.current.has(winId) && claudeReady) {
              claudeStatusRequestedRef.current.add(winId);
              invoke('write_session', { id: win.sessionId, data: '/status\r' }).catch(() => {});
            }
          }
          const latest = await invoke<string | null>('get_claude_latest_session_after', {
            projectPath: rootPathRef.current || '',
            minTsMs: pending.startedAt,
          }).catch(() => null);
          if (latest) {
            updateWindow(winId, { resumeSessionId: latest });
            pendingResumeRef.current.delete(winId);
            claudeStatusRequestedRef.current.delete(winId);
          }
        } else if (pending.kind === 'gemini') {
          const latest = await invoke<string | null>('get_gemini_latest_session_after', {
            projectPath: rootPathRef.current || '',
            minTsMs: pending.startedAt,
          }).catch(() => null);
          if (latest) {
            updateWindow(winId, { resumeSessionId: latest });
            pendingResumeRef.current.delete(winId);
          }
        }
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const toggleVoice = async () => {
    if (!voiceEnabledRef.current) {
      setVoiceError('Voice is disabled');
      return;
    }
    if (!voiceRef.current) {
      voiceRef.current = createVoiceController({
        getWindows: () => windowsRef.current,
        getActiveId: () => activeIdRef.current,
        spawnTerminal: (x, y, name) => spawnTerminal(x, y, name),
        focusTerminal: handleFocus,
        renameTerminal: handleRename,
        closeTerminal: handleClose,
        isSpeakerEnabled: () => speakerRef.current,
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

  const hardStopVoice = async () => {
    try {
      await voiceRef.current?.stop();
    } catch {
      // ignore
    } finally {
      voiceRef.current = null;
      setVoiceActive(false);
    }
  };

  useEffect(() => {
    toggleVoiceRef.current = () => {
      if (!voiceEnabledRef.current) return;
      toggleVoice().catch((err) => {
        console.error('toggleVoice failed', err);
      });
    };
  }, [toggleVoice]);

  useEffect(() => {
    if (voiceEnabled) return;
    hardStopVoice();
  }, [voiceEnabled, voiceActive]);

  const normalizeShortcut = (value: string) => value.toLowerCase().replace(/\s+/g, '');
  const getFnMode = (value: string) => {
    const normalized = normalizeShortcut(value);
    if (normalized === 'fn') return 'fn';
    if (normalized === 'fn+space' || normalized === 'fnspace') return 'fn_space';
    return null;
  };

  useEffect(() => {
    let cancelled = false;
    const setupShortcut = async () => {
      if (!shortcut) return;
      if (!voiceEnabled) {
        if (lastGlobalShortcutRef.current) {
          await unregister(lastGlobalShortcutRef.current).catch(() => {});
          lastGlobalShortcutRef.current = null;
        }
        await invoke('set_fn_hotkey_mode', { mode: 'off' });
        setShortcutHint('Voice disabled');
        return;
      }
      try {
        setShortcutError(null);
        setShortcutHint(null);
        const fnMode = getFnMode(shortcut);
        if (fnMode) {
          if (lastGlobalShortcutRef.current) {
            await unregister(lastGlobalShortcutRef.current).catch(() => {});
            lastGlobalShortcutRef.current = null;
          }
          if (!cancelled) {
            setShortcutHint('Fn hotkey active (requires Accessibility permission).');
          }
          await invoke('set_fn_hotkey_mode', { mode: fnMode });
          return;
        }
        await invoke('set_fn_hotkey_mode', { mode: 'off' });
        if (await isRegistered(shortcut)) {
          await unregister(shortcut);
        }
        await register(shortcut, () => toggleVoiceRef.current());
        lastGlobalShortcutRef.current = shortcut;
        setShortcutHint('Global shortcut active');
      } catch (err: any) {
        if (!cancelled) {
          setShortcutError(err?.message || 'Failed to register shortcut. Try F19 or CommandOrControl+Alt+Shift+K.');
        }
      }
    };
    setupShortcut();

    return () => {
      cancelled = true;
      if (shortcut) unregister(shortcut).catch(() => {});
    };
  }, [shortcut, voiceEnabled]);

  const promptShortcut = () => {
    const next = window.prompt('Set shortcut (e.g. Fn, Fn+Space, CommandOrControl+Shift+K)', shortcut);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    window.localStorage.setItem('voiceShortcut', trimmed);
    setShortcut(trimmed);
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenErr: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen('fn-hotkey', () => {
        if (!voiceEnabledRef.current) return;
        toggleVoiceRef.current();
      });
      unlistenErr = await listen('fn-hotkey-error', (event) => {
        const msg = typeof event.payload === 'string' ? event.payload : 'Fn hotkey error';
        setShortcutError(msg);
      });
    };
    setup();
    return () => {
      unlisten?.();
      unlistenErr?.();
    };
  }, []);

  const canvasStyle = useMemo(() => {
    return {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    } as React.CSSProperties;
  }, [transform]);

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <FileTree
        onRootChange={setRootPath}
        onOpenPath={openFileWindow}
        sessions={windows
          .filter((win) => win.type === 'terminal')
          .map((win) => ({ id: win.id, name: win.name, active: activeId === win.id }))}
        onSelectSession={handleFocus}
        onRenameSession={handleRename}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />

      <div className="topbar" data-tauri-drag-region>
        <div className="topbar-left">
          <div className="topbar-spacer" />
        </div>
        <div className="topbar-center">
          <button className="btn primary" onClick={handleNewTerminal} data-tauri-drag-region="false">
            + Terminal
          </button>
        </div>
        <div className="topbar-right">
          <div
            className={`fn-indicator has-tooltip ${shortcut.toLowerCase().includes('fn') ? 'active' : ''}`}
            data-tooltip="Active shortcut"
          >
            {shortcut}
            <span className="fn-check">✓</span>
          </div>
          <button
            className={`icon-btn kill-btn has-tooltip ${voiceEnabled ? '' : 'active'}`}
            onClick={() => {
              setVoiceEnabled((prev) => {
                const next = !prev;
                if (!next) {
                  setShortcutHint('Voice disabled');
                  setShortcutError(null);
                } else {
                  setShortcutHint(null);
                }
                return next;
              });
            }}
            data-tooltip={voiceEnabled ? 'Disable voice + hotkeys' : 'Enable voice + hotkeys'}
            data-tauri-drag-region="false"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 7l12 10" stroke="currentColor" strokeWidth="1.8" />
              <path d="M8 5h8l2 2v10l-2 2H8l-2-2V7z" stroke="currentColor" strokeWidth="1.4" fill="none" />
            </svg>
          </button>
          <button
            className={`icon-btn speaker-btn has-tooltip ${speakerEnabled ? 'active' : ''}`}
            onClick={() => setSpeakerEnabled((prev) => !prev)}
            data-tooltip={speakerEnabled ? 'Mute speaker' : 'Unmute speaker'}
            data-tauri-drag-region="false"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 10h4l5-4v12l-5-4H4z" fill="currentColor" />
              <path d="M16 9a3 3 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
          </button>
          <button
            className={`icon-btn mic-btn has-tooltip ${voiceActive ? 'active' : ''}`}
            onClick={toggleVoice}
            data-tooltip={voiceActive ? 'Stop voice control' : 'Start voice control'}
            data-tauri-drag-region="false"
            disabled={!voiceEnabled}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3z"
                fill="currentColor"
              />
              <path
                d="M6 11a6 6 0 0 0 12 0h-2a4 4 0 1 1-8 0H6zM11 17h2v3h-2z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            className="icon-btn has-tooltip"
            onClick={promptShortcut}
            data-tooltip="Set shortcut"
            data-tauri-drag-region="false"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 5a2 2 0 0 0-2 2v2H8a2 2 0 0 0-2 2v2h2v-2h2v2a2 2 0 0 0 2 2h2v2a2 2 0 0 0 2 2h2v-2h-2v-2h2a2 2 0 0 0 2-2V9h-2v2h-2V9a2 2 0 0 0-2-2h-2V5h-2z"
                fill="currentColor"
              />
            </svg>
          </button>
          {voiceError && <div className="voice-error">{voiceError}</div>}
          {shortcutError && <div className="voice-error">{shortcutError}</div>}
        </div>
      </div>

      <div className="zoom-float">
        <button
          className="zoom-btn"
          onClick={() => setTransform((prev) => ({ ...prev, scale: Math.max(MIN_SCALE, prev.scale - 0.1) }))}
          title="Zoom out"
        >
          –
        </button>
        <div className="zoom-readout">{Math.round(transform.scale * 100)}%</div>
        <button
          className="zoom-btn"
          onClick={() => setTransform((prev) => ({ ...prev, scale: Math.min(MAX_SCALE, prev.scale + 0.1) }))}
          title="Zoom in"
        >
          +
        </button>
      </div>

      {!sidebarOpen && (
        <button
          className="sidebar-handle"
          onClick={() => setSidebarOpen(true)}
          title="Show sidebar"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      )}

      <div
        className="canvas"
        ref={canvasRef}
        onPointerDown={beginPan}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      >
        <div className="canvas-grid" style={canvasStyle}>
          {windows.map((win) => {
            if (win.type === 'terminal') {
              return (
                <TerminalWindow
                  key={win.id}
                  win={win as WindowItem & { type: 'terminal'; sessionId: string }}
                  scale={transform.scale}
                  active={activeId === win.id}
                  onMove={(id, x, y) => updateWindow(id, { x, y })}
                  onResize={(id, width, height) => updateWindow(id, { width, height })}
                  onFocus={handleFocus}
                  onClose={handleClose}
                  onRename={handleRename}
                  onCommand={handleCommand}
                />
              );
            }

            return (
              <FileWindow
                key={win.id}
                win={win as WindowItem & { type: 'file'; path: string }}
                scale={transform.scale}
                active={activeId === win.id}
                onMove={(id, x, y) => updateWindow(id, { x, y })}
                onResize={(id, width, height) => updateWindow(id, { width, height })}
                onFocus={handleFocus}
                onClose={handleClose}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
