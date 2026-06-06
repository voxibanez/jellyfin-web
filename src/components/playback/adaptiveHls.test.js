import { describe, expect, it } from 'vitest';

import { enableAdaptiveHls } from './adaptiveHls';

describe('adaptive HLS URL configuration', () => {
    it('requests adaptive variants for on-demand video transcodes', () => {
        const url = enableAdaptiveHls(
            'https://media.example/Videos/1/master.m3u8?VideoBitrate=10000000',
            'Video',
            { TranscodingSubProtocol: 'hls' }
        );

        expect(new URL(url).searchParams.get('EnableAdaptiveBitrateStreaming')).toBe('true');
    });

    it('does not change direct, audio, or live playback URLs', () => {
        const url = 'https://media.example/Videos/1/master.m3u8';

        expect(enableAdaptiveHls(url, 'Audio', { TranscodingSubProtocol: 'hls' })).toBe(url);
        expect(enableAdaptiveHls(url, 'Video', { TranscodingSubProtocol: 'http' })).toBe(url);
        expect(enableAdaptiveHls(url, 'Video', {
            TranscodingSubProtocol: 'hls',
            LiveStreamId: 'live'
        })).toBe(url);
    });
});
