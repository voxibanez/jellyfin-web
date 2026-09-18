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
    "maxMaxBufferLength": 90,
    "maxBufferSize": 100663296,
    "backBufferLength": 30
  }
}
```

`maxBufferLength` is the minimum forward target. For Chrome, Edge, and
Firefox, `highBitrateMaxBufferLength` is used when the **actual media source /
transcode bitrate** reaches `highBitrateThreshold` (not the Auto ceiling).

`maxMaxBufferLength` is the forward-buffer time ceiling and `maxBufferSize`
is the byte budget (96 MiB). At runtime the time targets are also clamped so
`bitrate × seconds` cannot exceed that byte budget, which avoids Chrome
MediaSource quota / `bufferAppendError` failures.

On-demand video transcodes request Jellyfin's adaptive HLS variants. Current
Jellyfin servers may decline that request for local-network clients. When Auto
quality is enabled:

- Sustained `bufferStalledError` session-downshifts `MaxStreamingBitrate` using
  an ABR ladder (and measured fragment throughput when available).
- After ~2 minutes of healthy buffer, bitrate can step back up toward the saved
  Auto ceiling.
- Saved user preferences are not rewritten.

After building, these values can be changed in the deployed `config.json`
without rebuilding the JavaScript bundles.

## Playback diagnostics

Client playback diagnostics are enabled by default and stored in IndexedDB in
the browser profile. Healthy playback keeps only summary counters and a short
pre-incident ring in memory; samples/events are persisted around stall/error
incident windows. Fragment retries and recoveries are counted in the run summary.

The quality menu shows `Auto (reduced to N Mbps)` when a session downshift is
active. Player stats show session bitrate, HLS variant count, and measured
throughput.

Retention and sampling are controlled in `config.json`:

```json
{
  "playbackDiagnostics": {
    "enabled": true,
    "sampleIntervalMs": 2000,
    "flushIntervalMs": 30000,
    "maxRuns": 20,
    "maxAgeDays": 7,
    "maxEventsPerRun": 5000,
    "maxSamplesPerRun": 5000,
    "preIncidentWindowSeconds": 10,
    "postIncidentWindowSeconds": 20,
    "maxIncidentWindows": 20,
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
