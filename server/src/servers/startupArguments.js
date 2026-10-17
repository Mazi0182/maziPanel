/**
 * Startup arguments utility for maziPanel backend.
 * Provides reversible conversion, quote-safe splitting, and syntax validation
 * between unified command arguments and server settings (jvmFlags, jarFile, serverArgs).
 */

function stripQuotes(str) {
  if (!str) return '';
  const trimmed = String(str).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteIfSpaces(str) {
  if (!str && str !== '') return '';
  const trimmed = String(str).trim();
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
function validateStartupCommandLine(rawCommandLine) {
  const text = (rawCommandLine || '').trim();
  if (!text) {
    return { valid: true, error: null };
  }

  let inQuote = null;
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
function tokenizeArgs(argString, options = {}) {
  const { throwOnUnclosed = false } = options;
  if (!argString && argString !== '') return [];

  const text = String(argString);
  if (!text.trim() && !text.includes('""') && !text.includes("''")) {
    return [];
  }

  const tokens = [];
  let current = '';
  let inQuote = null;
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

function parseWithoutJarKeyword(text, fallbackJar = 'server.jar') {
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

function splitStartupCommandLine(rawCommandLine, fallbackJar = 'server.jar') {
  const text = (rawCommandLine || '').trim();
  if (!text) {
    return {
      jvmFlags: '',
      jarFile: fallbackJar,
      serverArgs: '',
    };
  }

  // Scan for '-jar' outside quotes
  let inQuote = null;
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

  const jvmFlags = text.slice(0, jarIndex).trim();
  const afterJar = text.slice(jarIndex + jarKeywordLen).trimStart();
  if (!afterJar) {
    return {
      jvmFlags,
      jarFile: fallbackJar,
      serverArgs: '',
    };
  }

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

function composeStartupCommandLine(jvmFlags, jarFile, serverArgs) {
  const parts = [];
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

function updateJarInCommandLine(currentCommandLine, newJarFile, fallbackJar = 'server.jar') {
  const parsed = splitStartupCommandLine(currentCommandLine, fallbackJar);
  return composeStartupCommandLine(parsed.jvmFlags, newJarFile, parsed.serverArgs);
}

function applyAikarPreset(currentCommandLine, aikarFlags, currentJar = 'server.jar') {
  const parsed = splitStartupCommandLine(currentCommandLine, currentJar);
  const jarToUse = parsed.jarFile || currentJar;
  return composeStartupCommandLine(aikarFlags, jarToUse, parsed.serverArgs);
}

/**
 * Checks a single flag or argument token for dangerous or unauthorized capabilities.
 * @param {string} token
 * @returns {{ dangerous: boolean, reason?: string }}
 */
function isDangerousJvmToken(token) {
  if (!token || typeof token !== 'string') return { dangerous: false };
  const trimmed = token.trim();

  // Normalize prefixes: -J, -J-, --jvm-arg=
  let normalized = trimmed;
  while (/^(-J-?[-@]|--jvm-arg=|-J-)/i.test(normalized)) {
    if (/^--jvm-arg=/i.test(normalized)) {
      normalized = normalized.replace(/^--jvm-arg=/i, '').trim();
    } else {
      normalized = normalized.replace(/^-J-?/i, '');
      if (!normalized.startsWith('-') && !normalized.startsWith('@')) {
        normalized = '-' + normalized;
      }
    }
  }

  // 1. @argfile injection
  if (normalized.startsWith('@')) {
    return {
      dangerous: true,
      reason: `Argfile ("${trimmed}") parametre dosyası kullanımına izin verilmez.`
    };
  }

  // 2. Classpath / Jar overrides
  if (/^-(cp|classpath|-class-path|jar)$/i.test(normalized) || /^--(class-path)=/i.test(normalized)) {
    return {
      dangerous: true,
      reason: `Sınıf yolu veya JAR dosyasını değiştiren "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 3. Native agent loading
  if (/^-javaagent/i.test(normalized) || /^-agentpath/i.test(normalized) || /^-agentlib/i.test(normalized)) {
    return {
      dangerous: true,
      reason: `Yerel aracı veya Java Agent yükleyen "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 4. Command execution on errors
  if (/^-XX:OnError=/i.test(normalized) || /^-XX:OnOutOfMemoryError=/i.test(normalized)) {
    return {
      dangerous: true,
      reason: `Hata anında harici komut/betik çalıştıran "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 5. Arbitrary file writing or dump creation
  if (
    /^-XX:(\+|-)?ErrorFile/i.test(normalized) ||
    /^-XX:(\+|-)?HeapDumpPath/i.test(normalized) ||
    /^-XX:(\+|-)?LogFile/i.test(normalized) ||
    /^-XX:(\+|-)?DumpLoadedClassList/i.test(normalized) ||
    /^-XX:(\+|-)?SharedArchiveFile/i.test(normalized)
  ) {
    return {
      dangerous: true,
      reason: `Dosyaya yazma veya bellek dökümü alma sağlayan "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 6. -Xlog arbitrary file output
  if (/^-Xlog/i.test(normalized)) {
    if (/file=/i.test(normalized)) {
      return {
        dangerous: true,
        reason: `Dosyaya log yazdırmayı sağlayan "${trimmed}" parametresine izin verilmez.`
      };
    }
    const parts = normalized.split(':');
    if (parts.length >= 3) {
      const outputTarget = parts[2].toLowerCase().trim();
      if (outputTarget && !['stdout', 'stderr', 'none'].includes(outputTarget)) {
        return {
          dangerous: true,
          reason: `Dosyaya log yazdırmayı sağlayan "${trimmed}" parametresine izin verilmez.`
        };
      }
    }
  }

  // 7. JFR arbitrary file path or unsafe dumping
  if (
    /^-XX:(\+|-)StartFlightRecording/i.test(normalized) ||
    /^-XX:StartFlightRecording/i.test(normalized) ||
    /^-XX:FlightRecorderOptions/i.test(normalized)
  ) {
    return {
      dangerous: true,
      reason: `Keyfi dosya yolu veya JFR tetikleyen "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 8. Native library path override
  if (/^-Djava\.library\.path=/i.test(normalized)) {
    return {
      dangerous: true,
      reason: `Yerel kütüphane yolunu değiştiren "${trimmed}" parametresine izin verilmez.`
    };
  }

  // 9. Security manager / policy override
  if (/^-Djava\.security\.(manager|policy)/i.test(normalized)) {
    return {
      dangerous: true,
      reason: `Güvenlik yöneticisi veya politika kurallarını değiştiren "${trimmed}" parametresine izin verilmez.`
    };
  }

  return { dangerous: false };
}

/**
 * Validates jvmFlags and serverArgs against dangerous command execution flags.
 * Throws Turkish error if a dangerous flag is encountered and user is not admin.
 */
function assertSafeStartupArguments(jvmFlags = '', serverArgs = '', options = {}) {
  const { isAdmin = false } = options;
  if (isAdmin) return true;

  const jvmTokens = tokenizeArgs(jvmFlags);
  for (const token of jvmTokens) {
    const check = isDangerousJvmToken(token);
    if (check.dangerous) {
      throw new Error(`Güvenlik nedeniyle "${token}" JVM bayrağı reddedildi: ${check.reason}`);
    }
  }

  const serverTokens = tokenizeArgs(serverArgs);
  for (const token of serverTokens) {
    const check = isDangerousJvmToken(token);
    if (check.dangerous) {
      throw new Error(`Güvenlik nedeniyle "${token}" sunucu argümanı reddedildi: ${check.reason}`);
    }
  }

  return true;
}

module.exports = {
  stripQuotes,
  quoteIfSpaces,
  validateStartupCommandLine,
  tokenizeArgs,
  splitStartupCommandLine,
  composeStartupCommandLine,
  updateJarInCommandLine,
  applyAikarPreset,
  isDangerousJvmToken,
  assertSafeStartupArguments,
};
