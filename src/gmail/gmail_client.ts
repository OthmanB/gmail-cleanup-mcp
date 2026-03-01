import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Logger } from 'pino';
import { withRetries, type RetryConfig } from '../util/retry.js';

export interface GmailClientConfig {
  userId: string;
  retry: RetryConfig;
}

export interface MessageMetadata {
  id: string;
  threadId: string | null;
  snippet: string | null;
  headers: Record<string, string>;
}

export class GmailClient {
  private gmail: gmail_v1.Gmail;

  constructor(
    auth: OAuth2Client,
    private cfg: GmailClientConfig,
    private logger: Logger
  ) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async listMessageIds(params: {
    query: string;
    maxResults: number;
  }): Promise<{ ids: string[]; estimate: number }>{
    const ids: string[] = [];
    let pageToken: string | undefined;
    let estimate = 0;

    while (ids.length < params.maxResults) {
      const pageSize = Math.min(500, params.maxResults - ids.length);
      const res = await withRetries(
        async () =>
          this.gmail.users.messages.list({
            userId: this.cfg.userId,
            q: params.query,
            maxResults: pageSize,
            pageToken,
            includeSpamTrash: false,
          }),
        this.cfg.retry,
        { operation: 'gmail.users.messages.list' },
        isRetryableGoogleApiError
      );

      estimate = res.data.resultSizeEstimate ?? estimate;
      const msgs = res.data.messages ?? [];
      for (const m of msgs) {
        if (m.id) ids.push(m.id);
      }

      const next = res.data.nextPageToken ?? undefined;
      if (!next) break;
      pageToken = next;
    }

    this.logger.debug(
      { op: 'gmail.listMessageIds', query: params.query, count: ids.length, estimate },
      'Listed message ids'
    );

    return { ids, estimate };
  }

  async getMessageMetadata(params: {
    id: string;
    metadataHeaders: string[];
  }): Promise<MessageMetadata> {
    const res = await withRetries(
      async () =>
        this.gmail.users.messages.get({
          userId: this.cfg.userId,
          id: params.id,
          format: 'metadata',
          metadataHeaders: params.metadataHeaders,
        }),
      this.cfg.retry,
      { operation: 'gmail.users.messages.get' },
      isRetryableGoogleApiError
    );

    const headersList = res.data.payload?.headers ?? [];
    const headers: Record<string, string> = {};
    for (const h of headersList) {
      if (!h.name) continue;
      if (h.value === undefined || h.value === null) continue;
      headers[h.name] = h.value;
    }

    return {
      id: res.data.id ?? params.id,
      threadId: res.data.threadId ?? null,
      snippet: res.data.snippet ?? null,
      headers,
    };
  }

  async trashMessages(params: { ids: string[] }): Promise<void> {
    if (params.ids.length === 0) return;
    await withRetries(
      async () =>
        this.gmail.users.messages.batchModify({
          userId: this.cfg.userId,
          requestBody: {
            ids: params.ids,
            addLabelIds: ['TRASH'],
          },
        }),
      this.cfg.retry,
      { operation: 'gmail.users.messages.batchModify(addLabelIds=TRASH)' },
      isRetryableGoogleApiError
    );
  }

  async sendEmail(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
  }): Promise<string> {
    if (params.to.length === 0) {
      throw new Error('sendEmail requires at least one recipient');
    }

    const raw = buildRawMessage(params);
    const rawBase64Url = toBase64Url(raw);

    const res = await withRetries(
      async () =>
        this.gmail.users.messages.send({
          userId: this.cfg.userId,
          requestBody: {
            raw: rawBase64Url,
          },
        }),
      this.cfg.retry,
      { operation: 'gmail.users.messages.send' },
      isRetryableGoogleApiError
    );

    return res.data.id ?? '';
  }
}

function buildRawMessage(params: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${params.to.join(', ')}`);
  if (params.cc && params.cc.length > 0) {
    lines.push(`Cc: ${params.cc.join(', ')}`);
  }
  if (params.bcc && params.bcc.length > 0) {
    lines.push(`Bcc: ${params.bcc.join(', ')}`);
  }
  lines.push(`Subject: ${sanitizeHeader(params.subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(params.body);
  return lines.join('\r\n');
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isRetryableGoogleApiError(err: unknown): boolean {
  const anyErr = err as any;
  const status: number | undefined = anyErr?.code ?? anyErr?.response?.status;
  if (!status) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}
