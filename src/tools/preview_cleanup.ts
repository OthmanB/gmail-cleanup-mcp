import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { resolveAndValidatePathInRoots } from '../path_security.js';
import { parseSenderList, readSenderListFile } from '../sender_list.js';
import type { GmailClient } from '../gmail/gmail_client.js';
import { extractUnsubscribeInfo } from '../unsubscribe.js';
import type { PlanEntryPreview, PlanStore } from '../plan_store.js';

export const PreviewCleanupInputSchema = z
  .object({
    filePath: z.string().min(1).optional(),
    listText: z.string().min(1).optional(),
    samplePerEntry: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => (v.filePath ? 1 : 0) + (v.listText ? 1 : 0) === 1, {
    message: 'Provide exactly one of filePath or listText',
  });

export type PreviewCleanupInput = z.infer<typeof PreviewCleanupInputSchema>;

export async function previewCleanup(params: {
  input: PreviewCleanupInput;
  config: AppConfig;
  configHash: string;
  logger: Logger;
  gmail: GmailClient;
  planStore: PlanStore;
}): Promise<{
  planId: string;
  confirmPhrase: string;
  expiresAt: string;
  entryCount: number;
  entries: PlanEntryPreview[];
}> {
  const { input, config, logger } = params;

  const listText = await loadListText({ input, config });
  if (Buffer.byteLength(listText, 'utf8') > config.cleanup.max_list_bytes) {
    throw new Error(
      `Sender list is too large. bytes=${Buffer.byteLength(listText, 'utf8')} max_list_bytes=${config.cleanup.max_list_bytes}`
    );
  }

  const senderEntries = parseSenderList({
    listText,
    defaultQuerySuffix: config.cleanup.default_query_suffix,
  });

  if (senderEntries.length === 0) {
    throw new Error('Sender list produced no entries (empty file or only comments)');
  }

  if (senderEntries.length > config.cleanup.max_entries) {
    throw new Error(
      `Too many entries in sender list. count=${senderEntries.length} max_entries=${config.cleanup.max_entries}`
    );
  }

  const samplePerEntry = input.samplePerEntry ?? config.cleanup.sample_per_entry;
  if (samplePerEntry > config.cleanup.per_entry_max_messages) {
    throw new Error(
      `samplePerEntry exceeds per_entry_max_messages. samplePerEntry=${samplePerEntry} per_entry_max_messages=${config.cleanup.per_entry_max_messages}`
    );
  }

  const previews: PlanEntryPreview[] = [];

  for (const entry of senderEntries) {
    logger.info(
      { op: 'preview.entry.start', index: entry.index, kind: entry.kind },
      'Previewing sender entry'
    );

    const { ids, estimate } = await params.gmail.listMessageIds({
      query: entry.normalized_query,
      maxResults: samplePerEntry,
    });

    const samples = [] as PlanEntryPreview['samples'];
    const unsubLinks = new Set<string>();
    let oneClick = false;

    for (const id of ids) {
      const meta = await params.gmail.getMessageMetadata({
        id,
        metadataHeaders: config.output.metadata_headers,
      });

      const from = findHeader(meta.headers, 'From');
      const subject = findHeader(meta.headers, 'Subject');
      const date = findHeader(meta.headers, 'Date');
      const snippet = meta.snippet ? meta.snippet.slice(0, config.output.snippet_max_length) : null;

      const unsub = extractUnsubscribeInfo({ headers: meta.headers });
      for (const u of unsub.listUnsubscribe) {
        if (unsubLinks.size >= config.output.max_unsubscribe_links_per_entry) break;
        unsubLinks.add(u);
      }
      oneClick = oneClick || unsub.oneClick;

      samples.push({
        id: meta.id,
        from: from ?? null,
        subject: subject ?? null,
        date: date ?? null,
        snippet,
      });
    }

    previews.push({
      index: entry.index,
      raw_line: entry.raw_line,
      kind: entry.kind,
      normalized_query: entry.normalized_query,
      estimate,
      estimate_display: formatEstimateDisplay(estimate),
      samples,
      unsubscribe: {
        listUnsubscribe: Array.from(unsubLinks),
        oneClick,
      },
    });
  }

  const plan = params.planStore.createPlan({
    configHash: params.configHash,
    ttlSeconds: config.cleanup.plan_ttl_seconds,
    entries: previews,
  });

  return {
    planId: plan.planId,
    confirmPhrase: plan.confirmPhrase,
    expiresAt: plan.expiresAt,
    entryCount: plan.entries.length,
    entries: plan.entries,
  };
}

async function loadListText(params: {
  input: PreviewCleanupInput;
  config: AppConfig;
}): Promise<string> {
  if (params.input.listText) return params.input.listText;
  if (!params.input.filePath) {
    throw new Error('Provide exactly one of filePath or listText');
  }

  const realAllowedPath = await resolveAndValidatePathInRoots({
    inputPath: params.input.filePath,
    allowedRoots: params.config.paths.allowed_list_roots,
  });

  const stat = await fs.stat(realAllowedPath);
  if (!stat.isFile()) {
    throw new Error(`sender list path is not a file: ${realAllowedPath}`);
  }

  return readSenderListFile(realAllowedPath);
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function formatEstimateDisplay(estimate: number): string {
  if (estimate >= 201) return '>200';
  return String(estimate);
}
