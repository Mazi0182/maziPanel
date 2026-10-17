import { LogType, LogEvent, LogEntry } from '../types';

export interface ParsedLogEntry extends LogEntry {
  type?: LogType;
}

/**
 * Strips ANSI color and control codes
 */
export function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Strips JLine / Nogui prompt redraw artifacts like `> \r \r` or `> > \r \r`
 */
export function cleanJLineArtifacts(str: string): string {
  // If the line has JLine terminal redraw sequences before a log header:
  return str.replace(/^(?:>\s*|\r\s*)+/g, '');
}

/**
 * Selects authoritative history entries from WebSocket or API payloads.
 * Prioritizes structured logs (including [] as authoritative), then history, then legacy lines.
 */
export function selectHistoryEntries(data: any): any[] {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.logs)) {
    return data.logs;
  }
  if (Array.isArray(data.history)) {
    return data.history;
  }
  if (Array.isArray(data.lines)) {
    return data.lines;
  }
  return [];
}

/**
 * Parses a single Minecraft or system log line into structured log data.
 * Adheres strictly to log headers:
 * - Purpur/Paper format: [HH:MM:SS LEVEL]: message
 * - Vanilla/Fabric format: [HH:MM:SS] [Thread/LEVEL]: message
 * Continuation lines (e.g. Java stack traces) inherit `prevLevel`.
 */
export function parseLogLine(
  rawInput: any,
  index = 0,
  prevLevel: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO'
): ParsedLogEntry | null {
  let raw = '';
  let fallbackTime = '';
  let inputType: LogType | undefined = undefined;
  let inputEvent: LogEvent | undefined = undefined;

  if (typeof rawInput === 'string') {
    raw = rawInput;
  } else if (rawInput && typeof rawInput === 'object') {
    raw = rawInput.text || rawInput.message || rawInput.line || rawInput.raw || '';
    inputType = rawInput.type;
    inputEvent = rawInput.event;
    if (rawInput.timestamp) {
      try {
        const d = new Date(rawInput.timestamp);
        if (!isNaN(d.getTime())) {
          fallbackTime = d.toTimeString().slice(0, 8);
        }
      } catch {}
    }
  }

  // Skip completely empty or whitespace-only lines
  const trimmedRaw = raw.replace(/\r/g, '').trim();
  if (!trimmedRaw) {
    return null;
  }

  // GİZLEME KURALI: Eski formatta `[maziPanel] Spawning process:` veya `Using Java runtime:` satırlarını GİZLE
  if (
    trimmedRaw.includes('[maziPanel] Spawning process:') ||
    trimmedRaw.includes('Using Java runtime:') ||
    trimmedRaw.includes('Spawning process:')
  ) {
    return null;
  }

  // Clean ANSI for pattern detection
  const clean = stripAnsi(raw).replace(/\r/g, '');

  // 1. Check if this is a command echo emitted from user/system (e.g. `> say test`)
  const isDirectCommandEcho =
    (inputType as string) === 'command' ||
    inputEvent === 'command' ||
    (clean.startsWith('>') && !/\[\d{2}:\d{2}:\d{2}/.test(clean));

  if (isDirectCommandEcho) {
    const echoMsg = clean.replace(/^>\s*/, '').trimStart();
    if (!echoMsg || echoMsg === '$' || echoMsg === '>') {
      return null;
    }
    const timestamp = fallbackTime || new Date().toTimeString().slice(0, 8);
    return {
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp,
      level: 'INFO',
      message: `> ${echoMsg}`,
      raw: String(raw),
      type: 'command' as any as LogType,
      event: 'command',
      isCommandEcho: true,
    };
  }

  // Filter out lone prompt symbols printed on server shutdown or stdout flush
  if (clean.trim() === '$' || clean.trim() === '>') {
    return null;
  }

  // Sistem satırı tespiti:
  const isSystemLine = inputType === 'system' || clean.startsWith('[maziPanel]');

  // Remove JLine prompt redraw sequences (e.g. `> > \r \r[21:24:52 INFO]: ...`)
  const sanitized = cleanJLineArtifacts(clean);

  let timestamp = fallbackTime;
  let level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = prevLevel;
  let message = sanitized;

  // Pattern 1: Paper / Purpur format: `[HH:MM:SS LEVEL]: message`
  const paperMatch = sanitized.match(/^\[(\d{2}:\d{2}:\d{2})\s+([A-Za-z]+)\]:\s*([\s\S]*)$/);
  if (paperMatch) {
    timestamp = paperMatch[1];
    const rawLvl = paperMatch[2].toUpperCase();
    if (rawLvl === 'ERROR' || rawLvl === 'FATAL' || rawLvl === 'SEVERE') level = 'ERROR';
    else if (rawLvl === 'WARN' || rawLvl === 'WARNING') level = 'WARN';
    else if (rawLvl === 'DEBUG') level = 'DEBUG';
    else level = 'INFO';
    message = paperMatch[3] ?? '';
  } else {
    // Pattern 2: Vanilla format: `[HH:MM:SS] [Thread/LEVEL]: message` or `[HH:MM:SS] [LEVEL]: message`
    const vanillaMatch = sanitized.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[(?:[^\]]+\/)?([A-Za-z]+)\]:\s*([\s\S]*)$/);
    if (vanillaMatch) {
      timestamp = vanillaMatch[1];
      const rawLvl = vanillaMatch[2].toUpperCase();
      if (rawLvl === 'ERROR' || rawLvl === 'FATAL' || rawLvl === 'SEVERE') level = 'ERROR';
      else if (rawLvl === 'WARN' || rawLvl === 'WARNING') level = 'WARN';
      else if (rawLvl === 'DEBUG') level = 'DEBUG';
      else level = 'INFO';
      message = vanillaMatch[3] ?? '';
    } else {
      // Continuation lines without header (e.g., `at net.minecraft...`, `Caused by: ...`, etc.)
      level = prevLevel;
      const timeMatch = sanitized.match(/\[(\d{2}:\d{2}:\d{2})/);
      if (timeMatch) {
        timestamp = timeMatch[1];
      }
    }
  }

  // Handle Minecraft 1.19+ unsigned chat prefix: `[Not Secure] `
  if (/^\[Not Secure\]\s*/i.test(message)) {
    message = message.replace(/^\[Not Secure\]\s*/i, '');
  }

  // Remove any remaining accidental leading whitespace from message
  message = message.trimStart();

  if (!timestamp) {
    timestamp = new Date().toTimeString().slice(0, 8);
  }

  // Done tespiti: Done (x.xxxs)!
  let detectedEvent: LogEvent | undefined = inputEvent;
  if (!detectedEvent && /Done \(\d+(?:\.\d+)?s\)!/i.test(message)) {
    detectedEvent = 'done';
  }

  const finalType: LogType = isSystemLine ? 'system' : (inputType || (level === 'ERROR' ? 'stderr' : 'stdout'));

  const rawStr = String(raw);
  let hashVal = 0;
  for (let i = 0; i < rawStr.length; i++) {
    hashVal = (hashVal << 5) - hashVal + rawStr.charCodeAt(i);
    hashVal |= 0;
  }
  const hashKey = (hashVal >>> 0).toString(36);

  const stableId = (rawInput && typeof rawInput === 'object' && typeof rawInput.id === 'string' && rawInput.id)
    ? rawInput.id
    : `log-${index}-${hashKey}`;

  return {
    id: stableId,
    timestamp,
    level,
    message,
    raw: rawStr,
    type: finalType,
    event: detectedEvent,
    isCommandEcho: false,
  };
}

/**
 * Checks whether a message is a disconnect/kick/ban line that may be followed
 * by unprefixed continuation lines like `Reason: ...` or `Expires: ...`.
 */
function isDisconnectHeaderMessage(msg: string): boolean {
  return (
    /^(?:Disconnecting\s+\S+|\S+(?:\s*\([^)]+\))?\s+lost connection:)/i.test(msg) ||
    /You are banned from this server/i.test(msg) ||
    /You are not white-listed on this server/i.test(msg) ||
    /multiplayer\.disconnect/i.test(msg)
  );
}

/**
 * Checks whether an unprefixed line is a continuation of a disconnect/ban message
 * (e.g. `Reason: ...`, `Expires: ...`, `Banned by: ...`).
 */
function isDisconnectContinuation(rawStr: string, msg: string): boolean {
  const cleanRaw = cleanJLineArtifacts(stripAnsi(rawStr).replace(/\r/g, '')).trim();
  // Must NOT have a standard [HH:MM:SS ...] log timestamp header
  if (/^\[\d{2}:\d{2}:\d{2}/.test(cleanRaw)) {
    return false;
  }
  return /^(?:Reason|Sebep|Expires|Banned by|Banland[ıi]):\s*/i.test(msg);
}

/**
 * Appends a parsed log entry into an existing log list while:
 * 1. Merging unprefixed `Reason: ...` / `Expires: ...` continuation lines into the preceding disconnect/ban entry.
 * 2. Suppressing redundant `<player> lost connection: You are banned...` lines that immediately duplicate `Disconnecting <player>: You are banned...`.
 * 3. Deduplicating consecutive identical entries.
 */
export function appendParsedLogEntry(
  list: ParsedLogEntry[],
  entry: ParsedLogEntry,
  maxItems?: number
): ParsedLogEntry[] {
  if (list.length === 0) {
    return [entry];
  }

  const last = list[list.length - 1];

  // 1. If this is an unprefixed `Reason: ...` or `Expires: ...` line right after a disconnect/ban line:
  if (isDisconnectContinuation(entry.raw, entry.message)) {
    if (isDisconnectHeaderMessage(last.message)) {
      // Avoid appending the exact same continuation twice (e.g. when `lost connection: You are banned` was suppressed)
      if (last.message.includes(entry.message)) {
        return list;
      }
      const mergedEntry: ParsedLogEntry = {
        ...last,
        message: `${last.message} — ${entry.message}`,
        raw: `${last.raw} | ${entry.message}`,
      };
      return [...list.slice(0, -1), mergedEntry];
    }
  }

  // 1b. If the backend emitted an updated disconnect line with ` — Reason: ...` already appended, update `last` in-place
  if (
    isDisconnectHeaderMessage(last.message) &&
    entry.message.startsWith(last.message) &&
    entry.message.length > last.message.length &&
    entry.message.slice(last.message.length).startsWith(' — ')
  ) {
    const updatedLast: ParsedLogEntry = {
      ...last,
      message: entry.message,
      raw: entry.raw,
    };
    return [...list.slice(0, -1), updatedLast];
  }

  // 2. Suppress redundant `<player> lost connection: You are banned from this server.` immediately after `Disconnecting <player>: You are banned...`
  const lostBannedMatch = entry.message.match(/^([^\s(]+)(?:\s*\([^)]+\))?\s+lost connection:\s*You are banned from this server/i);
  if (lostBannedMatch) {
    const player = lostBannedMatch[1].toLowerCase();
    const lastLower = last.message.toLowerCase();
    if (
      lastLower.startsWith(`disconnecting ${player}`) &&
      lastLower.includes('you are banned from this server')
    ) {
      return list;
    }
  }

  // 3. Consecutive exact raw deduplication
  if (last.raw === entry.raw) {
    return list;
  }

  const next = maxItems && maxItems > 0
    ? [...list.slice(-(maxItems - 1)), entry]
    : [...list, entry];
  return next;
}

/**
 * Parses full multiline raw log content (e.g. latest.log)
 */
export function parseLogContent(content: string): ParsedLogEntry[] {
  if (!content) return [];
  const lines = content.split('\n');
  let result: ParsedLogEntry[] = [];
  let currentLevel: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO';

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLogLine(lines[i], i, currentLevel);
    if (parsed) {
      currentLevel = parsed.level;
      result = appendParsedLogEntry(result, parsed);
    }
  }

  return result;
}

