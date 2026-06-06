export function findActiveTrackEvent(trackEvents, ticks, hintIndex = 0) {
    if (!trackEvents?.length) {
        return { event: null, index: 0 };
    }

    const hintedEvent = trackEvents[hintIndex];
    if (hintedEvent
        && hintedEvent.StartPositionTicks <= ticks
        && hintedEvent.EndPositionTicks >= ticks
    ) {
        return { event: hintedEvent, index: hintIndex };
    }

    if (hintedEvent && hintedEvent.EndPositionTicks < ticks) {
        for (let index = hintIndex + 1; index < trackEvents.length; index++) {
            const trackEvent = trackEvents[index];
            if (trackEvent.StartPositionTicks > ticks) {
                return { event: null, index };
            }
            if (trackEvent.EndPositionTicks >= ticks) {
                return { event: trackEvent, index };
            }
        }

        return { event: null, index: trackEvents.length };
    }

    let low = 0;
    let high = trackEvents.length - 1;
    let candidate = 0;

    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (trackEvents[middle].StartPositionTicks <= ticks) {
            candidate = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    for (let index = candidate; index >= 0; index--) {
        const trackEvent = trackEvents[index];
        if (trackEvent.EndPositionTicks >= ticks) {
            return { event: trackEvent, index };
        }
    }

    return { event: null, index: candidate };
}
