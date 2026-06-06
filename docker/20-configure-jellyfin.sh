#!/bin/sh
set -eu

config_file=/usr/share/nginx/html/config.json
backend_url=${JELLYFIN_BACKEND_URL:-}

if [ -z "$backend_url" ]; then
    echo "JELLYFIN_BACKEND_URL is not set; Jellyfin Web will use its own origin."
    exit 0
fi

case "$backend_url" in
    http://*|https://*) ;;
    *)
        echo "JELLYFIN_BACKEND_URL must start with http:// or https://" >&2
        exit 1
        ;;
esac

backend_url=${backend_url%/}
temporary_file=$(mktemp)
trap 'rm -f "$temporary_file"' EXIT

jq --arg backend_url "$backend_url" \
    '.servers = [$backend_url] | .multiserver = false' \
    "$config_file" > "$temporary_file"

cat "$temporary_file" > "$config_file"
echo "Configured Jellyfin Web backend: $backend_url"
