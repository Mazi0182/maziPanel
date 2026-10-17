/**
 * Startup arguments utility for maziPanel client.
 * Provides reversible conversion, quote-safe splitting, and syntax validation
 * between unified command arguments (single textarea) and server settings (jvmFlags, jarFile, serverArgs).
 */

export interface ParsedStartupArguments {
  jvmFlags: string;
  jarFile: string;
  serverArgs: string;
}

export interface ValidationResult {
  valid: boolean;
  error: string | null;
}

/**
 * Strips surrounding double or single quotes from a string if present.
 */
export function stripQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Quotes a string if it contains spaces and is not already wrapped in quotes.
 */
export function quoteIfSpaces(str: string): string {
  if (!str && str !== '') return '';
  const trimmed = str.trim();
  if (trimmed === '') return '""';
  if (
    trimmed.includes(' ') &&
    !((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return `"${trimmed}"`;
  }
  return trimmed;
}

/**
 * Validates the startup command line syntax.
 * Checks for unclosed single or double quotes.
 */
export function validateStartupCommandLine(rawCommandLine: string): ValidationResult {
  const text = (rawCommandLine || '').trim();
  if (!text) {
    return { valid: true, error: null };
  }

  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = i + 1 < text.length ? text[i + 1] : null;

    if (char === '\\') {
      if (nextChar === '"' || nextChar === "'" || nextChar === '\\') {
        i++;
        continue;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      if (inQuote === char) {
        inQuote = null;
      } else if (!inQuote) {
        inQuote = char;
      }
    }
  }

  if (inQuote !== null) {
    return {
      valid: false,
      error: 'Komut satırında kapatılmamış tırnak işareti bulunmaktadır.',
    };
  }

  return { valid: true, error: null };
}

/**
 * Tokenizes a command line string into separate arguments.
 * - Honors quoted arguments with spaces
 * - Preserves empty quoted arguments ("" -> "")
 * - Preserves literal Windows backslashes (e.g. C:\path\file) and trailing backslashes
 * - Escapes quotes only when preceded by backslash (\" or \')
 * - Throws SyntaxError if throwOnUnclosed is true and quotes are unclosed
 */
export function tokenizeArgs(argString: string, options: { throwOnUnclosed?: boolean } = {}): string[] {
  const { throwOnUnclosed = false } = options;
  if (!argString && argString !== '') return [];

  const text = String(argString);
  if (!text.trim() && !text.includes('""') && !text.includes("''")) {
    return [];
  }

  const tokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  let hadQuoteInToken = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = i + 1 < text.length ? text[i + 1] : null;

    // Handle escape: only quotes and backslashes are escaped;
    // literal backslashes in Windows paths (like \U, \s) are preserved!
    if (char === '\\') {
      if (nextChar === '"' || nextChar === "'" || nextChar === '\\') {
        current += nextChar;
        i++; // skip escaped char
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      if (inQuote === char) {
        inQuote = null;
        hadQuoteInToken = true;
      } else if (!inQuote) {
        inQuote = char;
        hadQuoteInToken = true;
      } else {
        current += char;
      }
      continue;
    }

    if (/\s/.test(char) && !inQuote) {
      if (current.length > 0 || hadQuoteInToken) {
        tokens.push(current);
        current = '';
        hadQuoteInToken = false;
      }
    } else {
      current += char;
    }
  }

  if (inQuote && throwOnUnclosed) {
    throw new SyntaxError('Komut satırında kapatılmamış tırnak işareti bulunmaktadır.');
  }

  if (current.length > 0 || hadQuoteInToken) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Fallback parser when '-jar' keyword is omitted in the raw command line.
 */
function parseWithoutJarKeyword(text: string, fallbackJar: string): ParsedStartupArguments {
  const tokens = tokenizeArgs(text);
  const jarTokenIdx = tokens.findIndex(
    (t) => t.toLowerCase() === fallbackJar.toLowerCase() || t.toLowerCase().endsWith('.jar')
  );

  if (jarTokenIdx !== -1) {
    const detectedJar = tokens[jarTokenIdx];
    const jvmFlags = tokens.slice(0, jarTokenIdx).map(quoteIfSpaces).join(' ');
    const serverArgs = tokens.slice(jarTokenIdx + 1).map(quoteIfSpaces).join(' ');
    return {
      jvmFlags,
      jarFile: detectedJar,
      serverArgs,
    };
  }

  return {
    jvmFlags: text,
    jarFile: fallbackJar,
    serverArgs: '',
  };
}

/**
 * Splits a unified command arguments string into jvmFlags, jarFile, and serverArgs.
 * Preserves quotes and flags verbatim around the '-jar <jar>' boundary.
 */
export function splitStartupCommandLine(
  rawCommandLine: string,
  fallbackJar: string = 'server.jar'
): ParsedStartupArguments {
  const text = (rawCommandLine || '').trim();
  if (!text) {
    return {
      jvmFlags: '',
      jarFile: fallbackJar,
      serverArgs: '',
    };
  }

  // Scan for '-jar' outside of quotes
  let inQuote: '"' | "'" | null = null;
  let jarIndex = -1;
  let jarKeywordLen = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = i + 1 < text.length ? text[i + 1] : null;

    if (char === '\\') {
      if (nextChar === '"' || nextChar === "'" || nextChar === '\\') {
        i++;
        continue;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      if (inQuote === char) {
        inQuote = null;
      } else if (!inQuote) {
        inQuote = char;
      }
      continue;
    }

    if (!inQuote) {
      if ((i === 0 || /\s/.test(text[i - 1])) && text.startsWith('-jar', i)) {
        const nextIdx = i + 4;
        if (nextIdx >= text.length || /\s/.test(text[nextIdx])) {
          jarIndex = i;
          jarKeywordLen = 4;
          break;
        }
      }
    }
  }

  if (jarIndex === -1) {
    return parseWithoutJarKeyword(text, fallbackJar);
  }

  // JVM flags: everything before '-jar'
  const jvmFlags = text.slice(0, jarIndex).trim();

  // Content following '-jar'
  const afterJar = text.slice(jarIndex + jarKeywordLen).trimStart();
  if (!afterJar) {
    return {
      jvmFlags,
      jarFile: fallbackJar,
      serverArgs: '',
    };
  }

  // Extract the JAR argument (respecting quotes)
  let jarEnd = 0;
  let detectedJar = '';
  if (afterJar.startsWith('"') || afterJar.startsWith("'")) {
    const quote = afterJar[0];
    let foundClosing = false;
    for (let j = 1; j < afterJar.length; j++) {
      if (afterJar[j] === quote && afterJar[j - 1] !== '\\') {
        jarEnd = j + 1;
        detectedJar = afterJar.slice(1, j);
        foundClosing = true;
        break;
      }
    }
    if (!foundClosing) {
      jarEnd = afterJar.length;
      detectedJar = afterJar.slice(1);
    }
  } else {
    const nextSpace = afterJar.search(/\s/);
    if (nextSpace === -1) {
      jarEnd = afterJar.length;
      detectedJar = afterJar;
    } else {
      jarEnd = nextSpace;
      detectedJar = afterJar.slice(0, nextSpace);
    }
  }

  const jarFile = detectedJar.trim() || fallbackJar;
  const serverArgs = afterJar.slice(jarEnd).trim();

  return {
    jvmFlags,
    jarFile,
    serverArgs,
  };
}

/**
 * Composes a single unified command arguments string from jvmFlags, jarFile, and serverArgs.
 * Preserves quoted values and produces a standard '[jvmFlags] -jar <jarFile> [serverArgs]' command line.
 */
export function composeStartupCommandLine(
  jvmFlags: string | null | undefined,
  jarFile: string | null | undefined,
  serverArgs: string | null | undefined
): string {
  const parts: string[] = [];
  const flags = (jvmFlags || '').trim();
  const jar = (jarFile || 'server.jar').trim();
  const args = (serverArgs || '').trim();

  if (flags) {
    parts.push(flags);
  }

  parts.push('-jar', quoteIfSpaces(jar));

  if (args) {
    parts.push(args);
  }

  return parts.join(' ');
}

/**
 * Updates only the JAR filename in an existing command arguments line,
 * preserving JVM flags and server arguments intact.
 */
export function updateJarInCommandLine(
  currentCommandLine: string,
  newJarFile: string,
  fallbackJar: string = 'server.jar'
): string {
  const parsed = splitStartupCommandLine(currentCommandLine, fallbackJar);
  return composeStartupCommandLine(parsed.jvmFlags, newJarFile, parsed.serverArgs);
}

/**
 * Applies the Aikar JVM flags preset to an existing command arguments line,
 * updating only the JVM portion while preserving the JAR file and server arguments intact.
 */
export function applyAikarPreset(
  currentCommandLine: string,
  aikarFlags: string,
  currentJar: string = 'server.jar'
): string {
  const parsed = splitStartupCommandLine(currentCommandLine, currentJar);
  const jarToUse = parsed.jarFile || currentJar;
  return composeStartupCommandLine(aikarFlags, jarToUse, parsed.serverArgs);
}
