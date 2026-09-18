export const BITRATE_STEPS = [
    120_000_000,
    80_000_000,
    60_000_000,
    40_000_000,
    20_000_000,
    15_000_000,
    10_000_000,
    8_000_000,
    4_000_000,
    2_000_000,
    1_000_000,
    500_000
];

export function nextLowerBitrate(currentBitrate) {
    const current = Number(currentBitrate) || 0;
    if (current <= BITRATE_STEPS[BITRATE_STEPS.length - 1]) {
        return null;
    }

    return BITRATE_STEPS.find(step => step < current) || null;
}

export function nextHigherBitrate(currentBitrate, ceiling = Number.POSITIVE_INFINITY) {
    const current = Number(currentBitrate) || 0;
    const max = Number(ceiling) || Number.POSITIVE_INFINITY;
    const higher = [ ...BITRATE_STEPS ].reverse().find(step => step > current && step <= max);
    return higher || null;
}

/** Highest ladder rung that fits under measured throughput with headroom. */
export function bitrateForThroughput(throughputBps, currentBitrate, headroom = 0.7) {
    const budget = (Number(throughputBps) || 0) * headroom;
    if (budget <= 0) {
        return nextLowerBitrate(currentBitrate);
    }

    const fit = BITRATE_STEPS.find(step => step <= budget);
    if (!fit) {
        return BITRATE_STEPS[BITRATE_STEPS.length - 1];
    }

    if (fit >= currentBitrate) {
        return nextLowerBitrate(currentBitrate);
    }

    return fit;
}

export function createStallDownshiftController({
    stallThreshold = 3,
    windowMs = 45_000,
    cooldownMs = 60_000,
    upshiftStableMs = 120_000,
    upshiftMinBufferSeconds = 20,
    throughputSamples = 8
} = {}) {
    let stalls = [];
    let lastChangeAt = 0;
    let stableSince = 0;
    const throughputs = [];

    return {
        recordFragThroughput({ loadedBytes, loadSeconds }) {
            if (loadedBytes <= 0 || loadSeconds <= 0) {
                return;
            }

            throughputs.push((loadedBytes * 8) / loadSeconds);
            if (throughputs.length > throughputSamples) {
                throughputs.shift();
            }
        },

        estimatedThroughput() {
            if (!throughputs.length) {
                return 0;
            }

            const sorted = [ ...throughputs ].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        },

        shouldDownshift(now = Date.now()) {
            stalls = stalls.filter(timestamp => now - timestamp <= windowMs);
            stalls.push(now);
            stableSince = 0;
            const cooledDown = !lastChangeAt || (now - lastChangeAt) >= cooldownMs;
            return stalls.length >= stallThreshold && cooledDown;
        },

        nextBitrate(currentBitrate) {
            const throughput = this.estimatedThroughput();
            if (throughput > 0) {
                return bitrateForThroughput(throughput, currentBitrate);
            }

            return nextLowerBitrate(currentBitrate);
        },

        markChanged(now = Date.now()) {
            lastChangeAt = now;
            stalls = [];
            stableSince = 0;
        },

        // Back-compat alias
        markDownshifted(now = Date.now()) {
            this.markChanged(now);
        },

        noteHealthyBuffer(forwardBufferSeconds, now = Date.now()) {
            if (forwardBufferSeconds < upshiftMinBufferSeconds) {
                stableSince = 0;
                return;
            }

            if (!stableSince) {
                stableSince = now;
            }
        },

        shouldUpshift(currentBitrate, ceilingBitrate, now = Date.now()) {
            // Session may have been capped before a stream recreate reset this controller.
            if (!stableSince) {
                return false;
            }

            if ((now - stableSince) < upshiftStableMs) {
                return false;
            }

            if (lastChangeAt && (now - lastChangeAt) < cooldownMs) {
                return false;
            }

            const next = nextHigherBitrate(currentBitrate, ceilingBitrate);
            if (!next) {
                return false;
            }

            const throughput = this.estimatedThroughput();
            if (throughput > 0 && throughput * 0.85 < next) {
                return false;
            }

            return true;
        },

        nextUpshiftBitrate(currentBitrate, ceilingBitrate) {
            return nextHigherBitrate(currentBitrate, ceilingBitrate);
        }
    };
}
