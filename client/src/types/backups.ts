export interface BackupStats {
  totalFiles?: number;
  changedFiles?: number;
  removedFiles?: number;
  unchangedFiles?: number;
  durationMs?: number;
}

export interface BackupItem {
  id: string;
  serverId?: string;
  name: string;
  filename: string;
  format: 'zip' | 'tar.gz' | 'tar';
  level: number;
  sizeBytes: number;
  sizeFormatted: string;
  createdAt: string;
  updatedAt?: string;
  source: 'manual' | 'scheduled';
  singleFile?: boolean;
  stats?: BackupStats;
  exists?: boolean;
}

export interface BackupSchedule {
  enabled: boolean;
  frequency: 'interval' | 'daily' | 'weekly';
  intervalHours?: number;
  intervalWindow?: { from: string; to: string } | null;
  dailyTime?: string;
  weeklyDays?: number[]; // 0 = Pazar, 1 = Pazartesi, ...
  weeklyTime?: string;
  name?: string;
  format: 'zip' | 'tar.gz' | 'tar';
  level: number;
  exclusions: string[];
  maxBackups: number | null; // null = sınırsız
  singleFile: boolean;
  targetBackupId?: string;
  runImmediately?: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastResult?: any;
}

export interface ArchiveEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  compressedBytes?: number | null;
  modifiedAt?: string | null;
}

export interface ArchiveEntriesResponse {
  path: string;
  entries: ArchiveEntry[];
}

export interface ArchiveEntryDetail {
  path: string;
  binary: boolean;
  content?: string;
  truncated?: boolean;
  sizeBytes?: number;
}
