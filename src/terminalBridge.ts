import { listen } from '@tauri-apps/api/event';
import type { Terminal } from '@xterm/xterm';

export type TerminalDataEvent = {
  id: string;
  data: string;
};

type TerminalRecord = {
  term: Terminal;
  buffer: string;
  raf: number | null;
  paused: boolean;
};

const terminals = new Map<string, TerminalRecord>();
const pending = new Map<string, string>();
let listening = false;
const DEBUG_IPC = import.meta.env.DEV;

const MAX_BUFFER = 200_000; // chars
const MAX_OUTPUT_LINES = 2000;

type OutputBuffer = {
  lines: string[];
  tail: string;
};

const outputBuffers = new Map<string, OutputBuffer>();

function stripAnsi(text: string) {
  return text
    // CSI sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC sequences
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    // Other escape sequences
    .replace(/\x1b[@-Z\\-_]/g, '');
}

function sanitizeText(text: string) {
  const cleaned = stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return cleaned.replace(/[^\x09\x0A\x20-\x7E]/g, '');
}

function appendOutput(id: string, data: string) {
  const cleaned = sanitizeText(data);
  if (!cleaned) return;
  const buffer = outputBuffers.get(id) || { lines: [], tail: '' };
  const combined = buffer.tail + cleaned;
  const parts = combined.split('\n');
  buffer.tail = parts.pop() ?? '';
  for (const line of parts) {
    buffer.lines.push(line);
  }
  if (buffer.lines.length > MAX_OUTPUT_LINES) {
    buffer.lines = buffer.lines.slice(-MAX_OUTPUT_LINES);
  }
  outputBuffers.set(id, buffer);
}

function scheduleFlush(id: string) {
  const record = terminals.get(id);
  if (!record || record.raf !== null || record.paused) return;

  record.raf = requestAnimationFrame(() => {
    record.raf = null;
    if (!record.buffer || record.paused) return;
    const data = record.buffer;
    record.buffer = '';
    if (DEBUG_IPC) {
      (window as any).__addLog?.(`xterm write len=${data.length}`);
    }
    record.term.write(data);
  });
}

export async function initTerminalEvents() {
  if (listening) return;
  listening = true;
  await listen<TerminalDataEvent>('terminal:data', (event) => {
    const { id, data } = event.payload;
    if (DEBUG_IPC) {
      (window as any).__addLog?.(`IPC_RECV ${id.slice(0,5)} len=${data.length}`);
    }
    appendOutput(id, data);
    const record = terminals.get(id);
    if (!record) {
      console.log(`[IPC] Received data for non-existent terminal ${id}`);
      const existing = pending.get(id) ?? '';
      const next = (existing + data).slice(-MAX_BUFFER);
      pending.set(id, next);
      return;
    }

    record.buffer += data;
    if (DEBUG_IPC) {
      console.log(`[IPC] Terminal ${id} buffered ${data.length} bytes (total ${record.buffer.length})`);
    }
    if (record.buffer.length > MAX_BUFFER) {
      record.buffer = record.buffer.slice(-MAX_BUFFER);
    }
    scheduleFlush(id);
  });
}

export function registerTerminal(id: string, term: Terminal) {
  terminals.set(id, { term, buffer: '', raf: null, paused: false });
  const buffered = pending.get(id);
  if (buffered) {
    pending.delete(id);
    const record = terminals.get(id);
    if (record) {
      record.buffer += buffered;
      scheduleFlush(id);
    }
  }
}

export function unregisterTerminal(id: string) {
  const record = terminals.get(id);
  if (record?.raf) cancelAnimationFrame(record.raf);
  terminals.delete(id);
}

export function setTerminalPaused(id: string, paused: boolean) {
  const record = terminals.get(id);
  if (!record) return;
  record.paused = paused;
  if (!paused) scheduleFlush(id);
}

export function getTerminalOutput(id: string, lines = 50) {
  const buffer = outputBuffers.get(id);
  if (!buffer) return { lines: [], text: '' };
  const slice = buffer.lines.slice(-Math.max(1, lines));
  return { lines: slice, text: slice.join('\n') };
}
