const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

// Pre-configure IPv4 and IPv6 block lists using Node.js built-in net.BlockList
const ipv4BlockList = new net.BlockList();
ipv4BlockList.addSubnet('0.0.0.0', 8, 'ipv4');       // Current network / "This host" (RFC 1122)
ipv4BlockList.addSubnet('10.0.0.0', 8, 'ipv4');      // Private-use (RFC 1918)
ipv4BlockList.addSubnet('100.64.0.0', 10, 'ipv4');   // Carrier-Grade NAT (RFC 6598)
ipv4BlockList.addSubnet('127.0.0.0', 8, 'ipv4');     // Loopback (RFC 1122)
ipv4BlockList.addSubnet('169.254.0.0', 16, 'ipv4');  // Link-Local / Cloud metadata (RFC 3927)
ipv4BlockList.addSubnet('172.16.0.0', 12, 'ipv4');   // Private-use (RFC 1918)
ipv4BlockList.addSubnet('192.0.0.0', 24, 'ipv4');    // IETF Protocol Assignments (RFC 6890)
ipv4BlockList.addSubnet('192.0.2.0', 24, 'ipv4');    // TEST-NET-1 (RFC 5737)
ipv4BlockList.addSubnet('192.88.99.0', 24, 'ipv4');  // 6to4 Relay Anycast (RFC 7526)
ipv4BlockList.addSubnet('192.168.0.0', 16, 'ipv4');  // Private-use (RFC 1918)
ipv4BlockList.addSubnet('198.18.0.0', 15, 'ipv4');   // Benchmarking (RFC 2544)
ipv4BlockList.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2 (RFC 5737)
ipv4BlockList.addSubnet('203.0.113.0', 24, 'ipv4');  // TEST-NET-3 (RFC 5737)
ipv4BlockList.addSubnet('224.0.0.0', 4, 'ipv4');     // Multicast (RFC 5771)
ipv4BlockList.addSubnet('240.0.0.0', 4, 'ipv4');     // Reserved (RFC 1112)
ipv4BlockList.addAddress('255.255.255.255', 'ipv4'); // Limited Broadcast (RFC 919)

const ipv6BlockList = new net.BlockList();
ipv6BlockList.addAddress('::1', 'ipv6');             // Loopback (RFC 4291)
ipv6BlockList.addAddress('::', 'ipv6');              // Unspecified (RFC 4291)
ipv6BlockList.addSubnet('100::', 64, 'ipv6');        // Discard-Only (RFC 6666)
ipv6BlockList.addSubnet('2001:10::', 28, 'ipv6');    // ORCHIDv2 (RFC 7343)
ipv6BlockList.addSubnet('2001:db8::', 32, 'ipv6');   // Documentation (RFC 3849)
ipv6BlockList.addSubnet('fc00::', 7, 'ipv6');        // Unique Local (RFC 4193)
ipv6BlockList.addSubnet('fe80::', 10, 'ipv6');       // Link-Local Unicast (RFC 4291)
ipv6BlockList.addSubnet('ff00::', 8, 'ipv6');        // Multicast (RFC 4291)

/**
 * Parses an IPv6 string into an array of 8 16-bit word values (0 - 65535).
 * Handles bracketed forms, zone indices, embedded dotted-quads, and '::' expansion.
 *
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv6Words(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let str = ip.trim().toLowerCase();

  if (str.startsWith('[') && str.endsWith(']')) {
    str = str.slice(1, -1);
  }

  const zoneIndex = str.indexOf('%');
  if (zoneIndex !== -1) {
    str = str.slice(0, zoneIndex);
  }

  // Handle trailing dotted-decimal IPv4 representation
  const lastColon = str.lastIndexOf(':');
  if (lastColon !== -1) {
    const afterLastColon = str.slice(lastColon + 1);
    if (afterLastColon.includes('.')) {
      const parts = afterLastColon.split('.').map((p) => parseInt(p, 10));
      if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        const hex1 = ((parts[0] << 8) | parts[1]).toString(16);
        const hex2 = ((parts[2] << 8) | parts[3]).toString(16);
        str = str.slice(0, lastColon) + ':' + hex1 + ':' + hex2;
      } else {
        return null;
      }
    }
  }

  const parts = str.split('::');
  if (parts.length > 2) return null;

  let words = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    words = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    words = str.split(':');
  }

  if (words.length !== 8) return null;
  const numWords = [];
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    numWords.push(parseInt(w, 16));
  }
  return numWords;
}

function wordsToIpv4(w1, w2) {
  return [
    (w1 >> 8) & 0xff,
    w1 & 0xff,
    (w2 >> 8) & 0xff,
    w2 & 0xff
  ].join('.');
}

/**
 * Extracts an embedded IPv4 address from transition and compatibility IPv6 formats.
 *
 * @param {number[]} words Array of 8 16-bit words.
 * @returns {string|null} Dotted-decimal IPv4 string or null if not embedded.
 */
function extractEmbeddedIpv4(words) {
  if (!words || words.length !== 8) return null;

  // 1. IPv4-mapped IPv6 (::ffff:0:0/96, including hex format like ::ffff:7f00:1)
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
    return wordsToIpv4(words[6], words[7]);
  }

  // 2. IPv4-compatible IPv6 (::0:0/96)
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) {
    return wordsToIpv4(words[6], words[7]);
  }

  // 3. NAT64 Well-Known Prefix (64:ff9b::/96)
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) {
    return wordsToIpv4(words[6], words[7]);
  }

  // 4. NAT64 Local-Use (64:ff9b:1::/48)
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1 && words[3] === 0 && words[4] === 0 && words[5] === 0) {
    return wordsToIpv4(words[6], words[7]);
  }

  // 5. 6to4 (2002::/16) - Embedded IPv4 resides in words 1 and 2
  if (words[0] === 0x2002) {
    return wordsToIpv4(words[1], words[2]);
  }

  // 6. ISATAP (*:*:*:*:0000:5efe:x:x or *:*:*:*:0200:5efe:x:x)
  if ((words[4] === 0 || words[4] === 0x0200) && words[5] === 0x5efe) {
    return wordsToIpv4(words[6], words[7]);
  }

  return null;
}

/**
 * Checks if an IP address belongs to loopback, private, link-local,
 * multicast, CGNAT, 0.0.0.0, or other non-routable ranges.
 * Normalizes all IPv6 forms (hex mapped, compat, NAT64, 6to4, ISATAP) to IPv4.
 *
 * @param {string} ip
 * @returns {boolean} True if the IP is private or blocked; false if public.
 */
function isPrivateOrBlockedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  let cleanIp = ip.trim();

  if (cleanIp.startsWith('[') && cleanIp.endsWith(']')) {
    cleanIp = cleanIp.slice(1, -1);
  }

  // 1. Direct IPv4 Check
  if (net.isIPv4(cleanIp)) {
    try {
      return ipv4BlockList.check(cleanIp, 'ipv4');
    } catch (e) {
      return true;
    }
  }

  // 2. IPv6 Check & IPv4 Normalization
  const words = parseIPv6Words(cleanIp);
  if (words) {
    // If IPv6 encapsulates an embedded IPv4, check normalized IPv4 address
    const embeddedIpv4 = extractEmbeddedIpv4(words);
    if (embeddedIpv4) {
      if (isPrivateOrBlockedIp(embeddedIpv4)) {
        return true;
      }
    }

    // Check standard IPv6 ranges
    try {
      if (ipv6BlockList.check(cleanIp, 'ipv6')) {
        return true;
      }
    } catch (e) {
      try {
        const canonical = words.map((w) => w.toString(16)).join(':');
        if (ipv6BlockList.check(canonical, 'ipv6')) {
          return true;
        }
      } catch (err) {
        return true;
      }
    }

    return false;
  }

  // Not a valid IP literal
  return true;
}

/**
 * Validates a webhook URL against SSRF rules.
 * Resolves all DNS records and ensures none are private, loopback, or reserved.
 *
 * @param {string} urlStr
 * @returns {Promise<{ url: string, parsedUrl: URL, verifiedIp: string, family: number }>}
 */
async function validateWebhookUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new Error('Geçerli bir webhook URL adresi gereklidir.');
  }

  const trimmed = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    throw new Error('Geçersiz webhook URL biçimi.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL adresi yalnızca http:// veya https:// protokolünü kullanabilir.');
  }

  let hostname = parsed.hostname;
  if (!hostname) {
    throw new Error('Webhook URL adresinde sunucu adı (hostname) bulunamadı.');
  }

  // Remove bracket enclosing for IPv6 URLs like http://[::1]:8080
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // If test environment explicitly permits loopback for mock server testing
  const allowTestLoopback = process.env.ALLOW_TEST_LOOPBACK === 'true';

  // If hostname is directly an IP literal
  if (net.isIP(hostname)) {
    const isBlocked = isPrivateOrBlockedIp(hostname);
    if (isBlocked && (!allowTestLoopback || hostname !== '127.0.0.1')) {
      throw new Error('Webhook adresi yerel ağ veya sunucu içi bir adrese yönlendirilemez.');
    }
    // Restrict destination ports to standard 80/443 (or safe allowlist in test environment)
    const isHttps = parsed.protocol === 'https:';
    const effectivePort = parsed.port || (isHttps ? '443' : '80');
    const ALLOWED_PORTS = new Set(['80', '443']);
    if (!ALLOWED_PORTS.has(effectivePort) && !allowTestLoopback) {
      throw new Error('Güvenlik nedeniyle webhook adreslerinde yalnızca 80 ve 443 portlarına izin verilmektedir.');
    }
    return {
      url: trimmed,
      parsedUrl: parsed,
      verifiedIp: hostname,
      family: net.isIPv4(hostname) ? 4 : 6
    };
  }

  // Check for common local hostname aliases before DNS
  const lowerHost = hostname.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') || lowerHost.endsWith('.local') || lowerHost.endsWith('.internal')) {
    if (!allowTestLoopback) {
      throw new Error('Webhook adresi yerel ağ veya sunucu içi bir adrese yönlendirilemez.');
    }
  }

  // Restrict destination ports to standard 80/443 (or safe allowlist in test environment)
  const isHttps = parsed.protocol === 'https:';
  const effectivePort = parsed.port || (isHttps ? '443' : '80');
  const ALLOWED_PORTS = new Set(['80', '443']);
  if (!ALLOWED_PORTS.has(effectivePort) && !allowTestLoopback) {
    throw new Error('Güvenlik nedeniyle webhook adreslerinde yalnızca 80 ve 443 portlarına izin verilmektedir.');
  }

  // Resolve hostname with DNS
  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`Webhook sunucu adı çözümlenemedi (${hostname}): ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`Webhook sunucu adı çözümlenemedi (${hostname}).`);
  }

  // Validate ALL resolved addresses
  for (const addr of addresses) {
    const isBlocked = isPrivateOrBlockedIp(addr.address);
    if (isBlocked && (!allowTestLoopback || addr.address !== '127.0.0.1')) {
      throw new Error('Webhook adresi yerel ağ veya sunucu içi bir adrese yönlendirilemez.');
    }
  }

  const primary = addresses[0];
  return {
    url: trimmed,
    parsedUrl: parsed,
    verifiedIp: primary.address,
    family: primary.family || (net.isIPv4(primary.address) ? 4 : 6)
  };
}

/**
 * Sends a safe HTTP POST JSON request with:
 * - SSRF pre-validation
 * - DNS rebinding prevention via socket lookup override pinned to verified IP
 * - No automatic redirect following
 * - 5s timeout
 * - Response body size limit (64 KB)
 *
 * @param {string} targetUrl
 * @param {object|string} jsonPayload
 * @param {object} customHeaders
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, lastStatus: string, error?: string }>}
 */
async function sendSafeWebhookPost(targetUrl, jsonPayload, customHeaders = {}, timeoutMs = 5000) {
  let validated;
  try {
    validated = await validateWebhookUrl(targetUrl);
  } catch (valErr) {
    return {
      ok: false,
      status: 0,
      statusText: valErr.message,
      lastStatus: `Hata: ${valErr.message}`,
      error: valErr.message
    };
  }

  return new Promise((resolve) => {
    try {
      const isHttps = validated.parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const dataStr = typeof jsonPayload === 'string' ? jsonPayload : JSON.stringify(jsonPayload);

      const port = validated.parsedUrl.port
        ? parseInt(validated.parsedUrl.port, 10)
        : (isHttps ? 443 : 80);

      const pathStr = (validated.parsedUrl.pathname || '/') + (validated.parsedUrl.search || '');

      const reqHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr),
        'User-Agent': 'maziPanel-Webhook/1.0',
        'Host': validated.parsedUrl.host,
        ...customHeaders
      };

      const reqOptions = {
        protocol: validated.parsedUrl.protocol,
        hostname: validated.parsedUrl.hostname,
        port,
        path: pathStr,
        method: 'POST',
        headers: reqHeaders,
        timeout: timeoutMs,
        // Override DNS lookup to pin socket directly to verified IP (anti-DNS rebinding)
        lookup: (lookupHost, lookupOptions, callback) => {
          if (typeof lookupOptions === 'function') {
            callback = lookupOptions;
            lookupOptions = {};
          }

          // Re-validate verified IP before establishing connection
          const allowLoopback = process.env.ALLOW_TEST_LOOPBACK === 'true';
          const isBlocked = isPrivateOrBlockedIp(validated.verifiedIp);
          if (isBlocked && (!allowLoopback || validated.verifiedIp !== '127.0.0.1')) {
            return callback(new Error('Webhook adresi yerel ağ veya sunucu içi bir adrese yönlendirilemez.'));
          }

          // Handle both options.all === true (array of { address, family }) and false (callback(err, address, family))
          if (lookupOptions && lookupOptions.all) {
            return callback(null, [{ address: validated.verifiedIp, family: validated.family }]);
          }
          return callback(null, validated.verifiedIp, validated.family);
        }
      };

      const req = client.request(reqOptions, (res) => {
        let body = '';
        let totalBytes = 0;
        const MAX_BODY_BYTES = 64 * 1024; // 64 KB

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          totalBytes += Buffer.byteLength(chunk, 'utf8');
          if (totalBytes > MAX_BODY_BYTES) {
            // Exceeded response size limit
            res.destroy();
            return;
          }
          if (body.length < 500) {
            body += chunk;
          }
        });

        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          const ok = statusCode >= 200 && statusCode < 300;
          const statusText = res.statusMessage || (ok ? 'Tamam' : 'Hata');
          resolve({
            ok,
            status: statusCode,
            statusText,
            lastStatus: ok
              ? `${statusCode} ${statusText}`.trim()
              : `HTTP ${statusCode}: ${(body || statusText).slice(0, 100)}`
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('İstek zaman aşımına uğradı (5 sn).'));
      });

      req.on('error', (err) => {
        const isTimeout = err.message && (err.message.includes('zaman aşımı') || err.message.includes('timeout'));
        const errMsg = isTimeout ? 'İstek zaman aşımına uğradı (5 sn).' : err.message;
        resolve({
          ok: false,
          status: 0,
          statusText: errMsg,
          lastStatus: `Bağlantı hatası: ${errMsg}`,
          error: errMsg
        });
      });

      req.write(dataStr);
      req.end();
    } catch (err) {
      resolve({
        ok: false,
        status: 0,
        statusText: err.message,
        lastStatus: `İstek hatası: ${err.message}`,
        error: err.message
      });
    }
  });
}

module.exports = {
  isPrivateOrBlockedIp,
  validateWebhookUrl,
  sendSafeWebhookPost
};
