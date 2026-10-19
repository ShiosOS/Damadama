set -eu
restore_max_seconds=${RESTORE_MAX_SECONDS-1800}
case "$restore_max_seconds" in
  ''|*[!0-9]*) echo 'RESTORE_MAX_SECONDS must be a positive whole number of seconds' >&2; exit 2 ;;
  *[1-9]*) ;;
  *) echo 'RESTORE_MAX_SECONDS must be a positive whole number of seconds' >&2; exit 2 ;;
esac
if [ "${RESTORE_DEADLINE_ACTIVE-}" != 1 ]; then
  RESTORE_DEADLINE_ACTIVE=1
  export RESTORE_DEADLINE_ACTIVE
  exec timeout --signal=TERM --kill-after=5s "$restore_max_seconds" sh "$0" "$@"
fi
umask 077
: "${RESTORE_TARGET_ACK:?Set isolated-empty-target only after inspecting the target}"
[ "$RESTORE_TARGET_ACK" = isolated-empty-target ] || exit 2
: "${PGHOST:?}" "${PGDATABASE:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${AGE_IDENTITY_FILE:?}"
[ -f "${1:?encrypted backup path required}" ]
[ -f "${2:?checksum path required}" ]
task_dir=$(mktemp -d /tmp/damadama-restore.XXXXXX)
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
started=$(date +%s)
cp "$1" "$task_dir/backup.dump.age"
expected=$(awk '{print $1}' "$2")
actual=$(sha256sum "$task_dir/backup.dump.age" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo 'Encrypted backup checksum mismatch' >&2; exit 1; }
objects=$(psql -X -A -t -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','public'));")
[ "$objects" = 0 ] || { echo 'Restore requires an empty isolated database' >&2; exit 1; }
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$task_dir/database.dump" "$task_dir/backup.dump.age"
pg_restore --list "$task_dir/database.dump" > "$task_dir/contents"
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$PGDATABASE" "$task_dir/database.dump"
duration=$(($(date +%s)-started))
printf '{"target":"%s","durationSeconds":%s,"oneHourTargetMet":' "$PGDATABASE" "$duration"
if [ "$duration" -le 3600 ]; then printf 'true}\n'; else printf 'false}\n'; exit 1; fi
