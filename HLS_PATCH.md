# HLS recovery and buffering

This fork changes Jellyfin Web's hls.js behavior in two areas:

- Non-fatal HTTP segment errors are left to hls.js's configured retry policy.
- Forward buffering can be controlled at runtime through `config.json`.

The default buffer configuration is:

```json
{
  "hlsBuffer": {
    "maxBufferLength": 45,
    "highBitrateMaxBufferLength": 15,
    "highBitrateThreshold": 25000000,
    "maxMaxBufferLength": 120,
    "maxBufferSize": 134217728,
    "backBufferLength": 30
  }
}
```

`maxBufferLength` is the minimum forward target. For Chrome, Edge, and
Firefox, `highBitrateMaxBufferLength` is used when the actual media source
bitrate reaches `highBitrateThreshold`.

`maxMaxBufferLength` is the forward-buffer time ceiling and `maxBufferSize`
is the byte budget. The default 128 MiB budget allows long buffers for modest
bitrates without pushing high-bitrate playback toward browser MediaSource
quota failures.

On-demand video transcodes request Jellyfin's adaptive HLS variants. Current
Jellyfin servers may decline that request for local-network clients.

After building, these values can be changed in the deployed `config.json`
without rebuilding the JavaScript bundles.

## Playback diagnostics

Client playback diagnostics are enabled by default and stored in IndexedDB in
the browser profile. Samples and events are written as append-only chunks so
long playback sessions do not repeatedly clone and rewrite the entire run.
Records contain one-second media samples, forward buffer depth, media events,
dropped frames, and HLS fragment timing and errors. URL query strings are
removed before data is stored.

Retention and sampling are controlled in `config.json`:

```json
{
  "playbackDiagnostics": {
    "enabled": true,
    "sampleIntervalMs": 1000,
    "flushIntervalMs": 30000,
    "maxRuns": 20,
    "maxAgeDays": 7,
    "maxEventsPerRun": 50000,
    "maxSamplesPerRun": 30000,
    "reportUrl": null
  }
}
```

Set `enabled` to `false` to opt out. `reportUrl` may point to a custom
same-origin endpoint that accepts a JSON `POST`; it is `null` by default
because the standard Jellyfin server does not expose a diagnostics endpoint.

The browser console exposes:

```js
await JellyfinPlaybackDiagnostics.list()
await JellyfinPlaybackDiagnostics.export()
await JellyfinPlaybackDiagnostics.export('<run-id>')
await JellyfinPlaybackDiagnostics.clear()
```

## Container

The container serves Jellyfin Web on port `8080`. Set the backend URL when the
container starts:

```sh
docker run --rm -p 8080:8080 \
  -e JELLYFIN_BACKEND_URL=https://jellyfin.example.com \
  ghcr.io/OWNER/jellyfin-web:latest
```

The backend URL is written to the runtime `config.json`; it is not embedded in
the image. It must be reachable from the user's browser. If the variable is
not set, Jellyfin Web assumes that the Jellyfin API is available on the same
origin as the web application.
