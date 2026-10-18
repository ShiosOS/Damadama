#!/bin/sh
set -eu
exec python3 /opt/recovery/publish_completion.py supervise "$@"
