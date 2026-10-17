const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Detect base directory: if on Linux and /mazideveloper exists, use it; otherwise use directory relative to server
const isRemoteProduction = process.platform !== 'win32' && fs.existsSync('/mazideveloper');
const BASE_DIR = process.env.BASE_DIR || (isRemoteProduction ? '/mazideveloper' : path.resolve(__dirname, '..'));

const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const SERVERS_DIR = process.env.SERVERS_DIR || path.join(BASE_DIR, 'servers');
const TEMP_DIR = process.env.TEMP_DIR || path.join(BASE_DIR, 'temp');
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(BASE_DIR, 'backups');
const CLIENT_DIST_DIR = process.env.CLIENT_DIST_DIR || path.join(BASE_DIR, 'client', 'dist');

// Ensure essential directories exist
[DATA_DIR, SERVERS_DIR, TEMP_DIR, BACKUPS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create directory ${dir}:`, err.message);
    }
  }
});

// Load or generate JWT Secret
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt.secret');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (fs.existsSync(JWT_SECRET_FILE)) {
    JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(64).toString('hex');
    try {
      fs.writeFileSync(JWT_SECRET_FILE, JWT_SECRET, { mode: 0o600 });
    } catch (err) {
      console.warn(`Could not persist JWT secret to ${JWT_SECRET_FILE}:`, err.message);
    }
  }
}

module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  HOST: process.env.HOST || '0.0.0.0',
  BASE_DIR,
  DATA_DIR,
  SERVERS_DIR,
  TEMP_DIR,
  BACKUPS_DIR,
  CLIENT_DIST_DIR,
  SINGLE_USER_MODE: process.env.SINGLE_USER_MODE === 'true',
  TRUST_PROXY: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',
  TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS
    ? process.env.TRUSTED_ORIGINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [],
  JWT_SECRET,
  JWT_EXPIRES_IN: '30d',
  RING_BUFFER_SIZE: 1000,
  KNOWN_JAVA_PATHS: [
    '/usr/lib/jvm/jdk-27-oracle-x64/bin/java',
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    '/usr/bin/java'
  ],
  ENERGY: {
    BOARD_BASE_W: parseFloat(process.env.ENERGY_BOARD_BASE_W || '11.5'),
    PSU_EFFICIENCY: parseFloat(process.env.ENERGY_PSU_EFFICIENCY || '0.86'),
    IDLE_W: parseFloat(process.env.ENERGY_IDLE_W || '18.2'),
    CPU_DYNAMIC_W: parseFloat(process.env.ENERGY_CPU_DYNAMIC_W || '42'),
    RAM_W: parseFloat(process.env.ENERGY_RAM_W || '2.5'),
    MIN_HOURS_FOR_ESTIMATE: parseInt(process.env.ENERGY_MIN_HOURS || '24', 10),
    TARIFF: {
      LOW_RATE: 3.24,
      HIGH_RATE: 4.32,
      SKTT_RATE: 4.86,
      LOW_TIER_LIMIT_KWH: 240,
      ANNUAL_LIMIT_KWH: 4000,
      SOURCE: 'EPDK 04.04.2026 Mesken'
    }
  }
};
