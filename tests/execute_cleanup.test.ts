import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCleanup } from '../src/tools/execute_cleanup.js';
import { PlanStore, type PlanEntryPreview } from '../src/plan_store.js';

const baseConfig = {
  config_version: 1,
  oauth: {
    client_file_path: '/tmp/client.json',
    token_file_path: '/tmp/token.json',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
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
  output: {
    metadata_headers: ['From', 'Subject', 'Date'],
    snippet_max_length: 200,
    max_unsubscribe_links_per_entry: 4,
  },
  unsubscribe: {
    enabled: true,
    max_links_per_entry: 4,
    request_timeout_ms: 1000,
    user_agent: 'test-agent',
    mailto: {
      enabled: true,
      max_sends_per_entry: 2,
      max_sends_per_run: 5,
      subject_fallback: 'unsubscribe',
      body_fallback: 'Please unsubscribe.',
      skip_if_http_succeeded: true,
      validate_recipient_domain_dns: false,
    },
    http: {
      allow_http: false,
      one_click_post_body: 'List-Unsubscribe=One-Click',
    },
  },
  logging: { level: 'info' as const },
};

test('executeCleanup enforces confirm phrase and caps', async () => {
  const planStore = new PlanStore();
  const entries: PlanEntryPreview[] = [
    {
      index: 0,
      raw_line: 'newsletter@example.com',
      kind: 'email',
      normalized_query: 'from:newsletter@example.com -in:trash -in:spam',
      estimate: 10,
      estimate_display: '10',
      samples: [],
      unsubscribe: { listUnsubscribe: [], oneClick: false },
    },
  ];

  const plan = planStore.createPlan({
    configHash: 'cfg-hash',
    ttlSeconds: 3600,
    entries,
  });

  const calls: { list: number; trash: number } = { list: 0, trash: 0 };
  const gmail = {
    async listMessageIds(_params: { query: string; maxResults: number }) {
      calls.list += 1;
      return { ids: ['a', 'b', 'c'], estimate: 10 };
    },
    async getMessageMetadata(_params: { id: string; metadataHeaders: string[] }) {
      return { id: 'x', threadId: null, snippet: null, headers: {} };
    },
    async trashMessages(params: { ids: string[] }) {
      calls.trash += params.ids.length;
    },
    async sendEmail() {
      return 'msg-1';
    },
  };

  const logger = {
    info() {},
  };

  const result = await executeCleanup({
    input: {
      planId: plan.planId,
      confirmPhrase: plan.confirmPhrase,
      maxMessages: 3,
      perEntryMaxMessages: 3,
    },
    config: baseConfig,
    configHash: 'cfg-hash',
    logger: logger as any,
    gmail: gmail as any,
    planStore,
  });

  assert.equal(calls.list, 1);
  assert.equal(calls.trash, 3);
  assert.equal(result.totals.trashed, 3);
  assert.equal(result.entries[0]?.trashed, 3);
});

test('executeCleanup rejects wrong confirmation phrase', async () => {
  const planStore = new PlanStore();
  const plan = planStore.createPlan({
    configHash: 'cfg-hash',
    ttlSeconds: 3600,
    entries: [
      {
        index: 0,
        raw_line: 'x@example.com',
        kind: 'email',
        normalized_query: 'from:x@example.com -in:trash -in:spam',
        estimate: 1,
        estimate_display: '1',
        samples: [],
        unsubscribe: { listUnsubscribe: [], oneClick: false },
      },
    ],
  });

  await assert.rejects(
    executeCleanup({
      input: {
        planId: plan.planId,
        confirmPhrase: 'WRONG',
      },
      config: baseConfig,
      configHash: 'cfg-hash',
      logger: { info() {} } as any,
      gmail: {
        async listMessageIds() {
          return { ids: [], estimate: 0 };
        },
        async getMessageMetadata() {
          return { id: 'x', threadId: null, snippet: null, headers: {} };
        },
        async trashMessages() {},
        async sendEmail() {
          return 'msg-1';
        },
      } as any,
      planStore,
    }),
    /Confirmation phrase does not match/
  );
});
