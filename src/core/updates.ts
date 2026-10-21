// Whether a newer release is out: the latest GitHub release of the app's repository against
// the running version, with its page and, when asked for, the installer for this machine.
import { APP_REPOSITORY } from '../shared/catalog.ts';
import type { UpdateInfo } from '../shared/types.ts';
import { isObject } from './files.ts';

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${APP_REPOSITORY}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${APP_REPOSITORY}/releases/`;
const RELEASE_DOWNLOAD = `${RELEASE_PAGE}download/`;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

const parts = (version: string): number[] | null => VERSION.exec(version)?.slice(1).map(Number) ?? null;

// Whether `candidate` is a later x.y.z than `current`; false for anything unparsable.
export function isNewer(candidate: string, current: string): boolean {
  const next = parts(candidate);
  const now = parts(current);
  if (!next || !now) return false;
  const index = next.findIndex((n, i) => n !== now[i]);
  return index !== -1 && (next[index] ?? 0) > (now[index] ?? 0);
}

// The release to tell about, or null when there is none newer. `installer` is how this machine's
// installer file name ends (`-mac-arm64.dmg`); its link is included when the release has it.
// Both links must belong to the app's repository: they are opened in the user's browser.
export async function checkForUpdate(
  currentVersion: string,
  fetchJson: (url: string) => Promise<unknown>,
  installer?: string
): Promise<UpdateInfo | null> {
  const release = await fetchJson(LATEST_RELEASE_URL);
  if (!isObject(release) || release.draft === true || release.prerelease === true) return null;
  const { tag_name: tag, html_url: url, assets } = release;
  if (typeof tag !== 'string' || !isReleasePage(url) || !isNewer(tag, currentVersion)) return null;
  const download = installer && Array.isArray(assets) ? installerUrl(assets, installer) : undefined;
  return { version: tag.replace(/^v/, ''), url, ...(download ? { download } : {}) };
}

function installerUrl(assets: unknown[], suffix: string): string | undefined {
  for (const asset of assets) {
    if (!isObject(asset) || typeof asset.name !== 'string' || !asset.name.endsWith(suffix)) continue;
    const link = asset.browser_download_url;
    if (isReleaseDownload(link)) return link;
  }
  return undefined;
}

// How a macOS disk image for `arch` ends, as package.json's artifactName names it
// (`…-${os}-${arch}.${ext}`); Node's arch names (arm64, x64) are electron-builder's.
export const macInstallerSuffix = (arch: string): string => `-mac-${arch}.dmg`;

// A Windows copy that cannot replace itself (the portable zip) is offered the archive it came from.
export const windowsArchiveSuffix = (arch: string): string => `-win-${arch}.zip`;

// The file a copy that cannot update itself downloads by hand, or undefined where there is none.
export function manualInstallerSuffix(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'darwin') return macInstallerSuffix(arch);
  return platform === 'win32' ? windowsArchiveSuffix(arch) : undefined;
}

export const isReleaseDownload = (url: unknown): url is string => typeof url === 'string' && url.startsWith(RELEASE_DOWNLOAD);

export const isReleasePage = (url: unknown): url is string => typeof url === 'string' && url.startsWith(RELEASE_PAGE);
