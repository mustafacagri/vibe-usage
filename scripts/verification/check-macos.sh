#!/bin/bash
# Read-only command-presence inventory. Compatible with macOS Bash 3.2.
# No provider executable is invoked; no auth/config files are read.
set -u

show_help() {
  printf '%s\n' \
    'Usage: bash scripts/verification/check-macos.sh [--help|--version]' \
    '' \
    'On macOS, checks a fixed list of CLI/build command names on the current PATH.' \
    'Reports available/missing only; never prints executable paths or identities.' \
    'Does not execute provider commands, inspect authentication, launch apps,' \
    'change accounts, list models, or send usage/inference requests.' \
    'This does not test account isolation, quota collection, or two-account failover.' \
    'A terminal PATH check also does not test discovery from a Finder-launched app.'
}

if [ "$#" -gt 1 ]; then
  printf '%s\n' 'Use at most one argument. Use --help.' >&2
  exit 2
fi

case "${1-}" in
  -h|--help)
    show_help
    exit 0
    ;;
  --version)
    printf '%s\n' 'check-macos.sh 1.0.0'
    exit 0
    ;;
  '')
    ;;
  *)
    printf '%s\n' 'Unsupported argument. Use --help.' >&2
    exit 2
    ;;
esac

case "${OSTYPE-}" in
  darwin*)
    ;;
  *)
    printf '%s\n' 'Skipped: run this availability check in Bash on macOS.' >&2
    exit 2
    ;;
esac

printf '%s\n' 'macOS command availability (current terminal PATH only)'
printf '%s\n' 'No provider command will be executed.'
printf '\n%-18s %s\n' 'Command' 'Availability'

# Names are static and are never used as commands. Do not add auth/status probes.
for task_command in codex claude cursor cursor-agent agent antigravity agy node npm pnpm bun rustc cargo xcodebuild xcode-select codesign xcrun; do
  if command -v "$task_command" >/dev/null 2>&1; then
    printf '%-18s %s\n' "$task_command" 'available'
  else
    printf '%-18s %s\n' "$task_command" 'missing'
  fi
done

printf '\n%s\n' \
  'Availability does not prove vendor identity, authentication, or supported features.' \
  'Not tested: quota collection, account isolation, GUI discovery, actual failover.'
