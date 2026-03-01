import test from 'node:test';
import assert from 'node:assert/strict';
import { executeUnsubscribePlan } from '../src/tools/unsubscribe_executor.js';

const config = {
  config_version: 1,
  oauth: {
    client_file_path: '/tmp/client.json',
    token_file_path: '/tmp/token.json',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  gmail: { user_id: 'me' },
  paths: { allowed_list_roots: ['/tmp'] },
  cleanup: {
    mode: 'trash' as const,
    default_query_suffix: '-in:trash -in:spam',
    max_entries: 100,
    max_list_bytes: 10000,
    unsubscribe_probe_messages: 2,
    global_max_messages: 100,
    per_entry_max_messages: 50,
    sample_per_entry: 3,
    batch_size: 2,
    plan_ttl_seconds: 3600,
    rate_limit: {
      min_delay_ms: 0,
      max_retries: 0,
      backoff_base_ms: 1,
      backoff_max_ms: 1,
    },
  },
  unsubscribe: {
    enabled: true,
    max_links_per_entry: 10,
    request_timeout_ms: 1000,
    user_agent: 'test-agent',
    mailto: {
      enabled: true,
      max_sends_per_entry: 3,
      max_sends_per_run: 3,
      subject_fallback: 'unsubscribe',
      body_fallback: 'Please unsubscribe.',
      skip_if_http_succeeded: false,
      validate_recipient_domain_dns: false,
    },
    http: {
      allow_http: false,
      one_click_post_body: 'List-Unsubscribe=One-Click',
    },
  },
  output: {
    metadata_headers: ['From', 'Subject', 'Date'],
    snippet_max_length: 200,
    max_unsubscribe_links_per_entry: 4,
  },
  logging: { level: 'info' as const },
};

test('executeUnsubscribePlan sends mailto and flags manual GET confirmation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const sent: Array<{ to: string[]; subject: string; body: string }> = [];
  const gmail = {
    async sendEmail(params: { to: string[]; subject: string; body: string }) {
      sent.push({ to: params.to, subject: params.subject, body: params.body });
      return 'id-1';
    },
  };

  try {
    const result = await executeUnsubscribePlan({
      plan: {
        links: [
          'mailto:list@example.com?subject=unsubscribe&body=remove%20me',
          'https://example.com/unsubscribe?id=1',
        ],
        oneClickHint: false,
      },
      config: config as any,
      logger: { info() {} } as any,
      gmail: gmail as any,
      mailtoGlobalRemaining: 2,
    });

    assert.equal(result.mailto.attempted, 1);
    assert.equal(result.mailto.succeeded, 1);
    assert.equal(sent.length, 1);
    assert.equal(result.http.attempted, 1);
    assert.equal(result.manualRequired.length, 1);
    assert.match(result.manualRequired[0]!.reason, /manual_confirmation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
