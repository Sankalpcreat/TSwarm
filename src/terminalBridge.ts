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

const MAX_BUFFER = 200_000; // chars

function scheduleFlush(id: string) {
  const record = terminals.get(id);
  if (!record || record.raf !== null || record.paused) return;

  record.raf = requestAnimationFrame(() => {
    record.raf = null;
    if (!record.buffer || record.paused) return;
    const data = record.buffer;
    record.buffer = '';
    (window as any).__addLog?.(`xterm write len=${data.length}`);
    record.term.write(data);
  });
}

export async function initTerminalEvents() {
  if (listening) return;
  listening = true;
  await listen<TerminalDataEvent>('terminal:data', (event) => {
    const { id, data } = event.payload;
    (window as any).__addLog?.(`IPC_RECV ${id.slice(0,5)} len=${data.length}`);
    const record = terminals.get(id);
    if (!record) {
      console.log(`[IPC] Received data for non-existent terminal ${id}`);
      const existing = pending.get(id) ?? '';
      const next = (existing + data).slice(-MAX_BUFFER);
      pending.set(id, next);
      return;
    }

    record.buffer += data;
    console.log(`[IPC] Terminal ${id} buffered ${data.length} bytes (total ${record.buffer.length})`);
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
