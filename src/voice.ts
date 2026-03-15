import { GoogleGenAI, Modality } from '@google/genai';
import { invoke } from '@tauri-apps/api/core';
import type { WindowItem } from './types';
import { getTerminalOutput } from './terminalBridge';

export type VoiceControllerOptions = {
  getWindows: () => WindowItem[];
  getActiveId: () => string | null;
  spawnTerminal: (x: number, y: number, name?: string) => Promise<void>;
  focusTerminal: (id: string) => void;
  renameTerminal: (id: string, name: string) => void;
  closeTerminal: (id: string) => void;
  isSpeakerEnabled?: () => boolean;
  log: (msg: string) => void;
};

type LiveSession = any;
type TerminalWindowItem = WindowItem & { type: 'terminal'; sessionId: string };

const TARGET_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

function downsampleBuffer(buffer: Float32Array, sampleRate: number, targetRate: number) {
  if (targetRate === sampleRate) return buffer;
  const ratio = sampleRate / targetRate;
  const length = Math.round(buffer.length / ratio);
  const result = new Float32Array(length);
  let offset = 0;
  for (let i = 0; i < length; i += 1) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = offset; j < next && j < buffer.length; j += 1) {
      sum += buffer[j];
      count += 1;
    }
    result[i] = sum / Math.max(1, count);
    offset = next;
  }
  return result;
}

function floatTo16BitPCM(float32: Float32Array) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64ToInt16(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function int16ToFloat32(int16: Int16Array) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) {
    float32[i] = int16[i] / 0x8000;
  }
  return float32;
}

function normalizeArgs(args: any) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

function findSessionBySelector(windows: TerminalWindowItem[], selector: { id?: string; name?: string; index?: number }) {
  if (selector.id) return windows.find((w) => w.id === selector.id) || null;
  if (selector.name) {
    const name = selector.name.toLowerCase();
    return windows.find((w) => w.name.toLowerCase() === name) || null;
  }
  if (selector.index && selector.index > 0 && selector.index <= windows.length) {
    return windows[selector.index - 1] || null;
  }
  return null;
}

export function createVoiceController(opts: VoiceControllerOptions) {
  let audioContext: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let mediaStream: MediaStream | null = null;
  let session: LiveSession | null = null;
  let isRunning = false;
  let playbackContext: AudioContext | null = null;
  let playbackTime = 0;

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'list_sessions',
          description: 'List active terminal sessions with id, name, index, and focus state.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'spawn_terminal',
          description: 'Spawn a new terminal session at a default position. Optionally provide a name.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Optional name for the session.' },
            },
          },
        },
        {
          name: 'focus_session',
          description: 'Focus a terminal session by id, name, or index.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
            },
          },
        },
        {
          name: 'rename_session',
          description: 'Rename a terminal session by id, name, or index.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
              new_name: { type: 'string' },
            },
            required: ['new_name'],
          },
        },
        {
          name: 'close_session',
          description: 'Close a terminal session by id, name, or index.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
            },
          },
        },
        {
          name: 'send_text',
          description: 'Type text into a terminal WITHOUT pressing Enter. Use only if the user explicitly says "type without enter" or "do not press enter".',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
        {
          name: 'run_command',
          description: 'Run a command or send a prompt in a terminal (always sends Enter). This is the default for user requests.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
        {
          name: 'press_enter',
          description: 'Press Enter in a terminal without typing any text. Use when the user says "press enter", "submit", or "send it".',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
            },
          },
        },
        {
          name: 'get_terminal_output',
          description: 'Read recent output from a terminal. Use to answer questions like "what is in terminal 2" or "read the last output".',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              index: { type: 'number' },
              lines: { type: 'number', description: 'How many lines to return (default 20).' },
            },
          },
        },
      ],
    },
  ] as any;

  const isTerminalWindow = (w: WindowItem): w is TerminalWindowItem =>
    w.type === 'terminal' && typeof w.sessionId === 'string';
  const getTerminals = () => opts.getWindows().filter(isTerminalWindow);

  async function handleToolCall(toolCall: any) {
    const responses = [] as any[];
    const windows = getTerminals();

    for (const call of toolCall.functionCalls || []) {
      const args = normalizeArgs(call.args ?? call.arguments ?? call.parameters);
      let result: any = { ok: true };

      switch (call.name) {
        case 'list_sessions': {
          result = {
            sessions: windows.map((w, i) => ({
              id: w.id,
              name: w.name,
              index: i + 1,
              active: w.id === opts.getActiveId(),
            })),
          };
          break;
        }
        case 'spawn_terminal': {
          await opts.spawnTerminal(180, 180, args.name);
          result = { spawned: true };
          break;
        }
        case 'focus_session': {
          const match = findSessionBySelector(windows, args);
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.focusTerminal(match.id);
            result = { focused: match.id };
          }
          break;
        }
        case 'rename_session': {
          const match = findSessionBySelector(windows, args);
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.renameTerminal(match.id, args.new_name);
            result = { renamed: match.id, name: args.new_name };
          }
          break;
        }
        case 'close_session': {
          const match = findSessionBySelector(windows, args);
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.closeTerminal(match.id);
            result = { closed: match.id };
          }
          break;
        }
        case 'send_text': {
          const match = findSessionBySelector(windows, args) || windows.find((w) => w.id === opts.getActiveId());
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.log(`voice send_text -> ${match.name}`);
            await invoke('write_session', { id: match.sessionId, data: args.text });
            result = { sent: true };
          }
          break;
        }
        case 'run_command': {
          const match = findSessionBySelector(windows, args) || windows.find((w) => w.id === opts.getActiveId());
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.log(`voice run_command -> ${match.name}`);
            await invoke('write_session', { id: match.sessionId, data: `${args.command}\r` });
            result = { ran: true };
          }
          break;
        }
        case 'press_enter': {
          const match = findSessionBySelector(windows, args) || windows.find((w) => w.id === opts.getActiveId());
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            opts.log(`voice press_enter -> ${match.name}`);
            await invoke('write_session', { id: match.sessionId, data: '\r' });
            result = { pressed: true };
          }
          break;
        }
        case 'get_terminal_output': {
          const match = findSessionBySelector(windows, args) || windows.find((w) => w.id === opts.getActiveId());
          if (!match) {
            result = { ok: false, error: 'Session not found' };
          } else {
            const count = typeof args.lines === 'number' ? args.lines : 20;
            const output = getTerminalOutput(match.sessionId, count);
            result = { ok: true, lines: output.lines, text: output.text };
          }
          break;
        }
        default:
          result = { ok: false, error: 'Unknown tool' };
      }

      responses.push({ id: call.id, name: call.name, response: result });
    }

    if (responses.length > 0) {
      await session?.sendToolResponse({ functionResponses: responses });
    }
  }

  function ensurePlaybackContext() {
    if (!playbackContext) {
      playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      playbackTime = playbackContext.currentTime;
    }
  }

  function resetPlayback() {
    if (!playbackContext) return;
    playbackTime = playbackContext.currentTime;
  }

  function playPcmBase64(data: string) {
    if (!data) return;
    if (opts.isSpeakerEnabled && !opts.isSpeakerEnabled()) return;
    ensurePlaybackContext();
    if (!playbackContext) return;
    const int16 = decodeBase64ToInt16(data);
    const float32 = int16ToFloat32(int16);
    const buffer = playbackContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const sourceNode = playbackContext.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(playbackContext.destination);
    const startAt = Math.max(playbackTime, playbackContext.currentTime);
    sourceNode.start(startAt);
    playbackTime = startAt + buffer.duration;
  }

  async function start() {
    if (isRunning) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing VITE_GEMINI_API_KEY');
    }

    const model = import.meta.env.VITE_GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';

    const ai = new GoogleGenAI({ apiKey });

    session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        tools,
        systemInstruction: 'You are a voice controller for a terminal canvas. Use function calls to execute user requests. Always call list_sessions before referencing a session by index or name if uncertain. Default to run_command for user prompts/commands and only use send_text if the user explicitly says to type without pressing Enter. If the user says "press enter", "submit", or "send it", call press_enter and do NOT type those words. Use get_terminal_output when asked to read terminal contents or status.',
      },
      callbacks: {
        onopen: () => opts.log('Gemini Live connected'),
        onmessage: async (message: any) => {
          if (message.toolCall) {
            await handleToolCall(message.toolCall);
          }
          if (message.serverContent?.interrupted) {
            resetPlayback();
          }
          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            const inline = part.inlineData || part.inline_data;
            if (inline?.data) {
              playPcmBase64(inline.data);
            }
          }
          const transcript = message.serverContent?.outputTranscription?.text;
          if (transcript) {
            opts.log(`Gemini transcript: ${transcript}`);
          }
        },
        onerror: (e: any) => opts.log(`Gemini Live error: ${e.message || e}`),
        onclose: (e: any) => opts.log(`Gemini Live closed: ${e.reason || 'closed'}`),
      },
    });

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioContext?.sampleRate || 48000, TARGET_SAMPLE_RATE);
      const int16 = floatTo16BitPCM(downsampled);
      const data = toBase64(int16.buffer);
      session?.sendRealtimeInput({
        audio: {
          data,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    isRunning = true;
  }

  async function stop() {
    if (!isRunning) return;
    processor?.disconnect();
    source?.disconnect();
    processor = null;
    source = null;

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }

    if (playbackContext) {
      await playbackContext.close();
      playbackContext = null;
    }

    if (session) {
      session.close();
      session = null;
    }

    isRunning = false;
  }

  return { start, stop };
}
