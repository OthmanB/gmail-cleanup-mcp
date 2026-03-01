export interface ParsedMailto {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
}

export function parseMailtoLink(link: string): ParsedMailto | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }

  if (url.protocol.toLowerCase() !== 'mailto:') return null;

  const toFromPath = decodeURIComponent(url.pathname || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const toFromQuery = splitEmails(url.searchParams.get('to'));
  const to = dedupeEmails([...toFromPath, ...toFromQuery]);

  const cc = dedupeEmails(splitEmails(url.searchParams.get('cc')));
  const bcc = dedupeEmails(splitEmails(url.searchParams.get('bcc')));
  const subject = normalizeOptionalValue(url.searchParams.get('subject'));
  const body = normalizeOptionalValue(url.searchParams.get('body'));

  if (to.length === 0) return null;

  return { to, cc, bcc, subject, body };
}

function splitEmails(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function dedupeEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = value.trim();
    if (!isLikelyEmail(email)) continue;
    const normalized = email.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(email);
  }
  return out;
}

function normalizeOptionalValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
