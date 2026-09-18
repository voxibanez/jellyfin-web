import { describe, expect, it } from 'vitest';

import {
    bitrateForThroughput,
    createStallDownshiftController,
    nextHigherBitrate,
    nextLowerBitrate
} from './stallBitrateDownshift';

describe('stall bitrate downshift', () => {
    it('steps down and up the ABR ladder', () => {
        expect(nextLowerBitrate(35_000_000)).toBe(20_000_000);
        expect(nextLowerBitrate(500_000)).toBeNull();
        expect(nextHigherBitrate(8_000_000, 40_000_000)).toBe(10_000_000);
        expect(nextHigherBitrate(40_000_000, 40_000_000)).toBeNull();
    });

    it('picks a ladder rung under measured throughput', () => {
        expect(bitrateForThroughput(12_000_000, 40_000_000)).toBe(8_000_000);
        expect(bitrateForThroughput(100_000_000, 10_000_000)).toBe(8_000_000);
    });

    it('requires sustained stalls before downshifting and then cools down', () => {
        const controller = createStallDownshiftController({
            stallThreshold: 3,
            windowMs: 45_000,
            cooldownMs: 60_000
        });

        expect(controller.shouldDownshift(1_000)).toBe(false);
        expect(controller.shouldDownshift(2_000)).toBe(false);
        expect(controller.shouldDownshift(3_000)).toBe(true);

        controller.markDownshifted(3_000);
        expect(controller.shouldDownshift(4_000)).toBe(false);
        expect(controller.shouldDownshift(5_000)).toBe(false);
        expect(controller.shouldDownshift(63_001)).toBe(false);
        expect(controller.shouldDownshift(63_002)).toBe(false);
        expect(controller.shouldDownshift(63_003)).toBe(true);
    });

    it('upshifts after sustained healthy buffer and throughput headroom', () => {
        const controller = createStallDownshiftController({
            cooldownMs: 1_000,
            upshiftStableMs: 5_000,
            upshiftMinBufferSeconds: 20
        });

        controller.markChanged(1_000);
        controller.recordFragThroughput({ loadedBytes: 2_500_000, loadSeconds: 1 });
        controller.noteHealthyBuffer(25, 2_000);
        expect(controller.shouldUpshift(8_000_000, 40_000_000, 4_000)).toBe(false);
        expect(controller.shouldUpshift(8_000_000, 40_000_000, 8_000)).toBe(true);
        expect(controller.nextUpshiftBitrate(8_000_000, 40_000_000)).toBe(10_000_000);
    });
});
