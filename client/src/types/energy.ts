export interface EnergyBucket {
  start: string; // ISO timestamp
  avgWatts: number;
  kwh: number;
  avgPlayers?: number;
  avgCpu?: number;
}

export interface EnergyArchive {
  id: string;
  from: string;
  to: string;
  totalKwh: number;
  avgWatts: number;
  costTL: number;
  hours: number;
}

export interface EnergyHistoryResponse {
  buckets: EnergyBucket[];
  archives: EnergyArchive[];
}

export interface EnergyArchiveDetail {
  summary: EnergyArchive;
  buckets: EnergyBucket[];
}

export interface EnergyResetResponse {
  success: boolean;
  archiveId?: string;
}
