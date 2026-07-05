import { describe, expect, it } from 'vitest';

import {
    formatBitrateMbps,
    shouldWarnAboutPlaybackBitrate
} from './bitrateWarning';

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

    it('formats bitrate values for display', () => {
        expect(formatBitrateMbps(7250000)).toBe('7.3');
        expect(formatBitrateMbps(39616000)).toBe('40');
    });
});
