import { describe, expect, it } from 'vitest';

import { shouldWarnAboutPlaybackBitrate } from './bitrateWarning';

describe('playback bitrate warning', () => {
    it('warns when manually selected playback bitrate exceeds detected speed', () => {
        expect(shouldWarnAboutPlaybackBitrate({
            selectedBitrate: 40000000,
            detectedBitrate: 7000000,
            isAutomaticBitrateEnabled: false
        })).toBe(true);
    });

    it('does not warn for automatic quality', () => {
        expect(shouldWarnAboutPlaybackBitrate({
            selectedBitrate: 40000000,
            detectedBitrate: 7000000,
            isAutomaticBitrateEnabled: true
        })).toBe(false);
    });

    it('does not warn when detected speed can sustain the selected bitrate', () => {
        expect(shouldWarnAboutPlaybackBitrate({
            selectedBitrate: 4000000,
            detectedBitrate: 7000000,
            isAutomaticBitrateEnabled: false
        })).toBe(false);
    });
});
