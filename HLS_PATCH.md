# HLS recovery and buffering

This fork changes Jellyfin Web's hls.js behavior in two areas:

- Non-fatal HTTP segment errors are left to hls.js's configured retry policy.
- Forward buffering can be controlled at runtime through `config.json`.

The default buffer configuration is:

```json
{
  "hlsBuffer": {
    "maxBufferLength": 30,
    "highBitrateMaxBufferLength": 6,
    "highBitrateThreshold": 25000000,
    "maxMaxBufferLength": 120,
    "maxBufferSize": 524288000,
    "backBufferLength": 60
  }
}
```

`maxBufferLength` is the minimum forward target. For Chrome, Edge, and
Firefox, `highBitrateMaxBufferLength` is used when Jellyfin's configured
streaming bitrate reaches `highBitrateThreshold`.

`maxMaxBufferLength` is the forward-buffer time ceiling and `maxBufferSize`
is the byte budget. hls.js uses both, so a 120-second ceiling does not force a
120-second buffer for very high-bitrate media.

After building, these values can be changed in the deployed `config.json`
without rebuilding the JavaScript bundles.

## Playback diagnostics

Client playback diagnostics are enabled by default and stored in IndexedDB in
the browser profile. Records contain one-second media samples, forward buffer
depth, media events, dropped frames, and HLS fragment timing and errors. URL
query strings are removed before data is stored.

Retention and sampling are controlled in `config.json`:

```json
{
  "playbackDiagnostics": {
    "enabled": true,
    "sampleIntervalMs": 1000,
    "flushIntervalMs": 30000,
    "maxRuns": 20,
    "maxAgeDays": 7,
    "maxEventsPerRun": 10000,
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
