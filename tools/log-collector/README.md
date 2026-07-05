# Jellyfin Log Collector

Small upload collector for compact Jellyfin Web playback diagnostics.

## Build a Debian package

```sh
cd tools/log-collector
ARCH=arm64 VERSION=0.1.0 ./package-deb.sh
```

Install:

```sh
sudo apt install ./dist/jellyfin-log-collector_0.1.0_arm64.deb
sudo systemctl start jellyfin-log-collector
```

## Caddy

```caddyfile
jellyfin-logs.motofactory.net {
    reverse_proxy 127.0.0.1:8099
}
```

## Security model

The browser does not contain a private key or shared secret. Uploads start with
`POST /v1/uploads/init`, passing the current Jellyfin `Authorization` header.
The collector validates that header against the configured Jellyfin server and
returns a short-lived one-use upload token.

Uploads are capped by `max_compressed_upload_bytes` and stored under
`/var/lib/jellyfin-log-collector/uploads`.
