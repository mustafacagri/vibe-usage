// Whether a tool's service reports a problem, from the status page its maker runs. A tool that
// answers slowly or not at all may be down for everyone, which no quota reading says.
import { PROVIDER_IDS, SERVICE_STATUSES, type ProviderId } from '../shared/catalog.ts';
import type { ServiceIssue } from '../shared/types.ts';
import { isObject, type JsonObject } from './files.ts';

// Each page's components that carry the tool's own work, by the ids the pages gave them on
// 2026-10-21 (an id stays when a page renames a component). A tool without a page here
// (Antigravity) is never reported on.
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

// The worst state among the tool's components, or null when they all work. A page that lists
// none of the components is no sign of calm: its ids changed, so the read fails.
function parseSummary(providerId: StatusProviderId, document: unknown): ServiceIssue | null {
  if (!isObject(document) || !Array.isArray(document.components)) throw new TypeError('not a status summary');
  const watched: readonly string[] = STATUS_PAGES[providerId].components;
  const components = document.components.filter(
    (entry): entry is JsonObject => isObject(entry) && typeof entry.id === 'string' && watched.includes(entry.id)
  );
  if (!components.length) throw new TypeError('none of the watched components is on the page');
  // SERVICE_STATUSES run from the mildest to the worst.
  const worst = Math.max(-1, ...components.map(({ status }) => SERVICE_STATUSES.findIndex(known => known === status)));
  const status = SERVICE_STATUSES[worst];
  return status ? { providerId, status } : null;
}

export async function checkServiceStatus(
  fetchJson: (url: string) => Promise<unknown>,
  providerIds: readonly StatusProviderId[] = STATUS_PROVIDER_IDS
): Promise<ServiceStatusReading> {
  const readings = await Promise.allSettled(
    providerIds.map(async id => parseSummary(id, await fetchJson(`${STATUS_PAGES[id].url}${SUMMARY_PATH}`)))
  );
  return {
    issues: readings.flatMap(reading => (reading.status === 'fulfilled' && reading.value ? [reading.value] : [])),
    failed: providerIds.filter((_id, i) => readings[i]?.status === 'rejected')
  };
}

// What is known after a reading: its issues, and for each tool whose page could not be read what
// was known before. A tool the reading did not ask about is left out.
export function mergeServiceIssues(previous: readonly ServiceIssue[], { issues, failed }: ServiceStatusReading): ServiceIssue[] {
  return [...previous.filter(issue => failed.includes(issue.providerId)), ...issues];
}
