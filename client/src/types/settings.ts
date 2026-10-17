export interface ServerMemorySettings {
  minMB: number;
  maxMB: number;
}

export interface ServerStartupSettings {
  jarFile: string;
  javaPath: string | null; // null = otomatik
  jvmFlags: string;
  serverArgs: string;
}

export interface ServerCrashSettings {
  autoRestart: boolean;
  maxRetries: number;
  delaySec: number;
}

export interface ServerStopSettings {
  command: string;
  timeoutSec: number;
  onTimeout: 'kill' | 'none';
}

export interface ServerRestartSettings {
  mode: 'graceful' | 'kill';
  delaySec: number;
  warnMessage: string | null;
  warnSeconds: number;
}

export interface ServerRuntimeSettings {
  memory: ServerMemorySettings;
  startup: ServerStartupSettings;
  autoStartOnBoot: 'never' | 'always' | 'last_state';
  crash: ServerCrashSettings;
  stop: ServerStopSettings;
  restart: ServerRestartSettings;
}

export interface UpdateSettingsResponse {
  settings: ServerRuntimeSettings;
  requiresRestart?: boolean;
}

export interface JavaInstallation {
  path: string;
  version?: string;
  rawVersion?: string;
  majorVersion?: number | null;
  vendor?: string;
  isDefault?: boolean;
}
