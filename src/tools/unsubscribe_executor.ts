import type { Logger } from 'pino';
import dns from 'node:dns/promises';
import type { AppConfig } from '../config.js';
import type { GmailClient } from '../gmail/gmail_client.js';
import { parseMailtoLink } from './mailto.js';

export interface EntryUnsubscribePlan {
  links: string[];
  oneClickHint: boolean;
}

export interface EntryUnsubscribeResult {
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
  details: Array<{
    url: string;
    action: 'post' | 'get' | 'mailto_send' | 'skip';
    ok: boolean;
    status: number | null;
    reason?: string;
  }>;
}

export async function executeUnsubscribePlan(params: {
  plan: EntryUnsubscribePlan;
  config: AppConfig;
  logger: Logger;
  gmail: GmailClient;
  mailtoGlobalRemaining: number;
}): Promise<EntryUnsubscribeResult> {
  const out: EntryUnsubscribeResult = {
    http: {
      attempted: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    },
    mailto: {
      attempted: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    },
    manualRequired: [],
    details: [],
  };

  if (!params.config.unsubscribe.enabled) {
    return out;
  }

  let mailtoRemaining = Math.min(
    params.config.unsubscribe.mailto.max_sends_per_entry,
    params.mailtoGlobalRemaining
  );

  const links = params.plan.links.slice(0, params.config.unsubscribe.max_links_per_entry);
  const { httpLinks, mailtoLinks, otherLinks } = classifyLinks(links);

  // Process HTTP first, then mailto. This lets us skip redundant mailto sends
  // when HTTP unsubscribe already succeeded for the same sender.
  for (const link of [...httpLinks, ...mailtoLinks, ...otherLinks]) {
    const parsed = safeParseUrl(link);
    if (!parsed) {
      out.http.skipped += 1;
      out.details.push({
        url: link,
        action: 'skip',
        ok: false,
        status: null,
        reason: 'invalid_url',
      });
      continue;
    }

    const proto = parsed.protocol.toLowerCase();
    if (proto === 'mailto:') {
      if (params.config.unsubscribe.mailto.skip_if_http_succeeded && out.http.succeeded > 0) {
        out.mailto.skipped += 1;
        out.details.push({
          url: link,
          action: 'skip',
          ok: false,
          status: null,
          reason: 'mailto_skipped_http_already_succeeded',
        });
        continue;
      }

      const mailtoResult = await processMailtoLink({
        link,
        config: params.config,
        gmail: params.gmail,
        remainingBudget: mailtoRemaining,
      });
      mailtoRemaining = mailtoResult.remainingBudget;
      out.mailto.attempted += mailtoResult.attempted;
      out.mailto.succeeded += mailtoResult.succeeded;
      out.mailto.skipped += mailtoResult.skipped;
      out.mailto.failed += mailtoResult.failed;
      out.details.push(...mailtoResult.details);
      out.manualRequired.push(...mailtoResult.manualRequired);
      continue;
    }

    if (proto !== 'https:' && !(params.config.unsubscribe.http.allow_http && proto === 'http:')) {
      out.http.skipped += 1;
      out.details.push({
        url: link,
        action: 'skip',
        ok: false,
        status: null,
        reason: 'protocol_not_allowed',
      });
      continue;
    }

    if (params.plan.oneClickHint) {
      const post = await sendHttpRequest({
        url: link,
        method: 'POST',
        body: params.config.unsubscribe.http.one_click_post_body,
        config: params.config,
      });

      out.http.attempted += 1;
      if (post.ok) {
        out.http.succeeded += 1;
        out.details.push({
          url: link,
          action: 'post',
          ok: true,
          status: post.status,
        });
        continue;
      }

      const getFallback = await sendHttpRequest({
        url: link,
        method: 'GET',
        config: params.config,
      });

      out.http.attempted += 1;
      if (getFallback.ok) {
        out.http.succeeded += 1;
        out.details.push({
          url: link,
          action: 'get',
          ok: true,
          status: getFallback.status,
          reason: 'fallback_after_post_failure',
        });
      } else {
        out.http.failed += 1;
        out.details.push({
          url: link,
          action: 'post',
          ok: false,
          status: post.status,
          reason: `post_failed_then_get_failed:${getFallback.status ?? 'network'}`,
        });
      }
      continue;
    }

    const getRes = await sendHttpRequest({
      url: link,
      method: 'GET',
      config: params.config,
    });

    out.http.attempted += 1;
    if (getRes.ok) {
      out.http.succeeded += 1;
      out.details.push({
        url: link,
        action: 'get',
        ok: true,
        status: getRes.status,
        reason: 'may_require_manual_confirmation',
      });
      out.manualRequired.push({
        url: link,
        reason: 'get_unsubscribe_may_require_manual_confirmation_or_options',
      });
    } else {
      out.http.failed += 1;
      out.details.push({
        url: link,
        action: 'get',
        ok: false,
        status: getRes.status,
      });
    }
  }

  params.logger.info(
    {
      op: 'unsubscribe.entry.done',
      http_attempted: out.http.attempted,
      http_succeeded: out.http.succeeded,
      http_skipped: out.http.skipped,
      http_failed: out.http.failed,
      mailto_attempted: out.mailto.attempted,
      mailto_succeeded: out.mailto.succeeded,
      mailto_skipped: out.mailto.skipped,
      mailto_failed: out.mailto.failed,
      manual_required: out.manualRequired.length,
    },
    'Unsubscribe processing completed for entry'
  );

  return out;
}

async function processMailtoLink(params: {
  link: string;
  config: AppConfig;
  gmail: GmailClient;
  remainingBudget: number;
}): Promise<{
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  remainingBudget: number;
  details: EntryUnsubscribeResult['details'];
  manualRequired: EntryUnsubscribeResult['manualRequired'];
}> {
  const out = {
    attempted: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    remainingBudget: params.remainingBudget,
    details: [] as EntryUnsubscribeResult['details'],
    manualRequired: [] as EntryUnsubscribeResult['manualRequired'],
  };

  if (!params.config.unsubscribe.mailto.enabled) {
    out.skipped += 1;
    out.details.push({
      url: params.link,
      action: 'skip',
      ok: false,
      status: null,
      reason: 'mailto_disabled_by_config',
    });
    return out;
  }

  if (out.remainingBudget <= 0) {
    out.skipped += 1;
    out.details.push({
      url: params.link,
      action: 'skip',
      ok: false,
      status: null,
      reason: 'mailto_send_budget_exhausted',
    });
    return out;
  }

  const parsed = parseMailtoLink(params.link);
  if (!parsed) {
    out.skipped += 1;
    out.details.push({
      url: params.link,
      action: 'skip',
      ok: false,
      status: null,
      reason: 'invalid_mailto_link',
    });
    return out;
  }

  const subject = parsed.subject ?? params.config.unsubscribe.mailto.subject_fallback;
  const body = parsed.body ?? params.config.unsubscribe.mailto.body_fallback;

  const recipients = {
    to: [...parsed.to],
    cc: [...parsed.cc],
    bcc: [...parsed.bcc],
  };

  if (params.config.unsubscribe.mailto.validate_recipient_domain_dns) {
    recipients.to = await filterResolvableEmails(recipients.to);
    recipients.cc = await filterResolvableEmails(recipients.cc);
    recipients.bcc = await filterResolvableEmails(recipients.bcc);

    if (recipients.to.length === 0) {
      out.skipped += 1;
      out.details.push({
        url: params.link,
        action: 'skip',
        ok: false,
        status: null,
        reason: 'mailto_recipient_domain_unresolvable',
      });
      return out;
    }
  }

  out.attempted += 1;
  try {
    await params.gmail.sendEmail({
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      body,
    });
    out.succeeded += 1;
    out.remainingBudget -= 1;
    out.details.push({
      url: params.link,
      action: 'mailto_send',
      ok: true,
      status: null,
    });
  } catch {
    out.failed += 1;
    out.details.push({
      url: params.link,
      action: 'mailto_send',
      ok: false,
      status: null,
      reason: 'gmail_send_failed',
    });
  }

  return out;
}

async function sendHttpRequest(params: {
  url: string;
  method: 'GET' | 'POST';
  config: AppConfig;
  body?: string;
}): Promise<{ ok: boolean; status: number | null }> {
  const headers: Record<string, string> = {
    'User-Agent': params.config.unsubscribe.user_agent,
    Accept: '*/*',
  };

  if (params.method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.config.unsubscribe.request_timeout_ms);
    try {
      const response = await fetch(params.url, {
        method: params.method,
        headers,
        body: params.body,
        signal: controller.signal,
        redirect: 'follow',
      });
      return { ok: response.ok, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, status: null };
  }
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function classifyLinks(links: string[]): {
  httpLinks: string[];
  mailtoLinks: string[];
  otherLinks: string[];
} {
  const httpLinks: string[] = [];
  const mailtoLinks: string[] = [];
  const otherLinks: string[] = [];

  for (const link of links) {
    const parsed = safeParseUrl(link);
    if (!parsed) {
      otherLinks.push(link);
      continue;
    }
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'mailto:') {
      mailtoLinks.push(link);
      continue;
    }
    if (proto === 'https:' || proto === 'http:') {
      httpLinks.push(link);
      continue;
    }
    otherLinks.push(link);
  }

  return { httpLinks, mailtoLinks, otherLinks };
}

const domainResolvableCache = new Map<string, boolean>();

async function filterResolvableEmails(emails: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const email of emails) {
    const domain = extractDomain(email);
    if (!domain) continue;
    const resolvable = await isDomainResolvable(domain);
    if (resolvable) out.push(email);
  }
  return out;
}

function extractDomain(email: string): string | null {
  const idx = email.lastIndexOf('@');
  if (idx < 0 || idx === email.length - 1) return null;
  return email.slice(idx + 1).toLowerCase();
}

async function isDomainResolvable(domain: string): Promise<boolean> {
  const cached = domainResolvableCache.get(domain);
  if (cached !== undefined) return cached;

  try {
    const mx = await dns.resolveMx(domain);
    const ok = mx.length > 0;
    domainResolvableCache.set(domain, ok);
    return ok;
  } catch {
    try {
      const a = await dns.resolve4(domain);
      const ok = a.length > 0;
      domainResolvableCache.set(domain, ok);
      return ok;
    } catch {
      try {
        const aaaa = await dns.resolve6(domain);
        const ok = aaaa.length > 0;
        domainResolvableCache.set(domain, ok);
        return ok;
      } catch {
        domainResolvableCache.set(domain, false);
        return false;
      }
    }
  }
}
