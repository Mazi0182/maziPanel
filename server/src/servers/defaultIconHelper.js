const fs = require('fs');
const path = require('path');

const ASSET_ICON_PATH = path.join(__dirname, '../assets/default-server-icon.png');

let cachedBuffer = null;

function getDefaultIconBuffer() {
  if (cachedBuffer) return cachedBuffer;

  if (fs.existsSync(ASSET_ICON_PATH)) {
    try {
      cachedBuffer = fs.readFileSync(ASSET_ICON_PATH);
      return cachedBuffer;
    } catch (e) {
      console.warn('[defaultIconHelper] Could not read ASSET_ICON_PATH:', e.message);
    }
  }

  throw new Error('Default 64x64 server-icon.png asset not found.');
}

/**
 * Validates whether a file is a valid 64x64 PNG file according to Minecraft specification.
 */
function isValidServerIcon(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 60) return false;

    const fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(24);
    fs.readSync(fd, headerBuf, 0, 24, 0);
    fs.closeSync(fd);

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const isPng = headerBuf[0] === 0x89 &&
                  headerBuf[1] === 0x50 &&
                  headerBuf[2] === 0x4e &&
                  headerBuf[3] === 0x47 &&
                  headerBuf[4] === 0x0d &&
                  headerBuf[5] === 0x0a &&
                  headerBuf[6] === 0x1a &&
                  headerBuf[7] === 0x0a;
    if (!isPng) return false;

    const width = headerBuf.readUInt32BE(16);
    const height = headerBuf.readUInt32BE(20);

    return width === 64 && height === 64;
  } catch (e) {
    return false;
  }
}

/**
 * Ensures server-icon.png exists as a valid 64x64 PNG in server directory before start.
 * 1. Never replace custom server-icon.png if it exists and has content.
 * 2. If server-icon.png is missing and legacy icon.png exists:
 *    - If icon.png is a valid 64x64 PNG, copy it to server-icon.png (preserve original icon.png).
 *    - If icon.png is invalid/non-PNG, preserve original icon.png and write the default 64x64 server-icon.png.
 * 3. If neither exists, copy default 64x64 server-icon.png.
 */
function ensureServerIcon(serverDir) {
  if (!serverDir || typeof serverDir !== 'string') return false;

  const targetIconPath = path.join(serverDir, 'server-icon.png');
  const legacyIconPath = path.join(serverDir, 'icon.png');

  // Rule 1: Never replace custom server-icon.png if it exists and is non-empty
  if (fs.existsSync(targetIconPath)) {
    try {
      const stat = fs.statSync(targetIconPath);
      if (stat.size > 0) {
        return false;
      }
    } catch (e) {}
  }

  // Ensure destination directory exists
  try {
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
  } catch (err) {
    console.warn(`[defaultIconHelper] Could not create server directory ${serverDir}:`, err.message);
    return false;
  }

  // Rule 2: Check legacy icon.png if target server-icon.png is missing
  let legacyExists = false;
  try {
    if (fs.existsSync(legacyIconPath)) {
      const legacyStat = fs.statSync(legacyIconPath);
      if (legacyStat.size > 0) {
        legacyExists = true;
      }
    }
  } catch (e) {}

  if (legacyExists) {
    // If legacy icon is a valid 64x64 PNG, copy it to server-icon.png (preserve original icon.png)
    if (isValidServerIcon(legacyIconPath)) {
      try {
        fs.copyFileSync(legacyIconPath, targetIconPath);
        return true;
      } catch (err) {
        console.warn(`[defaultIconHelper] Failed to copy valid legacy icon ${legacyIconPath}:`, err.message);
      }
    }
    // If invalid legacy icon, do NOT erase it! Fallback to default real 64x64 server-icon.png
  }

  // Rule 3: Use default 64x64 server-icon.png
  try {
    const defaultBuf = getDefaultIconBuffer();
    fs.writeFileSync(targetIconPath, defaultBuf);
    return true;
  } catch (err) {
    console.warn(`[defaultIconHelper] Failed to write default server-icon.png to ${serverDir}:`, err.message);
    return false;
  }
}

module.exports = {
  getDefaultIconBuffer,
  isValidServerIcon,
  ensureServerIcon,
  ASSET_ICON_PATH
};
