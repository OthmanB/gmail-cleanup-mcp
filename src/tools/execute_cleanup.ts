import { z } from 'zod';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { GmailClient } from '../gmail/gmail_client.js';
import type { PlanStore } from '../plan_store.js';
import { extractUnsubscribeInfo } from '../unsubscribe.js';
import { executeUnsubscribePlan } from './unsubscribe_executor.js';

export const ExecuteCleanupInputSchema = z
  .object({
    planId: z.string().min(1),
    confirmPhrase: z.string().min(1),
    entryIndices: z.array(z.number().int().nonnegative()).optional(),
    maxMessages: z.number().int().positive().optional(),
    perEntryMaxMessages: z.number().int().positive().optional(),
  })
  .strict();

export type ExecuteCleanupInput = z.infer<typeof ExecuteCleanupInputSchema>;

export interface ExecuteCleanupResult {
  planId: string;
  mode: 'trash';
  totals: {
    trashed: number;
  };
  entries: Array<{
    index: number;
    raw_line: string;
    normalized_query: string;
    estimate: number;
    estimate_display: string;
    trashed: number;
    capped: boolean;
    unsubscribe: {
      http: {
        attempted: number;
        succeeded: number;
        skipped: number;
        failed: number;
      };
      mailto: {
        attempted: number;
        succeeded: number;
        skipped: number;
        failed: number;
      };
      manualRequired: Array<{
        url: string;
        reason: string;
      }>;
      links: string[];
    };
  }>;
  unsubscribeTotals: {
    http: {
      attempted: number;
      succeeded: number;
      skipped: number;
      failed: number;
    };
    mailto: {
      attempted: number;
      succeeded: number;
      skipped: number;
      failed: number;
    };
    manualRequired: number;
  };
}

export async function executeCleanup(params: {
  input: ExecuteCleanupInput;
  config: AppConfig;
  configHash: string;
  logger: Logger;
  gmail: GmailClient;
  planStore: PlanStore;
}): Promise<ExecuteCleanupResult> {
  const { input, config, logger } = params;

  if (config.cleanup.mode !== 'trash') {
    throw new Error(`Unsupported cleanup mode in config: ${config.cleanup.mode}`);
  }

  const plan = params.planStore.getPlan(input.planId);
  if (plan.configHash !== params.configHash) {
    throw new Error(
      `Plan was created under a different config (config changed). Re-run preview. plan.configHash=${plan.configHash} current.configHash=${params.configHash}`
    );
  }

  if (input.confirmPhrase !== plan.confirmPhrase) {
    throw new Error('Confirmation phrase does not match the preview plan');
  }

  if (input.maxMessages !== undefined && input.maxMessages > config.cleanup.global_max_messages) {
    throw new Error(
      `maxMessages exceeds config global_max_messages. maxMessages=${input.maxMessages} global_max_messages=${config.cleanup.global_max_messages}`
    );
  }
  if (
    input.perEntryMaxMessages !== undefined &&
    input.perEntryMaxMessages > config.cleanup.per_entry_max_messages
  ) {
    throw new Error(
      `perEntryMaxMessages exceeds config per_entry_max_messages. perEntryMaxMessages=${input.perEntryMaxMessages} per_entry_max_messages=${config.cleanup.per_entry_max_messages}`
    );
  }

  const globalMax = input.maxMessages ?? config.cleanup.global_max_messages;
  const perEntryMax = input.perEntryMaxMessages ?? config.cleanup.per_entry_max_messages;

  const selected = selectEntries(plan.entries, input.entryIndices);

  let remaining = globalMax;
  let totalTrashed = 0;
  let unsubscribeHttpAttempted = 0;
  let unsubscribeHttpSucceeded = 0;
  let unsubscribeHttpSkipped = 0;
  let unsubscribeHttpFailed = 0;
  let unsubscribeMailtoAttempted = 0;
  let unsubscribeMailtoSucceeded = 0;
  let unsubscribeMailtoSkipped = 0;
  let unsubscribeMailtoFailed = 0;
  let unsubscribeManualRequired = 0;
  let remainingMailtoBudget = config.unsubscribe.mailto.max_sends_per_run;

  const entryResults: ExecuteCleanupResult['entries'] = [];

  for (const entry of selected) {
    if (remaining <= 0) break;
    const effectiveCap = Math.min(perEntryMax, remaining);
    const capped = entry.estimate > effectiveCap;

    logger.info(
      { op: 'execute.entry.start', index: entry.index, cap: effectiveCap },
      'Executing cleanup entry'
    );

    const { ids } = await params.gmail.listMessageIds({
      query: entry.normalized_query,
      maxResults: effectiveCap,
    });

    const unsubscribeLinksAndHint = await collectUnsubscribeLinksForEntry({
      entryUnsubscribeLinks: entry.unsubscribe.listUnsubscribe,
      entryOneClickHint: entry.unsubscribe.oneClick,
      ids,
      gmail: params.gmail,
      config,
    });

    const unsubscribeResult = await executeUnsubscribePlan({
      plan: {
        links: unsubscribeLinksAndHint.links,
        oneClickHint: unsubscribeLinksAndHint.oneClickHint,
      },
      config,
      logger,
      gmail: params.gmail,
      mailtoGlobalRemaining: remainingMailtoBudget,
    });
    remainingMailtoBudget = Math.max(0, remainingMailtoBudget - unsubscribeResult.mailto.attempted);

    let trashed = 0;
    for (const chunk of chunked(ids, config.cleanup.batch_size)) {
      await params.gmail.trashMessages({ ids: chunk });
      trashed += chunk.length;
    }

    remaining -= trashed;
    totalTrashed += trashed;

    unsubscribeHttpAttempted += unsubscribeResult.http.attempted;
    unsubscribeHttpSucceeded += unsubscribeResult.http.succeeded;
    unsubscribeHttpSkipped += unsubscribeResult.http.skipped;
    unsubscribeHttpFailed += unsubscribeResult.http.failed;

    unsubscribeMailtoAttempted += unsubscribeResult.mailto.attempted;
    unsubscribeMailtoSucceeded += unsubscribeResult.mailto.succeeded;
    unsubscribeMailtoSkipped += unsubscribeResult.mailto.skipped;
    unsubscribeMailtoFailed += unsubscribeResult.mailto.failed;

    unsubscribeManualRequired += unsubscribeResult.manualRequired.length;

    entryResults.push({
      index: entry.index,
      raw_line: entry.raw_line,
      normalized_query: entry.normalized_query,
      estimate: entry.estimate,
      estimate_display: entry.estimate_display,
      trashed,
      capped,
      unsubscribe: {
        http: unsubscribeResult.http,
        mailto: unsubscribeResult.mailto,
        manualRequired: unsubscribeResult.manualRequired,
        links: unsubscribeLinksAndHint.links,
      },
    });
  }

  // Invalidate plan after execution.
  params.planStore.deletePlan(plan.planId);

  return {
    planId: plan.planId,
    mode: 'trash',
    totals: { trashed: totalTrashed },
    entries: entryResults,
    unsubscribeTotals: {
      http: {
        attempted: unsubscribeHttpAttempted,
        succeeded: unsubscribeHttpSucceeded,
        skipped: unsubscribeHttpSkipped,
        failed: unsubscribeHttpFailed,
      },
      mailto: {
        attempted: unsubscribeMailtoAttempted,
        succeeded: unsubscribeMailtoSucceeded,
        skipped: unsubscribeMailtoSkipped,
        failed: unsubscribeMailtoFailed,
      },
      manualRequired: unsubscribeManualRequired,
    },
  };
}

function selectEntries<T extends { index: number }>(entries: T[], indices?: number[]): T[] {
  if (!indices || indices.length === 0) return entries;
  const set = new Set(indices);
  const out = entries.filter((e) => set.has(e.index));
  if (out.length === 0) {
    throw new Error(`entryIndices did not match any entries in the plan: ${indices.join(',')}`);
  }
  return out;
}

function chunked<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`Invalid chunk size: ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function collectUnsubscribeLinksForEntry(params: {
  entryUnsubscribeLinks: string[];
  entryOneClickHint: boolean;
  ids: string[];
  gmail: GmailClient;
  config: AppConfig;
}): Promise<{ links: string[]; oneClickHint: boolean }> {
  const links = new Set<string>();
  let oneClickHint = params.entryOneClickHint;

  for (const link of params.entryUnsubscribeLinks) {
    if (links.size >= params.config.unsubscribe.max_links_per_entry) break;
    links.add(link);
  }

  const probeCount = Math.min(params.ids.length, params.config.cleanup.unsubscribe_probe_messages);
  const probeIds = params.ids.slice(0, probeCount);

  for (const id of probeIds) {
    if (links.size >= params.config.unsubscribe.max_links_per_entry) break;

    const meta = await params.gmail.getMessageMetadata({
      id,
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
    });
    const parsed = extractUnsubscribeInfo({ headers: meta.headers });
    oneClickHint = oneClickHint || parsed.oneClick;
    for (const link of parsed.listUnsubscribe) {
      if (links.size >= params.config.unsubscribe.max_links_per_entry) break;
      links.add(link);
    }
  }

  return {
    links: Array.from(links),
    oneClickHint,
  };
}
