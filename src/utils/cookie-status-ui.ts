import { CookieStatus } from '../types';

export interface CookieUiBadge {
  label: string;
  badgeText: string;
  tone: 'success' | 'info' | 'warning' | 'error' | 'muted';
  detail: string;
}

export function describeCookieStatus(status: CookieStatus | null): CookieUiBadge {
  if (!status) {
    return {
      label: 'Cookie Authentication',
      badgeText: 'Checking...',
      tone: 'muted',
      detail: 'Checking configured cookie source and installed browsers.',
    };
  }

  if (status.error && status.activeSource === 'file') {
    return {
      label: 'Cookie Authentication',
      badgeText: 'File Error',
      tone: 'error',
      detail: status.error,
    };
  }

  if (status.activeSource === 'file' && status.fileValid) {
    return {
      label: 'Cookie Authentication',
      badgeText: `Imported File (${status.recordCount})`,
      tone: 'success',
      detail: `Using ${status.recordCount} validated cookie entries across ${status.domainCount} domain(s).`,
    };
  }

  if (status.activeSource === 'browser' && status.resolvedBrowser) {
    const profileSuffix = status.resolvedProfile ? ` · ${status.resolvedProfile}` : '';
    return {
      label: 'Cookie Authentication',
      badgeText: `Browser: ${status.resolvedBrowser}`,
      tone: 'info',
      detail: `Extracting browser cookies from ${status.resolvedBrowser}${profileSuffix}.`,
    };
  }

  if (status.activeSource === 'auto' && status.resolvedBrowser) {
    const profileSuffix = status.resolvedProfile ? ` · ${status.resolvedProfile}` : '';
    return {
      label: 'Cookie Authentication',
      badgeText: `Auto (${status.resolvedBrowser})`,
      tone: 'success',
      detail: `Auto-detected ${status.resolvedBrowser}${profileSuffix} cookie store.`,
    };
  }

  if (status.configuredBrowser === 'auto') {
    return {
      label: 'Cookie Authentication',
      badgeText: 'No Browser Found',
      tone: 'warning',
      detail: 'No supported browser profile detected. Import cookies.txt if authentication is required.',
    };
  }

  return {
    label: 'Cookie Authentication',
    badgeText: 'Disabled',
    tone: 'muted',
    detail: 'Cookie extraction is disabled ("none"). Public unauthenticated requests only.',
  };
}
