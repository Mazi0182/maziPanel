import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ServerMetrics, Player, LogEntry, ServerInstance, HostMetrics, ServerStatus, LogType } from '../types';
import { parseLogLine, selectHistoryEntries, appendParsedLogEntry } from '../utils/parseLog';
import { formatRam } from '../utils/format';
import { fetchWithAuth, clearStoredToken } from '../auth/authSession';

export function useServerData(initialServerId?: string | null) {
  const [servers, setServers] = useState<ServerInstance[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(initialServerId || null);
  const [hostMetrics, setHostMetrics] = useState<HostMetrics | null>(null);
  const [serverMetricsMap, setServerMetricsMap] = useState<Record<string, any>>({});
  const [measuredPing, setMeasuredPing] = useState<number>(2);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoadingServers, setIsLoadingServers] = useState<boolean>(true);

  const wsRef = useRef<WebSocket | null>(null);
  const activeSubscriptionRef = useRef<string | null>(null);
  const activeServerIdRef = useRef<string | null>(selectedServerId);
  const currentSessionIdRef = useRef<Record<string, string | null>>({});
  const logFetchSeqRef = useRef<number>(0);
  const logSeqRef = useRef<number>(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Helper: format seconds to human-readable string
  const formatUptime = (seconds: number): string => {
    if (!seconds || seconds <= 0) return '0 dk';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days} gün`);
    if (hours > 0) parts.push(`${hours} saat`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes} dk`);
    return parts.join(' ');
  };

  // 1. Fetch real servers from API with real RTT latency check
  const fetchServers = useCallback(async () => {
    try {
      const t0 = performance.now();
      const res = await fetchWithAuth('/api/servers');
      const rtt = Math.max(1, Math.round(performance.now() - t0));
      setMeasuredPing(rtt);

      if (!res.ok) throw new Error('Sunucu listesi alınamadı');
      const data = await res.json();
      if (Array.isArray(data)) {
        const mapped: ServerInstance[] = data.map((s: any) => {
          const rawStatus = s.runtime?.status || (s.crashed ? 'crashed' : (s.status || 'offline'));
          const status: ServerStatus = rawStatus === 'crashed' ? 'crashed' : rawStatus;
          const apiMaxPlayers = s.maxPlayers ?? s.detectedProperties?.maxPlayers ?? s.runtime?.maxPlayers;
          const maxPlayers = (apiMaxPlayers !== undefined && apiMaxPlayers !== null && !isNaN(parseInt(apiMaxPlayers, 10)))
            ? parseInt(apiMaxPlayers, 10)
            : 10;
          return {
            id: s.id,
            name: s.name,
            owner: s.owner,
            type: s.type || 'Purpur',
            version: s.version || '26.3',
            port: s.port || 25565,
            status,
            ramAllocated: formatRam(s.runtime?.allocatedFormatted || s.maxRam || '4 GB'),
            playersCount: Array.isArray(s.runtime?.onlinePlayers) ? s.runtime.onlinePlayers.length : 0,
            maxPlayers,
            icon: (s.icon || s.iconUrl) ? (s.icon || s.iconUrl) : undefined,
            directory: s.directory,
            jarFile: s.jarFile,
            javaPath: s.javaPath,
            runtime: s.runtime ? { ...s.runtime, status, allocatedFormatted: formatRam(s.runtime.allocatedFormatted) } : undefined,
          };
        });

        setServers((prev) => {
          // Stabilize icon URLs against polling cache-busting timestamp jitter
          const stabilizedMapped = mapped.map((m) => {
            const prevServer = prev.find((p) => p.id === m.id);
            if (prevServer?.icon && m.icon) {
              const basePrev = prevServer.icon.split('?')[0];
              const baseNew = m.icon.split('?')[0];
              if (basePrev === baseNew) {
                return { ...m, icon: prevServer.icon };
              }
            }
            return m;
          });

          if (prev.length !== stabilizedMapped.length) return stabilizedMapped;
          const hasDiff = stabilizedMapped.some((m, i) => {
            const p = prev[i];
            return !p || p.id !== m.id || p.owner !== m.owner || p.status !== m.status || p.name !== m.name || p.port !== m.port || p.ramAllocated !== m.ramAllocated || p.playersCount !== m.playersCount || p.maxPlayers !== m.maxPlayers || p.icon !== m.icon;
          });
          return hasDiff ? stabilizedMapped : prev;
        });

        // Only re-select if a server was already selected but no longer exists
        setSelectedServerId((curr) => {
          if (curr && !mapped.some((m) => m.id === curr)) {
            return mapped.length > 0 ? mapped[0].id : null;
          }
          return curr;
        });
      }
    } catch (err) {
      console.warn('Servers fetch failed:', err);
    } finally {
      setIsLoadingServers(false);
    }
  }, []);

  // 2. Fetch real host hardware metrics
  const fetchHostMetrics = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/metrics/host');
      if (!res.ok) return;
      const data: HostMetrics = await res.json();
      setHostMetrics(data);
    } catch (err) {
      console.warn('Host metrics fetch failed:', err);
    }
  }, []);

  // 3. Fetch server specific metrics
  const fetchServerMetrics = useCallback(async (id: string) => {
    try {
      const res = await fetchWithAuth(`/api/metrics/server/${id}`);
      if (res.ok) {
        const data = await res.json();
        setServerMetricsMap((prev) => ({ ...prev, [id]: data }));
      }
    } catch {}
  }, []);

  // When active server changes, sync activeServerIdRef and reset current console logs to avoid cross-server bleed
  useEffect(() => {
    activeServerIdRef.current = selectedServerId;
    logFetchSeqRef.current++;
    setLogs([]);
  }, [selectedServerId]);

  // 4. Fetch initial logs
  const fetchLogs = useCallback(async (serverId: string) => {
    if (!serverId) return;
    const seq = ++logFetchSeqRef.current;
    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}/logs?limit=300`);
      if (!res.ok) return;

      if (seq !== logFetchSeqRef.current || activeServerIdRef.current !== serverId) {
        return;
      }

      const respSessionId = res.headers.get('X-Session-Id');
      const knownSession = currentSessionIdRef.current[serverId];
      if (knownSession && respSessionId && respSessionId !== knownSession) {
        return;
      }
      if (respSessionId && !knownSession) {
        currentSessionIdRef.current[serverId] = respSessionId;
      }

      const data = await res.json();
      if (seq !== logFetchSeqRef.current || activeServerIdRef.current !== serverId) {
        return;
      }

      // Recheck current session after body decode in case console_reset arrived during await
      const currentSessionAfter = currentSessionIdRef.current[serverId];
      if (currentSessionAfter && respSessionId && respSessionId !== currentSessionAfter) {
        return;
      }

      if (Array.isArray(data)) {
        let parsedList: LogEntry[] = [];
        let currentLevel: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO';
        data.forEach((item) => {
          const seqIdx = ++logSeqRef.current;
          const entry = parseLogLine(item, seqIdx, currentLevel);
          if (entry) {
            currentLevel = entry.level;
            parsedList = appendParsedLogEntry(parsedList, entry, 500);
          }
        });

        setLogs(parsedList);
      }
    } catch (e) {
      console.warn('Failed to fetch logs:', e);
    }
  }, []);

  // Fetch servers & host metrics on mount and periodic poll
  useEffect(() => {
    fetchServers();
    fetchHostMetrics();
    if (selectedServerId) {
      fetchServerMetrics(selectedServerId);
      fetchLogs(selectedServerId);
    }

    const interval = setInterval(() => {
      fetchHostMetrics();
      fetchServers();
      if (selectedServerId) {
        fetchServerMetrics(selectedServerId);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchServers, fetchHostMetrics, fetchServerMetrics, fetchLogs, selectedServerId]);

  // Selected server object (memoized to avoid unneeded re-renders on polling)
  const selectedServer = useMemo(
    () => (selectedServerId ? servers.find((s) => s.id === selectedServerId) || null : null),
    [servers, selectedServerId]
  );

  // 3. Fetch players for the selected server
  const fetchPlayers = useCallback(async (serverId: string) => {
    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}/players`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.online)) {
        const nextPlayers: Player[] = data.online
          .map((p: any, idx: number) => {
            const username = typeof p === 'string' ? p : (p.username || p.name || '');
            if (!username) return null;
            const uuid = typeof p === 'object' && p.uuid ? p.uuid : '';
            const avatarUrl = typeof p === 'object' && p.avatarUrl ? p.avatarUrl : undefined;
            const skinName = typeof p === 'object' && p.skinName ? p.skinName : undefined;
            const skinUuid = typeof p === 'object' && p.skinUuid ? p.skinUuid : undefined;
            const skinTextureHash = typeof p === 'object' && p.skinTextureHash ? p.skinTextureHash : undefined;
            const skinSource = typeof p === 'object' && p.skinSource ? p.skinSource : undefined;
            return {
              id: uuid || `player-${username}`,
              username,
              uuid,
              ping: typeof p === 'object' && p.ping !== undefined ? p.ping : 1,
              joinedAt: typeof p === 'object' && p.joinedAt ? p.joinedAt : 'Aktif',
              isOp: typeof p === 'object' ? !!p.isOp : false,
              isWhitelisted: typeof p === 'object' ? !!p.isWhitelisted : false,
              avatarUrl,
              skinName,
              skinUuid,
              skinTextureHash,
              skinSource,
            };
          })
          .filter(Boolean) as Player[];

        setPlayers((prev) => {
          if (prev.length !== nextPlayers.length) return nextPlayers;
          const isSame = prev.every((p, i) => {
            const n = nextPlayers[i];
            return (
              n &&
              p.username === n.username &&
              p.isOp === n.isOp &&
              p.isWhitelisted === n.isWhitelisted &&
              p.ping === n.ping &&
              p.avatarUrl === n.avatarUrl
            );
          });
          return isSame ? prev : nextPlayers;
        });
      }
    } catch (err) {
      console.warn('Players fetch failed:', err);
    }
  }, []);

  useEffect(() => {
    if (selectedServer && selectedServer.status === 'online') {
      fetchPlayers(selectedServer.id);
      const pInterval = setInterval(() => {
        fetchPlayers(selectedServer.id);
      }, 5000);
      return () => clearInterval(pInterval);
    } else {
      setPlayers([]);
    }
  }, [selectedServer?.id, selectedServer?.status, fetchPlayers]);

  // 4. WebSocket setup for real-time logs & status
  useEffect(() => {
    let socket: WebSocket | null = null;
    let isDisposed = false;
    let authFailed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connectWebSocket = () => {
      if (isDisposed || authFailed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws`;

      try {
        socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (isDisposed || authFailed) {
            try { socket?.close(); } catch {}
            return;
          }
          setIsConnected(true);

          // Subscribe to selected server console if available
          const currentTargetId = activeServerIdRef.current;
          if (currentTargetId) {
            socket?.send(
              JSON.stringify({
                type: 'subscribe_console',
                serverId: currentTargetId,
              })
            );
            activeSubscriptionRef.current = currentTargetId;
          }

          socket?.send(JSON.stringify({ type: 'subscribe_metrics' }));
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            // Handle WS auth errors: stop reconnecting and dispatch logout flow
            const isAuthError =
              data.type === 'auth_error' ||
              data.event === 'auth_error' ||
              data.error === 'auth_error' ||
              data.error === 'unauthorized' ||
              (data.type === 'error' && data.code === 'UNAUTHORIZED');

            if (isAuthError) {
              authFailed = true;
              if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
              }
              if (typeof window !== 'undefined') {
                clearStoredToken();
                window.dispatchEvent(new CustomEvent('session-expired'));
                window.dispatchEvent(new CustomEvent('mazipanel:unauthorized'));
              }
              try { socket?.close(); } catch {}
              return;
            }

            // 0. Explicit console reset / lifecycle start: clear logs when next server start/restart begins
            if (data.type === 'console_reset' || data.event === 'console_reset') {
              const srvId = data.serverId;
              if (srvId && data.sessionId) {
                currentSessionIdRef.current[srvId] = data.sessionId;
              }
              if (srvId && srvId === activeServerIdRef.current) {
                // Invalidate any in-flight HTTP log history fetch immediately
                logFetchSeqRef.current++;
                setLogs([]);
              }
              return;
            }

            // 1. Canlı konsol satırları: data.type === 'console_line' önce yakalanır
            // Top-level data.event ('online', 'done' vb.) diğer durum kontrollerini (server_status, server_logs) etkilemez
            if (data.type === 'console_line') {
              const srvId = data.serverId;
              if (srvId && srvId !== activeServerIdRef.current) {
                return;
              }
              if (srvId && data.sessionId) {
                const currentSession = currentSessionIdRef.current[srvId];
                if (currentSession && data.sessionId !== currentSession) {
                  return;
                }
                currentSessionIdRef.current[srvId] = data.sessionId;
              }

              const item = data.entry ?? {
                text: data.line ?? data.text ?? data.data,
                type: data.logType,
                event: data.logEvent,
                timestamp: data.timestamp,
              };
              if (item !== undefined) {
                // Invalidate in-flight HTTP history since a newer live WS line was accepted for active server
                logFetchSeqRef.current++;

                setLogs((prev) => {
                  const lastLevel = prev.length > 0 ? prev[prev.length - 1].level : 'INFO';
                  const seqIdx = ++logSeqRef.current;
                  const parsed = parseLogLine(item, seqIdx, lastLevel);
                  if (!parsed) return prev;
                  return appendParsedLogEntry(prev, parsed, 500);
                });
              }
            } else if (data.type === 'console_history' || data.event === 'server_logs') {
              const srvId = data.serverId;
              if (srvId && srvId !== activeServerIdRef.current) {
                return;
              }
              if (srvId && data.sessionId) {
                currentSessionIdRef.current[srvId] = data.sessionId;
              }
              // Invalidate any in-flight HTTP history fetch since authoritative WS history is accepted
              logFetchSeqRef.current++;

              // Prefer structured logs (including empty array intentionally authoritative), then history, then legacy lines
              const lines = selectHistoryEntries(data);

              let parsedList: LogEntry[] = [];
              let currentLevel: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO';
              lines.forEach((item: any) => {
                const seqIdx = ++logSeqRef.current;
                const entry = parseLogLine(item, seqIdx, currentLevel);
                if (entry) {
                  currentLevel = entry.level;
                  parsedList = appendParsedLogEntry(parsedList, entry, 500);
                }
              });
              setLogs(parsedList);
            } else if (data.type === 'pong' || data.action === 'pong') {
              if (data.timestamp) {
                const rtt = Math.max(1, Math.round(Date.now() - data.timestamp));
                setMeasuredPing(rtt);
              }
            } else if (data.type === 'metrics_update') {
              if (data.host) setHostMetrics(data.host);
              if (data.servers) {
                setServerMetricsMap((prev) => ({ ...prev, ...data.servers }));
              }
            } else if (data.type === 'server_status' || data.event === 'server_status') {
              const status: ServerStatus = data.status || data.data?.status || 'offline';
              const srvId = data.serverId || data.id || data.data?.serverId;
              if (srvId) {
                setServers((prev) =>
                  prev.map((s) =>
                    s.id === srvId
                      ? {
                          ...s,
                          status,
                          runtime: s.runtime ? { ...s.runtime, status } : undefined,
                        }
                      : s
                  )
                );
              }
            }
          } catch {
            // raw text line fallback
            if (typeof event.data === 'string' && event.data.trim()) {
              setLogs((prev) => {
                const lastLevel = prev.length > 0 ? prev[prev.length - 1].level : 'INFO';
                const seqIdx = ++logSeqRef.current;
                const parsed = parseLogLine(event.data, seqIdx, lastLevel);
                if (!parsed) return prev;
                return appendParsedLogEntry(prev, parsed, 500);
              });
            }
          }
        };

        socket.onerror = () => {
          setIsConnected(false);
        };

        socket.onclose = (event: CloseEvent) => {
          setIsConnected(false);
          const isAuthClose =
            event.code === 4001 ||
            event.code === 4401 ||
            event.code === 4403 ||
            event.code === 1008;

          if (isAuthClose) {
            authFailed = true;
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            if (typeof window !== 'undefined') {
              clearStoredToken();
              window.dispatchEvent(new CustomEvent('session-expired'));
              window.dispatchEvent(new CustomEvent('mazipanel:unauthorized'));
            }
          }

          if (!isDisposed && !authFailed) {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectWebSocket, 3000);
          }
        };
      } catch {
        setIsConnected(false);
        if (!isDisposed && !authFailed) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectWebSocket, 3000);
        }
      }
    };

    connectWebSocket();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
      wsRef.current = null;
    };
  }, []);

  // Switch console subscription when selectedServerId changes
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!selectedServerId) return;

    if (activeSubscriptionRef.current && activeSubscriptionRef.current !== selectedServerId) {
      wsRef.current.send(
        JSON.stringify({
          type: 'unsubscribe_console',
          serverId: activeSubscriptionRef.current,
        })
      );
    }

    wsRef.current.send(
      JSON.stringify({
        type: 'subscribe_console',
        serverId: selectedServerId,
      })
    );
    activeSubscriptionRef.current = selectedServerId;
  }, [selectedServerId]);

  // Server-specific metrics computation
  const currentServerProc = selectedServerId ? serverMetricsMap[selectedServerId] : null;
  const procMetrics = currentServerProc?.metrics || currentServerProc;
  const procMemBytes = procMetrics?.memoryBytes || 0;
  const procMemMB = Math.round(procMemBytes / (1024 * 1024));
  const procMemGB = Number((procMemBytes / (1024 * 1024 * 1024)).toFixed(2));

  // Parse server allocated RAM (e.g. "1G", "1 GB", "2048M", etc.)
  const rawAllocated = selectedServer?.runtime?.allocatedFormatted || selectedServer?.ramAllocated || '2 GB';
  const allocatedRamStr = formatRam(rawAllocated);
  let allocatedRamGB = 2;
  const ramMatch = allocatedRamStr.match(/(\d+(?:\.\d+)?)\s*([GMK]B?)/i);
  if (ramMatch) {
    const val = parseFloat(ramMatch[1]);
    const unit = ramMatch[2].toUpperCase();
    if (unit.startsWith('G')) allocatedRamGB = val;
    else if (unit.startsWith('M')) allocatedRamGB = val / 1024;
  }

  const diskMaxGB = hostMetrics ? Number((hostMetrics.disk.totalBytes / 1024 / 1024 / 1024).toFixed(1)) : 220.6;
  const diskUsedGB = hostMetrics ? Number((hostMetrics.disk.usedBytes / 1024 / 1024 / 1024).toFixed(1)) : 52.0;

  const isServerOnline = selectedServer?.status === 'online';

  const metrics: ServerMetrics = {
    cpu: isServerOnline ? (procMetrics?.cpuPercent ?? hostMetrics?.cpu.usagePercent ?? 0) : 0,
    ramUsed: isServerOnline ? (procMemGB > 0 ? procMemGB : 0.4) : 0,
    ramMax: allocatedRamGB,
    memoryMB: isServerOnline ? (procMemMB > 0 ? procMemMB : 420) : 0,
    allocatedRam: formatRam(allocatedRamStr),
    diskUsed: diskUsedGB,
    diskMax: diskMaxGB,
    tps: isServerOnline ? 20.0 : 0.0,
    ping: isServerOnline ? measuredPing : 0,
    uptime: isServerOnline
      ? formatUptime(selectedServer?.runtime?.uptime || currentServerProc?.uptime || 0)
      : 'Sunucu Kapalı',
    onlinePlayers: players.length,
    maxPlayers: (selectedServer?.maxPlayers !== undefined && selectedServer?.maxPlayers !== null && !isNaN(selectedServer.maxPlayers))
      ? selectedServer.maxPlayers
      : 10,
    status: selectedServer?.status || 'offline',
    ip: window.location.hostname || '192.168.1.110',
    port: selectedServer?.port || 25565,
    version: selectedServer ? `${selectedServer.type} ${selectedServer.version}` : 'Purpur 26.3',
    coreType: selectedServer?.type || 'Purpur',
    cpuModel: hostMetrics?.cpu.model || 'AMD Ryzen 5 5500',
  };

  // Commands & Controls
  const sendCommand = useCallback(
    async (cmd: string) => {
      if (!cmd.trim() || !selectedServer) return;
      const trimmed = cmd.trim();

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'console_command',
            serverId: selectedServer.id,
            command: trimmed,
          })
        );
      } else {
        const now = new Date().toTimeString().slice(0, 8);
        setLogs((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            timestamp: now,
            level: 'INFO',
            message: `> ${trimmed}`,
            raw: `> ${trimmed}`,
            type: 'command' as any as LogType,
            event: 'command',
            isCommandEcho: true,
          },
        ]);
        await fetchWithAuth(`/api/servers/${selectedServer.id}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: trimmed }),
        });
      }
    },
    [selectedServer]
  );

  const scheduleFetchServers = useCallback((delay: number) => {
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer);
      fetchServers();
    }, delay);
    pendingTimersRef.current.add(timer);
  }, [fetchServers]);

  useEffect(() => {
    return () => {
      pendingTimersRef.current.forEach((t) => clearTimeout(t));
      pendingTimersRef.current.clear();
    };
  }, []);

  const startServer = useCallback(
    async (targetId?: string) => {
      const id = targetId || selectedServer?.id;
      if (!id) return;

      // Next-start resets console logs for active server
      if (id === activeServerIdRef.current) {
        logFetchSeqRef.current++;
        setLogs([]);
      }

      setServers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'starting' } : s))
      );
      try {
        await fetchWithAuth(`/api/servers/${id}/start`, { method: 'POST' });
        scheduleFetchServers(1500);
      } catch (err) {
        console.error('Server start failed:', err);
      }
    },
    [selectedServer?.id, scheduleFetchServers]
  );

  const stopServer = useCallback(
    async (targetId?: string) => {
      const id = targetId || selectedServer?.id;
      if (!id) return;
      setServers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'stopping' } : s))
      );
      try {
        await fetchWithAuth(`/api/servers/${id}/stop`, { method: 'POST' });
        scheduleFetchServers(1500);
      } catch (err) {
        console.error('Server stop failed:', err);
      }
    },
    [selectedServer?.id, scheduleFetchServers]
  );

  const restartServer = useCallback(
    async (targetId?: string) => {
      const id = targetId || selectedServer?.id;
      if (!id) return;
      setServers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'stopping' } : s))
      );
      try {
        await fetchWithAuth(`/api/servers/${id}/restart`, { method: 'POST' });
        scheduleFetchServers(2000);
      } catch (err) {
        console.error('Server restart failed:', err);
      }
    },
    [selectedServer?.id, scheduleFetchServers]
  );

  const killServer = useCallback(
    async (targetId?: string) => {
      const id = targetId || selectedServer?.id;
      if (!id) return;
      try {
        await fetchWithAuth(`/api/servers/${id}/kill`, { method: 'POST' });
        setServers((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: 'offline' } : s))
        );
        scheduleFetchServers(1000);
      } catch (err) {
        console.error('Server kill failed:', err);
      }
    },
    [selectedServer?.id, scheduleFetchServers]
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const kickPlayer = useCallback(
    async (username: string, reason?: string) => {
      if (!selectedServer) return;
      try {
        const body: { player: string; reason?: string } = { player: username };
        if (reason && reason.trim()) {
          body.reason = reason.trim();
        }
        await fetchWithAuth(`/api/servers/${selectedServer.id}/players/kick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setPlayers((prev) => prev.filter((p) => p.username !== username));
      } catch (err) {
        console.error('Kick failed:', err);
      }
    },
    [selectedServer]
  );

  const banPlayer = useCallback(
    async (username: string, reason?: string) => {
      if (!selectedServer) return;
      try {
        const body: { player: string; reason?: string } = { player: username };
        if (reason && reason.trim()) {
          body.reason = reason.trim();
        }
        await fetchWithAuth(`/api/servers/${selectedServer.id}/players/ban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setPlayers((prev) => prev.filter((p) => p.username !== username));
      } catch (err) {
        console.error('Ban failed:', err);
      }
    },
    [selectedServer]
  );

  const toggleOp = useCallback(
    async (username: string) => {
      if (!selectedServer) return;
      const target = players.find((p) => p.username === username);
      const isCurrentlyOp = target?.isOp;
      const endpoint = isCurrentlyOp ? 'deop' : 'op';
      try {
        await fetchWithAuth(`/api/servers/${selectedServer.id}/players/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player: username }),
        });
        setPlayers((prev) =>
          prev.map((p) => (p.username === username ? { ...p, isOp: !p.isOp } : p))
        );
      } catch (err) {
        console.error('Toggle OP failed:', err);
      }
    },
    [selectedServer, players]
  );

  const toggleWhitelist = useCallback(
    async (username: string) => {
      if (!selectedServer) return;
      const target = players.find((p) => p.username === username);
      const isCurrentlyWl = target?.isWhitelisted;
      const endpoint = isCurrentlyWl ? 'whitelist/remove' : 'whitelist/add';
      try {
        await fetchWithAuth(`/api/servers/${selectedServer.id}/players/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player: username }),
        });
        setPlayers((prev) =>
          prev.map((p) => (p.username === username ? { ...p, isWhitelisted: !p.isWhitelisted } : p))
        );
      } catch (err) {
        console.error('Toggle Whitelist failed:', err);
      }
    },
    [selectedServer, players]
  );

  const addServer = useCallback((newServer: ServerInstance) => {
    setServers((prev) => [newServer, ...prev]);
    setSelectedServerId(newServer.id);
  }, []);

  const selectServer = useCallback((server: ServerInstance | string) => {
    const id = typeof server === 'string' ? server : server.id;
    setSelectedServerId(id);
  }, []);

  const updateServerIcon = useCallback((serverId: string, iconUrl: string) => {
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, icon: iconUrl } : s))
    );
  }, []);

  return {
    servers,
    selectedServer,
    selectedServerId,
    selectServer,
    hostMetrics,
    metrics,
    logs,
    players,
    isConnected,
    isLoadingServers,
    sendCommand,
    startServer,
    stopServer,
    restartServer,
    killServer,
    clearLogs,
    kickPlayer,
    banPlayer,
    toggleOp,
    toggleWhitelist,
    addServer,
    updateServerIcon,
    fetchServers,
  };
}
