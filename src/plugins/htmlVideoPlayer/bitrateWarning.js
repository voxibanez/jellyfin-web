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
