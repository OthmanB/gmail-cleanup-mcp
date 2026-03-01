export interface UnsubscribeInfo {
  listUnsubscribe: string[];
  oneClick: boolean;
}

export function extractUnsubscribeInfo(params: {
  headers: Record<string, string>;
}): UnsubscribeInfo {
  const listUnsub = findHeaderValue(params.headers, 'List-Unsubscribe');
  const listUnsubPost = findHeaderValue(params.headers, 'List-Unsubscribe-Post');

  const listUnsubscribe = listUnsub ? parseListUnsubscribe(listUnsub) : [];
  const oneClick = listUnsubPost
    ? /list-unsubscribe\s*=\s*one-click/i.test(listUnsubPost)
    : false;

  return { listUnsubscribe, oneClick };
}

function findHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  // Gmail API returns headers with original case; do a case-insensitive lookup.
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function parseListUnsubscribe(value: string): string[] {
  const urls: string[] = [];
  const re = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const u = match[1]?.trim();
    if (u) urls.push(u);
  }

  if (urls.length > 0) return dedupe(urls);

  // Fallback: split on commas.
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return dedupe(parts);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
