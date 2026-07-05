export function shouldWarnAboutPlaybackBitrate({
    selectedBitrate,
    detectedBitrate,
    isAutomaticBitrateEnabled
}) {
    return !isAutomaticBitrateEnabled
        && Number.isFinite(selectedBitrate)
        && Number.isFinite(detectedBitrate)
        && selectedBitrate > 0
        && detectedBitrate > 0
        && selectedBitrate > detectedBitrate;
}

export function formatBitrateMbps(bitrate) {
    const mbps = bitrate / 1000000;
    return mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1);
}
