import { describe, expect, it } from 'vitest';

import {
    getForwardBufferSeconds,
    redactUrl,
    summarizePlaybackRun
} from './playbackDiagnostics';

function timeRanges(ranges) {
    return {
        length: ranges.length,
        start: index => ranges[index][0],
        end: index => ranges[index][1]
    };
}

describe('playback diagnostics', () => {
    it('removes secrets and query parameters from URLs', () => {
        expect(redactUrl('https://media.example/Videos/1/stream.m3u8?api_key=secret&token=secret'))
            .toBe('https://media.example/Videos/1/stream.m3u8');
    });

    it('calculates forward buffer in the active range', () => {
        expect(getForwardBufferSeconds({
            currentTime: 12,
            buffered: timeRanges([[ 0, 10 ], [ 11, 42 ]])
        })).toBe(30);
    });

    it('returns zero when the current position is not buffered', () => {
        expect(getForwardBufferSeconds({
            currentTime: 20,
            buffered: timeRanges([[ 0, 10 ], [ 30, 40 ]])
        })).toBe(0);
    });

    it('summarizes stalls, HTTP errors, buffer depth, and dropped frames', () => {
        expect(summarizePlaybackRun({
            events: [
                { type: 'media.waiting' },
                { type: 'media.stalled' },
                { type: 'hls.error', statusCode: 500 }
            ],
            samples: [
                { forwardBufferSeconds: 20, droppedVideoFrames: 2 },
                { forwardBufferSeconds: 0, droppedVideoFrames: 5 }
            ]
        })).toEqual({
            waitingEvents: 1,
            stalledEvents: 1,
            hlsErrors: 1,
            httpErrors: 1,
            minimumForwardBufferSeconds: 0,
            averageForwardBufferSeconds: 10,
            maximumForwardBufferSeconds: 20,
            droppedVideoFrames: 3
        });
    });
});
