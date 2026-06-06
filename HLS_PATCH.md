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
