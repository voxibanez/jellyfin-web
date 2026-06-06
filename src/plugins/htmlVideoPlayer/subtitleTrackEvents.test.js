import { describe, expect, it } from 'vitest';

import { findActiveTrackEvent } from './subtitleTrackEvents';

const events = [
    { StartPositionTicks: 10, EndPositionTicks: 20, Text: 'one' },
    { StartPositionTicks: 30, EndPositionTicks: 40, Text: 'two' },
    { StartPositionTicks: 50, EndPositionTicks: 60, Text: 'three' }
];

describe('subtitle track event lookup', () => {
    it('advances from the previous event without rescanning the track', () => {
        expect(findActiveTrackEvent(events, 35, 0)).toEqual({
            event: events[1],
            index: 1
        });
    });

    it('supports seeking backwards using binary lookup', () => {
        expect(findActiveTrackEvent(events, 15, 2)).toEqual({
            event: events[0],
            index: 0
        });
    });

    it('returns no event for a subtitle gap', () => {
        expect(findActiveTrackEvent(events, 45, 1).event).toBeNull();
    });
});
