#!/bin/zsh
# Internal transport only. Never logs, prints or exposes credential bytes.
set -euo pipefail

ACTION="${1:-}"
TOKEN_FILE="${2:-}"

ACTIVE_SERVICE="gemini"
ACTIVE_ACCOUNT="antigravity"
BACKUP_SERVICE="vibe-usage"
BACKUP_ACCOUNT="antigravity-backup"
SECURITY="/usr/bin/security"

emit() {
  printf '%s\n' "$1"
}

restart_hub() {
  local agy="${HOME}/.gemini/bin/agy"
  if [[ ! -x "$agy" ]]; then
    agy="${HOME}/.local/bin/agy"
  fi
  if [[ ! -x "$agy" ]]; then
    return 1
  fi
  /usr/bin/pkill -u "$(id -u)" -f 'agy.*--hub' >/dev/null 2>&1 || true
  /bin/sleep 0.3
  /usr/bin/nohup "$agy" --hub >/dev/null 2>&1 &
  return 0
}

write_keychain_hex() {
  local service="$1"
  local account="$2"
  local hex="$3"
  "$SECURITY" -i >/dev/null 2>&1 <<EOF
add-generic-password -U -s "${service}" -a "${account}" -X "${hex}"
EOF
}

case "$ACTION" in
  status)
    if "$SECURITY" find-generic-password -s "$BACKUP_SERVICE" -a "$BACKUP_ACCOUNT" >/dev/null 2>&1; then
      emit '{"ok":true,"hasBackup":true}'
    else
      emit '{"ok":true,"hasBackup":false}'
    fi
    ;;

  switch)
    if [[ -z "$TOKEN_FILE" || ! -f "$TOKEN_FILE" ]]; then
      emit '{"ok":false,"error":"token_missing"}'
      exit 0
    fi
    payload="go-keyring-base64:$(/usr/bin/base64 < "$TOKEN_FILE" | /usr/bin/tr -d '\r\n')"
    payload_hex="$(printf '%s' "$payload" | /usr/bin/xxd -p | /usr/bin/tr -d '\r\n')"
    unset payload

    backed_up="false"
    if existing="$("$SECURITY" find-generic-password -s "$ACTIVE_SERVICE" -a "$ACTIVE_ACCOUNT" -w 2>/dev/null)"; then
      if [[ -n "$existing" ]]; then
        existing_hex="$(printf '%s' "$existing" | /usr/bin/xxd -p | /usr/bin/tr -d '\r\n')"
        unset existing
        if ! write_keychain_hex "$BACKUP_SERVICE" "$BACKUP_ACCOUNT" "$existing_hex"; then
          unset existing_hex payload_hex
          emit '{"ok":false,"error":"backup_failed"}'
          exit 0
        fi
        unset existing_hex
        backed_up="true"
      fi
    fi

    if ! write_keychain_hex "$ACTIVE_SERVICE" "$ACTIVE_ACCOUNT" "$payload_hex"; then
      unset payload_hex
      emit '{"ok":false,"error":"write_failed"}'
      exit 0
    fi
    unset payload_hex

    if restart_hub; then
      emit "{\"ok\":true,\"backedUp\":${backed_up},\"hubRestarted\":true}"
    else
      emit "{\"ok\":true,\"backedUp\":${backed_up},\"hubRestarted\":false}"
    fi
    ;;

  restore)
    if ! backup="$("$SECURITY" find-generic-password -s "$BACKUP_SERVICE" -a "$BACKUP_ACCOUNT" -w 2>/dev/null)"; then
      emit '{"ok":false,"error":"no_backup"}'
      exit 0
    fi
    if [[ -z "$backup" ]]; then
      emit '{"ok":false,"error":"no_backup"}'
      exit 0
    fi
    backup_hex="$(printf '%s' "$backup" | /usr/bin/xxd -p | /usr/bin/tr -d '\r\n')"
    unset backup
    if ! write_keychain_hex "$ACTIVE_SERVICE" "$ACTIVE_ACCOUNT" "$backup_hex"; then
      unset backup_hex
      emit '{"ok":false,"error":"write_failed"}'
      exit 0
    fi
    unset backup_hex
    if restart_hub; then
      emit '{"ok":true,"hubRestarted":true}'
    else
      emit '{"ok":true,"hubRestarted":false}'
    fi
    ;;

  *)
    emit '{"ok":false,"error":"switch_failed"}'
    ;;
esac
