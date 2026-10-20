# Releasing

## 0. After a Claude Code update

Run `npm run probe:claude`. It checks, read-only, what the app assumes about the installed Claude Code: the screens it
may show before a session starts (any new one could ask a question of a session moved while the user is away), the
session markers it sets for child processes, its session list and process start times, transcript record types, and
each profile's settings that would put a question in front of an unattended start. It exits with 1 when an assumption
no longer holds; fix the app before releasing.

## 1. Publish the packages

1. Raise `version` in `package.json` and commit.
2. Tag the commit `v<version>` and push the tag. The **Build desktop** workflow builds and tests the Windows and macOS
   packages with update metadata (signed when requested, see section 4). It uploads them to a draft GitHub release,
   checks every asset's name, size and server-reported SHA-256 against the local build, and only then makes the release
   public. In parallel, a separate job publishes the CLI tarball to npm and verifies the registry's exact version,
   SHA-512 integrity and matching `latest` tag.

The desktop release never waits for npm: a missing npm binding fails only the npm job. A draft release can be resumed;
an already public release is verified against the artifacts and left unchanged. A full rebuild of signed binaries may
produce different bytes, so it is not interchangeable with retrying publication of the same artifacts. The npm step
accepts an existing immutable version only if its tarball integrity and `latest` tag match this build; different
content requires a new version, never an overwrite. A network or authentication failure is not treated as a missing
npm package.

### npm trusted publisher prerequisite

An owner of `vibe-usage-cli` must configure its [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/):
GitHub Actions, owner `mustafacagri`, repository `vibe-usage`, workflow filename `build.yml`. Keep the filename exact;
if an npm environment is configured, the workflow job must use that same protected GitHub environment. The current
workflow does not name an environment. Node 24 supplies an npm version supporting OIDC; provenance is also requested
explicitly. No long-lived npm token is added to this repository.

An E404/ENEEDAUTH publish failure requires checking package ownership and that binding; repeated tags or changing
the package name do not repair the trust relationship. The workflow cannot create npm account settings or signing
certificates. Verify the first configured publish and a signed upgrade on both operating systems before calling the
release process validated.

Packages are named `Vibe-Usage-<version>-<os>-<arch>.<ext>`, the installer `Vibe-Usage-<version>-win-setup.exe` (no
spaces, so their download URLs are predictable). The app checks the latest release once a day (Settings → General) and
shows a banner that links to its page, and where the copy can update itself, a **Download** button.

## 2. Package managers

Download the release's packages into `release/`, then:

```sh
npm run release:manifests
```

It writes, with the SHA-256 of each package:

- `release/manifests/winget/<version>/`: a winget manifest set (`zip` with a portable app, alias `vibe-usage`).
  Submit it to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (copy it to
  `manifests/m/MustafaCagriGuven/VibeUsage/<version>/`, run `winget validate`, open a pull request), or use
  `wingetcreate submit release/manifests/winget/<version>`.
- `release/manifests/homebrew/vibe-usage.rb`: a cask. Put it in a tap repository
  (`mustafacagri/homebrew-tap`, under `Casks/`); users then run `brew install --cask mustafacagri/tap/vibe-usage`.
  While the app is not notarized, macOS blocks its first start; the cask's users must allow it in
  System Settings → Privacy & Security (or remove the quarantine attribute).

## 3. In-app updates

Each release carries what [electron-updater](https://www.electron.build/v26/docs/features/auto-update/) reads:
`latest.yml` (Windows) and `latest-mac.yml` (macOS) with each package's SHA-512, and the `.blockmap` files. The
workflow uploads them with the packages; a release without them leaves installed copies on the release-page link.

The feed is fixed to this repository's GitHub releases (`build.publish` and the app itself). Nothing happens on its
own: the user clicks **Download**, the updater verifies the download against the checksum, and **Restart to update**
installs it. There is no automatic download, no install on quit, no prerelease and no downgrade. Turning off update
checks in Settings turns this off too.

Only some copies can replace themselves; the others keep the release-page link and say why:

| Copy                                | In-app update                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Windows installer, signed           | Yes. The update must carry the same publisher signature and checksum.   |
| Windows installer, unsigned         | No: without a publisher the updater could check only the checksum.      |
| Windows portable zip                | No: download the new zip, or switch to the installer.                   |
| macOS, signed with a Developer ID   | Yes (Squirrel.Mac requires the signature).                              |
| macOS, unsigned (ad-hoc)            | No: download or rebuild.                                                |
| Development build (`npm start`)     | No.                                                                     |

The macOS packages are built on the runner's architecture (Apple silicon on `macos-latest`); the update feed lists
only those.

## 4. Code signing (needs certificates)

Unsigned builds are the default and work, but Windows SmartScreen and macOS Gatekeeper warn on first start, and macOS
copies cannot update themselves. `npm run build:win` and `npm run build:mac` run `scripts/package.ts`, which builds
unsigned unless a signed build is asked for (`--signed` or `VIBE_SIGNED_RELEASE=true`). A signed build checks its
credentials first and **fails without building** when one is missing, so a release meant to be signed is never
published unsigned.

The workflow asks for a signed build on a manual run with **signed** checked, or for every version tag once the
repository variable `SIGNED_RELEASE` is `true`. The secrets go only to the package step and never to pull requests.

- **Windows**: an OV/EV code-signing certificate as the secrets `WIN_CSC_LINK` (base64 `.pfx`) and
  `WIN_CSC_KEY_PASSWORD`. The signed build turns on `signExecutable` (unsigned builds still get the icon and version information). (Azure Trusted Signing would need
  `build.win.azureSignOptions` instead; it is not wired up.)
- **macOS**: a Developer ID Application certificate as `MAC_CSC_LINK` (base64 `.p12`) and `MAC_CSC_KEY_PASSWORD`, plus
  notarization credentials: either an App Store Connect API key (recommended) as `APPLE_API_KEY_P8` (the key file's
  text), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`. The signed build replaces the ad-hoc identity and turns on the hardened runtime and notarization.

None of this has been run with real certificates yet: obtaining them, a first signed and notarized release, and an
update from one published release to the next still have to be done and checked by the maintainer.

Signed and notarized builds also make the winget and Homebrew installs start without warnings.
