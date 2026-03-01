import { randomBytes } from 'node:crypto';
import type { SenderEntryKind } from './sender_list.js';

export interface SampleMessage {
  id: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
}

export interface PlanEntryPreview {
  index: number;
  raw_line: string;
  kind: SenderEntryKind;
  normalized_query: string;
  estimate: number;
  estimate_display: string;
  samples: SampleMessage[];
  unsubscribe: {
    listUnsubscribe: string[];
    oneClick: boolean;
  };
}

export interface CleanupPlan {
  planId: string;
  confirmPhrase: string;
  createdAt: string;
  expiresAt: string;
  configHash: string;
  entries: PlanEntryPreview[];
}

export class PlanStore {
  private plans = new Map<string, CleanupPlan>();

  createPlan(params: {
    configHash: string;
    ttlSeconds: number;
    entries: PlanEntryPreview[];
  }): CleanupPlan {
    this.evictExpired();

    const planId = randomId('plan');
    const confirmToken = randomId('confirm');
    const confirmPhrase = `CONFIRM TRASH ${planId} ${confirmToken}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + params.ttlSeconds * 1000);

    const plan: CleanupPlan = {
      planId,
      confirmPhrase,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      configHash: params.configHash,
      entries: params.entries,
    };

    this.plans.set(planId, plan);
    return plan;
  }

  getPlan(planId: string): CleanupPlan {
    this.evictExpired();
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Unknown or expired planId: ${planId}`);
    }
    return plan;
  }

  deletePlan(planId: string): void {
    this.plans.delete(planId);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, plan] of this.plans.entries()) {
      const expires = Date.parse(plan.expiresAt);
      if (Number.isNaN(expires)) {
        this.plans.delete(id);
        continue;
      }
      if (expires <= now) {
        this.plans.delete(id);
      }
    }
  }
}

function randomId(prefix: string): string {
  const buf = randomBytes(12);
  return `${prefix}_${buf.toString('hex')}`;
}
