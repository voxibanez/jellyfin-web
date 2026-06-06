import { describe, expect, it } from 'vitest';

import { getPlaybackBitrate } from './hlsPlaybackConfig';

describe('HLS playback configuration', () => {
    it('uses the media source bitrate instead of the user bitrate ceiling', () => {
        expect(getPlaybackBitrate({
            Bitrate: 8_000_000,
            MediaStreams: [{ Type: 'Video', BitRate: 100_000_000 }]
        })).toBe(8_000_000);
    });

    it('prefers the delivered transcode bitrate from the playback URL', () => {
        expect(getPlaybackBitrate({
            Bitrate: 100_000_000
        }, 'https://media.example/master.m3u8?VideoBitrate=5000000&AudioBitrate=384000'))
            .toBe(5_384_000);
    });

    it('falls back to the sum of audio and video stream bitrates', () => {
        expect(getPlaybackBitrate({
            MediaStreams: [
                { Type: 'Video', BitRate: 12_000_000 },
                { Type: 'Audio', BitRate: 384_000 },
                { Type: 'Subtitle', BitRate: 50_000 }
            ]
        })).toBe(12_384_000);
    });
});
