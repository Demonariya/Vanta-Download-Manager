import { CookieValidationResult } from '../types';

function validateCookieRow(
  row: string,
  lineNo: number,
  domains: Set<string>
): { error?: string; isSecure: boolean } {
  const cols = row.split('\t');
  if (cols.length !== 7) {
    return {
      isSecure: false,
      error: `Line ${lineNo}: expected 7 tab-separated Netscape fields, found ${cols.length}.`,
    };
  }

  const domain = cols[0].trim();
  const includeSubdomains = cols[1].trim().toUpperCase();
  const cookiePath = cols[2].trim();
  const secureFlag = cols[3].trim().toUpperCase();
  const expiration = cols[4].trim();
  const name = cols[5].trim();

  if (!domain || /\s/.test(domain)) {
    return { isSecure: false, error: `Line ${lineNo}: invalid cookie domain.` };
  }
  if (includeSubdomains !== 'TRUE' && includeSubdomains !== 'FALSE') {
    return { isSecure: false, error: `Line ${lineNo}: domain flag must be TRUE or FALSE.` };
  }
  if (!cookiePath || !cookiePath.startsWith('/')) {
    return { isSecure: false, error: `Line ${lineNo}: cookie path must start with '/'.` };
  }
  if (secureFlag !== 'TRUE' && secureFlag !== 'FALSE') {
    return { isSecure: false, error: `Line ${lineNo}: secure flag must be TRUE or FALSE.` };
  }
  if (!/^\d+$/.test(expiration)) {
    return {
      isSecure: false,
      error: `Line ${lineNo}: expiration must be a non-negative UNIX timestamp.`,
    };
  }
  if (!name) {
    return { isSecure: false, error: `Line ${lineNo}: cookie name must not be empty.` };
  }

  domains.add(domain.replace(/^\.+/, '').toLowerCase());
  return { isSecure: secureFlag === 'TRUE' };
}

/**
 * Validates a Netscape HTTP Cookie File without logging or returning secret cookie values.
 */
export function validateNetscapeCookies(content: string): CookieValidationResult {
  const errors: string[] = [];
  const domains = new Set<string>();
  let recordCount = 0;
  let httpOnlyCount = 0;
  let secureCount = 0;
  let hasNetscapeHeader = false;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('#HttpOnly_')) {
      httpOnlyCount += 1;
      const res = validateCookieRow(trimmed.slice('#HttpOnly_'.length), lineNo, domains);
      if (res.error) {
        if (errors.length < 5) errors.push(res.error);
      } else {
        recordCount += 1;
        if (res.isSecure) secureCount += 1;
      }
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.toLowerCase().includes('netscape http cookie file')) {
        hasNetscapeHeader = true;
      }
      continue;
    }

    const res = validateCookieRow(rawLine, lineNo, domains);
    if (res.error) {
      if (errors.length < 5) errors.push(res.error);
    } else {
      recordCount += 1;
      if (res.isSecure) secureCount += 1;
    }
  }

  if (recordCount === 0 && errors.length === 0) {
    errors.push(
      'No valid cookie entries found. Paste a Netscape cookies.txt export with tab-separated columns.'
    );
  }

  return {
    valid: errors.length === 0 && recordCount > 0,
    recordCount,
    domainCount: domains.size,
    httpOnlyCount,
    secureCount,
    hasNetscapeHeader,
    errors,
  };
}

export function normalizeNetscapeCookies(content: string): string {
  const trimmed = content.trim();
  const lines = trimmed.split(/\r?\n/);
  const hasHeader = lines[0]?.toLowerCase().includes('netscape http cookie file') ?? false;
  const out = hasHeader ? lines : ['# Netscape HTTP Cookie File', ...lines];
  return `${out.join('\n')}\n`;
}
