import { TabType } from '../types';

export interface ParsedRoute {
  serverId?: string;
  tab?: TabType;
  filePath?: string;
}

export function parseRoute(pathname: string): ParsedRoute {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  if (!clean) return {};
  const segments = clean.split('/');
  const first = segments[0];

  if (first === 'servers') return { tab: 'servers' };
  if (first === 'system') return { tab: 'system' };
  if (first === 'integrations') return { tab: 'integrations' };
  if (first === 'p2p') return { tab: 'p2p' };
  if (first === 'settings') return { tab: 'settings' };

  const serverId = first;
  let sub = segments[1] || 'console';
  if (sub === 'settings') sub = 'server_settings';
  if (sub === 'dashboard') sub = 'console';

  const validTabs: TabType[] = [
    'console',
    'logs',
    'files',
    'players',
    'backups',
    'server_settings',
    'settings',
    'servers',
    'system',
    'integrations',
    'p2p'
  ];

  const tab = (validTabs.includes(sub as TabType) ? sub : 'console') as TabType;
  let filePath: string | undefined = undefined;
  if (tab === 'files' && segments.length > 2) {
    filePath = segments
      .slice(2)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join('/');
  }
  return { serverId, tab, filePath };
}

export function buildPath(tab: TabType, serverId?: string, filePath?: string): string {
  if (tab === 'servers') return '/servers';
  if (tab === 'system') return '/system';
  if (tab === 'integrations') return '/integrations';
  if (tab === 'p2p') return '/p2p';
  if (tab === 'settings') {
    return serverId ? `/${serverId}/settings` : '/settings';
  }
  if (tab === 'server_settings') {
    return serverId ? `/${serverId}/settings` : '/servers';
  }
  if (serverId) {
    if (tab === 'files') {
      if (filePath) {
        const encoded = filePath
          .split('/')
          .filter(Boolean)
          .map((s) => encodeURIComponent(s))
          .join('/');
        return encoded ? `/${serverId}/files/${encoded}` : `/${serverId}/files`;
      }
      return `/${serverId}/files`;
    }
    return `/${serverId}/${tab === 'dashboard' ? 'console' : tab}`;
  }
  return '/servers';
}
