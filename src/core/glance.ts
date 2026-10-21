// What the tray tells without the window being opened: each tool's best limit in the tooltip,
// and a notification when an account's tightest limit runs low or becomes available again.
import path from 'node:path';
import { APP_NAME, providerById, visibleProviders, type ProviderId } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import {
  describeCode,
  describeWindow,
  formatAccountName,
  formatDuration,
  formatPercent,
  successorName,
  type FormatContext
} from '../shared/format.ts';
import type { Account, MeasuredAccount, Snapshot } from '../shared/types.ts';
import type { Attempt, Notice } from './continuity.ts';
import { tightestWindow, type KnownWindow } from './selection.ts';

const UNMEASURED = '—';

const isMeasured = (account: MeasuredAccount): boolean => account.status === 'ok';

// The most headroom any measured account of the tool has: its tightest limit.
function bestWindow(snapshot: Snapshot, providerId: ProviderId): KnownWindow | null {
  return (snapshot.providers.find(p => p.id === providerId)?.accounts ?? [])
    .filter(isMeasured)
    .flatMap(account => tightestWindow(account) ?? [])
    .reduce<KnownWindow | null>((most, window) => (most && most.remainingPercent >= window.remainingPercent ? most : window), null);
}

// The tool the tray icon shows: the first one in the window's order that has accounts.
export function trayTool(snapshot: Snapshot): { providerId: ProviderId; percent: number | null } | null {
  const providerId = visibleProviders(snapshot.settings).find(id => snapshot.providers.some(p => p.id === id && p.accounts.length));
  return providerId ? { providerId, percent: bestWindow(snapshot, providerId)?.remainingPercent ?? null } : null;
}

// One line per tool with accounts: the most headroom any of its accounts has, and when that
// account's tightest limit resets.
export function trayTooltip(snapshot: Snapshot, { locale, now = Date.now() }: FormatContext): string {
  const lines = visibleProviders(snapshot.settings).flatMap(providerId => {
    const accounts = snapshot.providers.find(p => p.id === providerId)?.accounts ?? [];
    if (!accounts.length) return [];
    const best = bestWindow(snapshot, providerId);
    const name = providerById(providerId).name;
    if (!best) return [`${name} ${UNMEASURED}`];
    const resetMs = best.resetsAt ? Date.parse(best.resetsAt) - now : NaN;
    const reset = resetMs > 0 ? ` · ${formatDuration(resetMs, locale)}` : '';
    return [`${name} ${formatPercent(best.remainingPercent, locale)}${reset}`];
  });
  return [APP_NAME, ...lines].join('\n');
}

export interface QuotaAlert {
  kind: 'low' | 'available';
  providerId: ProviderId;
  account: MeasuredAccount;
  window: KnownWindow;
}

// Remembers each account's last measured headroom and reports the readings that cross
// `threshold` (by default the low line the user set). An account's first reading only sets the
// baseline.
export function createQuotaWatch(threshold?: number): (snapshot: Snapshot) => QuotaAlert[] {
  const lastHeadroom = new Map<string, number>();
  return snapshot => {
    const line = threshold ?? snapshot.settings.lowQuotaPercent;
    return snapshot.providers
      .filter(provider => !snapshot.settings.hiddenProviders.includes(provider.id))
      .flatMap(provider =>
        provider.accounts.filter(isMeasured).flatMap((account): QuotaAlert[] => {
          const window = tightestWindow(account);
          if (!window) return [];
          const before = lastHeadroom.get(account.id);
          lastHeadroom.set(account.id, window.remainingPercent);
          if (before === undefined) return [];
          const isLow = window.remainingPercent <= line;
          if (isLow === before <= line) return [];
          return [{ kind: isLow ? 'low' : 'available', providerId: provider.id, account, window }];
        })
      );
  };
}

// What a failed notice says, by what failed: work moved off an account that ran out, work brought
// back to the main account (which has quota again), or a session opened again after a restart.
const FAILED_BODIES = {
  move: 'noticeFailedBody',
  return: 'noticeReturnFailedBody',
  reopen: 'noticeReopenFailedBody'
} as const satisfies Record<Attempt | 'move', MessageKey>;

export function describeNotice(notice: Notice, context: FormatContext, accounts: readonly Account[]): { title: string; body: string } {
  const { t, locale } = context;
  const subject = notice.kind === 'suggested' ? accounts.find(a => a.id === notice.suggestion.accountId) : notice.from;
  const providerId = notice.kind === 'suggested' ? notice.suggestion.providerId : notice.from.providerId;
  const title = `${providerById(providerId).name}${subject ? ` · ${formatAccountName(subject, t)}` : ''}`;
  switch (notice.kind) {
    case 'suggested': {
      const { suggestion } = notice;
      if (suggestion.kind === 'return') return { title, body: t('noticeReturnBody') };
      if (suggestion.kind === 'reopen') return { title, body: t('noticeReopenBody') };
      const target = successorName(providerId, suggestion.target, accounts, t);
      return { title, body: t('noticeLowBody', { quota: formatPercent(suggestion.remainingPercent, locale), target }) };
    }
    case 'continued': {
      const target = successorName(providerId, { providerId: notice.to.providerId, accountId: notice.to.account?.id ?? null }, accounts, t);
      return { title, body: t('noticeContinuedBody', { target, project: path.basename(notice.projectDir) }) };
    }
    case 'returned': {
      const target = successorName(providerId, { providerId: notice.to.providerId, accountId: notice.to.account?.id ?? null }, accounts, t);
      return { title, body: t('noticeReturnedBody', { target, project: path.basename(notice.projectDir) }) };
    }
    case 'reopened': {
      const target = successorName(providerId, { providerId: notice.to.providerId, accountId: notice.to.account?.id ?? null }, accounts, t);
      return { title, body: t('noticeReopenedBody', { target, project: path.basename(notice.projectDir) }) };
    }
    case 'stranded':
      return { title, body: t('noticeStrandedBody') };
    case 'failed':
      return { title, body: t(FAILED_BODIES[notice.attempt ?? 'move'], { reason: describeCode(notice.code, t) }) };
  }
}

export function describeAlert({ kind, providerId, account, window }: QuotaAlert, context: FormatContext): { title: string; body: string } {
  const view = describeWindow(window, context);
  const quota = [`${view.label}: ${view.value}`, view.reset].filter(Boolean).join(' · ');
  return {
    title: `${providerById(providerId).name} · ${formatAccountName(account, context.t)}`,
    body: kind === 'low' ? quota : `${context.t('quotaAvailableAgain')}\n${quota}`
  };
}
