set -eu
umask 077
case "${BACKUP_ENVIRONMENT:?}" in staging|production) ;; *) exit 2 ;; esac
: "${PGHOST:?}" "${PGDATABASE:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
: "${S3_BUCKET:?}" "${AWS_ENDPOINT_URL:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}" "${AGE_RECIPIENT:?}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
task_dir=$(mktemp -d /tmp/damadama-backup.XXXXXX)
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
stamp=$(date -u +%Y%m%dT%H%M%SZ)
prefix="damadama/$BACKUP_ENVIRONMENT/"
nonce=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
name="$stamp-$nonce.dump.age"
started=$(date +%s)
pg_dump --format=custom --no-owner --no-acl --file="$task_dir/database.dump"
age --recipient "$AGE_RECIPIENT" --output "$task_dir/$name" "$task_dir/database.dump"
(cd "$task_dir" && sha256sum "$name" > "$name.sha256")
aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp "$task_dir/$name" "s3://$S3_BUCKET/$prefix$name" --only-show-errors
aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp "$task_dir/$name.sha256" "s3://$S3_BUCKET/$prefix$name.sha256" --only-show-errors
printf '{"environment":"%s","backup":"%s","completedAt":"%s","retentionDays":7,"durationSeconds":%s}\n' "$BACKUP_ENVIRONMENT" "$prefix$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(($(date +%s)-started))" > "$task_dir/$name.json"
aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp "$task_dir/$name.json" "s3://$S3_BUCKET/$prefix$name.json" --only-show-errors
cutoff=$(($(date +%s)-7*24*60*60))
aws --endpoint-url "$AWS_ENDPOINT_URL" s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$prefix" --query 'Contents[].[Key,LastModified]' --output text > "$task_dir/objects"
while read -r key modified; do
  case "$key" in
    "$prefix"????????T??????Z-????????????????.dump.age|"$prefix"????????T??????Z-????????????????.dump.age.sha256|"$prefix"????????T??????Z-????????????????.dump.age.json) ;;
    *) continue ;;
  esac
  if [ "$(date -u -d "$modified" +%s)" -lt "$cutoff" ]; then
    aws --endpoint-url "$AWS_ENDPOINT_URL" s3api delete-object --bucket "$S3_BUCKET" --key "$key" > /dev/null
  fi
done < "$task_dir/objects"
cat "$task_dir/$name.json"
