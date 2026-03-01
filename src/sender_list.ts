import fs from 'node:fs/promises';

export type SenderEntryKind = 'raw_query' | 'email' | 'domain' | 'name';

export interface SenderEntry {
  index: number;
  raw_line: string;
  kind: SenderEntryKind;
  normalized_query: string;
}

export interface ParseSenderListParams {
  listText: string;
  defaultQuerySuffix: string;
}

export function parseSenderList(params: ParseSenderListParams): SenderEntry[] {
  const lines = params.listText.split(/\r?\n/);
  const entries: SenderEntry[] = [];

  for (const rawLine of lines) {
    const withoutInlineComment = stripInlineComment(rawLine);
    const line = withoutInlineComment.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;

    const { kind, baseQuery } = normalizeLineToBaseQuery(line);
    const normalized_query = appendSuffix(baseQuery, params.defaultQuerySuffix);

    entries.push({
      index: entries.length,
      raw_line: line,
      kind,
      normalized_query,
    });
  }

  return entries;
}

export async function readSenderListFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function stripInlineComment(line: string): string {
  // Treat a # as a comment start only when it is preceded by whitespace.
  const match = line.match(/\s#/);
  if (!match || match.index === undefined) return line;
  return line.slice(0, match.index).trimEnd();
}

function appendSuffix(baseQuery: string, suffix: string): string {
  const s = suffix.trim();
  if (s.length === 0) return baseQuery;
  return `${baseQuery} ${s}`;
}

function normalizeLineToBaseQuery(line: string): { kind: SenderEntryKind; baseQuery: string } {
  // Raw Gmail query: starts with an operator like from:/subject:/has:/in:/etc.
  if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) {
    return { kind: 'raw_query', baseQuery: line };
  }

  if (looksLikeEmail(line)) {
    return { kind: 'email', baseQuery: `from:${line}` };
  }

  const domain = normalizeDomainToken(line);
  if (domain) {
    return { kind: 'domain', baseQuery: `from:${domain}` };
  }

  // Fallback: treat as display-name/substring match.
  return { kind: 'name', baseQuery: `from:"${escapeForQuotedTerm(line)}"` };
}

function looksLikeEmail(token: string): boolean {
  // Conservative check; Gmail query still does substring matching.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token);
}

function normalizeDomainToken(token: string): string | null {
  const t = token.startsWith('@') ? token.slice(1) : token;
  if (t.length === 0) return null;
  if (t.includes(' ')) return null;
  // Simple domain-ish heuristic.
  if (!t.includes('.')) return null;
  if (/[^A-Za-z0-9.-]/.test(t)) return null;
  return t;
}

function escapeForQuotedTerm(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
}
