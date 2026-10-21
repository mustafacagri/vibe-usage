// Whether a tool's service reports a problem, from the status page its maker runs. A tool that
// answers slowly or not at all may be down for everyone, which no quota reading says.
import { isOneOf, PROVIDER_IDS, SERVICE_STATUSES, type ProviderId } from '../shared/catalog.ts';
import type { ServiceIssue } from '../shared/types.ts';
import { isObject } from './files.ts';

// Each page's components that carry the tool's own work (the ids stay when a page renames one).
// A tool without a page here (Antigravity) is never reported on.
export const STATUS_PAGES = {
  // Claude Code
  claude: { url: 'https://status.claude.com', components: ['yyzkbfz2thpt'] },
  // Codex in ChatGPT Desktop: the only Codex component OpenAI's page has.
  codex: { url: 'https://status.openai.com', components: ['01KMKFAMWKQ81YWSE1Z18R6VHR'] },
  // IDE and CLI
  cursor: { url: 'https://status.cursor.com', components: ['rflc60xp5jp2', 'vsny1qv7v86c'] },
  // Copilot, and Copilot AI Model Providers
  copilot: { url: 'https://www.githubstatus.com', components: ['pjmpxvq2cmr2', 'cnnb39dkkk82'] }
} as const satisfies Partial<Record<ProviderId, { url: string; components: readonly string[] }>>;

export type StatusProviderId = keyof typeof STATUS_PAGES;
const isStatusProvider = (id: ProviderId): id is StatusProviderId => Object.hasOwn(STATUS_PAGES, id);
export const STATUS_PROVIDER_IDS: readonly StatusProviderId[] = PROVIDER_IDS.filter(isStatusProvider);

const SUMMARY_PATH = '/api/v2/summary.json';

export interface ServiceStatusReading {
  issues: ServiceIssue[];
  // The tools whose page could not be read: what was known about them stands.
  failed: ProviderId[];
}

function parseSummary(providerId: StatusProviderId, document: unknown): ServiceIssue[] {
  if (!isObject(document) || !Array.isArray(document.components)) throw new TypeError('not a status summary');
  const watched: readonly string[] = STATUS_PAGES[providerId].components;
  return document.components.flatMap((entry): ServiceIssue[] => {
    if (!isObject(entry) || typeof entry.id !== 'string' || !watched.includes(entry.id)) return [];
    const { name, status } = entry;
    if (typeof name !== 'string' || !isOneOf(SERVICE_STATUSES, status)) return [];
    return [{ providerId, component: name, status }];
  });
}

export async function checkServiceStatus(
  fetchJson: (url: string) => Promise<unknown>,
  providerIds: readonly StatusProviderId[] = STATUS_PROVIDER_IDS
): Promise<ServiceStatusReading> {
  const readings = await Promise.allSettled(
    providerIds.map(async id => parseSummary(id, await fetchJson(`${STATUS_PAGES[id].url}${SUMMARY_PATH}`)))
  );
  return {
    issues: readings.flatMap(reading => (reading.status === 'fulfilled' ? reading.value : [])),
    failed: providerIds.filter((_id, i) => readings[i]?.status === 'rejected')
  };
}
