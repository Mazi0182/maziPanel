export type TabType = 
  | 'dashboard' 
  | 'console' 
  | 'logs'
  | 'servers' 
  | 'zip_import' 
  | 'files' 
  | 'players'
  | 'backups'
  | 'server_settings'
  | 'system' 
  | 'settings'
  | 'integrations'
  | 'p2p';

export interface BackupRecord {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  filename: string;
  filePath: string;
  destDir?: string;
  compression: 'gzip' | 'zip' | 'none' | string;
  exclusions: string[];
  sizeBytes: number;
  sizeFormatted: string;
  createdAt: string;
  exists?: boolean;
}

export type ServerStatus = 'online' | 'starting' | 'stopping' | 'offline' | 'crashed';

export interface ServerMetrics {
  cpu: number; // 0-100%
  ramUsed: number; // in GB
  ramMax: number; // in GB
  memoryMB?: number; // server process MB
  allocatedRam?: string; // e.g. "1 GB"
  diskUsed: number; // in GB
  diskMax: number; // in GB
  tps: number; // e.g. 20.0
  ping: number; // in ms
  uptime: string;
  onlinePlayers: number;
  maxPlayers: number;
  status: ServerStatus;
  ip: string;
  port: number;
  version: string;
  coreType: string;
  cpuModel?: string;
}

export interface PowerCollection {
  hoursCollected: number;
  requiredHours: number;
  progressPct: number;
  sampleCount: number;
  since: string | null;
}

export interface PowerTariff {
  lowRate: number;
  highRate: number;
  sktRate: number;
  lowTierLimitKwh: number;
  annualLimitKwh: number;
  source: string;
  updatedAt?: string | null;
  liveVerified?: boolean;
}

export interface PowerMetrics {
  watts: number;
  estimateReady: boolean;
  collection: PowerCollection;
  avgWatts?: number | null;
  idleAvgWatts?: number | null;
  activeAvgWatts?: number | null;
  activeTimePct?: number | null;
  avgPlayers?: number | null;
  kwhPerDay?: number | null;
  kwhPerMonth?: number | null;
  kwhPerYear?: number | null;
  dailyCostTL?: number | null;
  monthlyCostTL?: number | null;
  yearlyCostTL?: number | null;
  effectiveRateTL: number | null;
  tier: 'low' | 'high' | 'sktt' | null;
  exceedsAnnualLimit: boolean;
  tariff: PowerTariff;
  // Legacy backward compatibility fields
  costRateTL?: number;
}

export interface SoftwareStackItem {
  name: string;
  version: string;
  status: 'active' | 'inactive' | 'missing';
  role?: string;
}

export interface NetworkMetrics {
  interface?: string;
  speed?: string;
  speedMbps?: number;
  duplex?: string;
  desc?: string;
  status?: string;
}

export interface HostMetrics {
  cpu: {
    usagePercent: number;
    model: string;
    cores: number;
    loadAverage: number[];
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePct: number;
  };
  network?: NetworkMetrics;
  system: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    osName?: string;
    uptimeSeconds: number;
    daemonUptimeSeconds: number;
    nodeVersion: string;
  };
  power?: PowerMetrics;
  software?: SoftwareStackItem[];
  timestamp: string;
}

export interface Player {
  id: string;
  username: string;
  uuid: string;
  ping: number;
  joinedAt: string;
  isOp: boolean;
  isWhitelisted: boolean;
  avatarUrl?: string;
  skinName?: string;
  skinUuid?: string;
  skinTextureHash?: string;
  skinSource?: string;
}

export type LogType = 'stdout' | 'stderr' | 'system';
export type LogEvent = 'starting' | 'online' | 'stopping' | 'offline' | 'crash' | 'restarting' | 'command' | 'done';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  raw: string;
  type?: LogType;
  event?: LogEvent;
  isCommandEcho?: boolean;
}

export interface LogFileInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  compressed: boolean;
}

export interface LogFileContent {
  name: string;
  content: string;
  truncated?: boolean;
}

export interface ServerFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  content?: string;
  children?: ServerFile[];
}

export interface ServerInstance {
  id: string;
  name: string;
  owner?: string;
  type: 'Paper' | 'Purpur' | 'Fabric' | 'Spigot' | 'BungeeCord' | 'Vanilla' | string;
  version: string;
  port: number;
  status: ServerStatus;
  ramAllocated: string;
  playersCount: number;
  maxPlayers: number;
  icon?: string;
  directory?: string;
  jarFile?: string;
  javaPath?: string;
  runtime?: {
    status: ServerStatus;
    pid: number | null;
    uptime: number;
    allocatedFormatted?: string;
  };
}

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type?: 'default' | 'success' | 'warning' | 'error' | 'info';
}
