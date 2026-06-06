import { getPlaybackDiagnosticsConfig } from '../../scripts/settings/webSettings';

const DB_NAME = 'jellyfin-playback-diagnostics';
const DB_VERSION = 2;
const RUN_STORE_NAME = 'runs';
const CHUNK_STORE_NAME = 'chunks';
const activeRuns = new WeakMap();

function nowIso() {
    return new Date().toISOString();
}

function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function redactUrl(value) {
    if (!value || typeof value !== 'string') {
        return value || null;
    }

    try {
        const url = new URL(value, globalThis.location?.href);
        return `${url.origin}${url.pathname}`;
    } catch {
        return value.split('?')[0].split('#')[0];
    }
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB is unavailable'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(RUN_STORE_NAME)) {
                const store = database.createObjectStore(RUN_STORE_NAME, { keyPath: 'id' });
                store.createIndex('startedAt', 'startedAt');
            }
            if (!database.objectStoreNames.contains(CHUNK_STORE_NAME)) {
                const store = database.createObjectStore(CHUNK_STORE_NAME, { keyPath: 'id' });
                store.createIndex('runId', 'runId');
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
}

async function withStore(storeName, mode, callback) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;

        try {
            result = callback(store);
        } catch (error) {
            database.close();
            reject(error);
            return;
        }

        transaction.oncomplete = () => {
            database.close();
            resolve(result);
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

async function persistRun(run) {
    run.updatedAt = nowIso();
    await withStore(RUN_STORE_NAME, 'readwrite', store => store.put(run));
}

async function persistChunkAndRun(chunk, run) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction([ RUN_STORE_NAME, CHUNK_STORE_NAME ], 'readwrite');
        transaction.objectStore(CHUNK_STORE_NAME).put(chunk);
        run.updatedAt = nowIso();
        transaction.objectStore(RUN_STORE_NAME).put(run);
        transaction.oncomplete = () => {
            database.close();
            resolve();
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

async function getAllRuns() {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(RUN_STORE_NAME, 'readonly');
        const request = transaction.objectStore(RUN_STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
    });
}

async function getRunChunks(runId) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(CHUNK_STORE_NAME, 'readonly');
        const request = transaction.objectStore(CHUNK_STORE_NAME).index('runId').getAll(runId);
        request.onsuccess = () => resolve((request.result || []).sort((left, right) => left.sequence - right.sequence));
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
    });
}

async function deleteRun(runId) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction([ RUN_STORE_NAME, CHUNK_STORE_NAME ], 'readwrite');
        transaction.objectStore(RUN_STORE_NAME).delete(runId);

        const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);
        const cursorRequest = chunkStore.index('runId').openKeyCursor(IDBKeyRange.only(runId));
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
                chunkStore.delete(cursor.primaryKey);
                cursor.continue();
            }
        };
        transaction.oncomplete = () => {
            database.close();
            resolve();
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

async function prune(config) {
    const runs = await getAllRuns();
    const cutoff = Date.now() - (config.maxAgeDays * 24 * 60 * 60 * 1000);
    const sorted = runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    const removeIds = sorted
        .filter((run, index) => index >= config.maxRuns || Date.parse(run.startedAt) < cutoff)
        .map(run => run.id);

    if (!removeIds.length) {
        return;
    }

    await Promise.all(removeIds.map(deleteRun));
}

function bufferedRanges(media) {
    const ranges = [];

    for (let index = 0; index < (media.buffered?.length || 0); index++) {
        ranges.push({
            start: media.buffered.start(index),
            end: media.buffered.end(index)
        });
    }

    return ranges;
}

export function getForwardBufferSeconds(media) {
    const currentTime = Number(media.currentTime) || 0;

    for (const range of bufferedRanges(media)) {
        if (currentTime >= range.start && currentTime <= range.end) {
            return Math.max(0, range.end - currentTime);
        }
    }

    return 0;
}

function mediaSample(media) {
    const quality = media.getVideoPlaybackQuality?.();

    return {
        ts: nowIso(),
        currentTime: Number(media.currentTime) || 0,
        duration: Number.isFinite(media.duration) ? media.duration : null,
        forwardBufferSeconds: getForwardBufferSeconds(media),
        buffered: bufferedRanges(media),
        readyState: media.readyState,
        networkState: media.networkState,
        paused: media.paused,
        seeking: media.seeking,
        playbackRate: media.playbackRate,
        droppedVideoFrames: quality?.droppedVideoFrames ?? null,
        totalVideoFrames: quality?.totalVideoFrames ?? null
    };
}

function addEvent(state, type, details = {}) {
    const event = {
        ts: nowIso(),
        type,
        ...details
    };

    if (!state.ready) {
        if (!state.cancelled && state.pendingEvents.length < 100) {
            state.pendingEvents.push(event);
        }
        return;
    }

    if (state.run.eventCount >= state.config.maxEventsPerRun) {
        return;
    }

    state.pendingEvents.push(event);
    state.run.eventCount++;
}

function hlsEventDetails(data = {}) {
    const stats = data.stats || data.frag?.stats || {};

    return {
        fatal: !!data.fatal,
        errorType: data.type || null,
        details: data.details || null,
        statusCode: data.response?.code ?? null,
        url: redactUrl(data.response?.url || data.frag?.url),
        fragment: data.frag?.sn ?? null,
        level: data.frag?.level ?? null,
        duration: data.frag?.duration ?? null,
        loadedBytes: stats.loaded ?? null,
        totalBytes: stats.total ?? null,
        loadStartMs: stats.loading?.start ?? null,
        firstByteMs: stats.loading?.first ?? null,
        loadEndMs: stats.loading?.end ?? null,
        retryAction: data.errorAction?.action ?? null,
        retryCount: data.errorAction?.retryCount ?? null
    };
}

function metadata(instance, transport) {
    const options = instance._currentPlayOptions || {};
    const mediaSource = options.mediaSource || {};

    return {
        transport,
        itemId: options.item?.Id || null,
        itemName: options.item?.Name || null,
        mediaSourceId: mediaSource.Id || null,
        playMethod: options.playMethod || null,
        playSessionId: options.playSessionId || null,
        container: mediaSource.Container || null,
        url: redactUrl(options.url),
        userAgent: globalThis.navigator?.userAgent || null
    };
}

export function combineRunWithChunks(run, chunks) {
    const events = Array.isArray(run.events) ? [ ...run.events ] : [];
    const samples = Array.isArray(run.samples) ? [ ...run.samples ] : [];

    chunks.forEach(chunk => {
        events.push(...(chunk.events || []));
        samples.push(...(chunk.samples || []));
    });

    return {
        ...run,
        events,
        samples
    };
}

async function loadCompleteRun(run) {
    if (Array.isArray(run.events) && Array.isArray(run.samples)) {
        return run;
    }

    return combineRunWithChunks(run, await getRunChunks(run.id));
}

async function reportRun(run, config) {
    if (!config.reportUrl) {
        return;
    }

    try {
        await fetch(config.reportUrl, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(run)
        });
    } catch (error) {
        console.warn('[playbackDiagnostics] failed to report diagnostics:', error);
    }
}

function flushPlaybackDiagnostics(state) {
    state.flushPromise = state.flushPromise.then(async () => {
        if (!state.ready) {
            return;
        }

        const events = state.pendingEvents.splice(0);
        const samples = state.pendingSamples.splice(0);

        try {
            if (events.length || samples.length) {
                const sequence = state.nextChunkSequence;
                await persistChunkAndRun({
                    id: `${state.run.id}:${sequence}`,
                    runId: state.run.id,
                    sequence,
                    events,
                    samples
                }, state.run);
                state.nextChunkSequence++;
            } else {
                await persistRun(state.run);
            }
        } catch (error) {
            state.pendingEvents.unshift(...events);
            state.pendingSamples.unshift(...samples);
            throw error;
        }
    }).catch(error => {
        console.warn('[playbackDiagnostics] failed to persist diagnostics:', error);
    });

    return state.flushPromise;
}

export async function startPlaybackDiagnostics(instance, media, transport = 'media') {
    if (activeRuns.has(instance)) {
        return;
    }

    const state = {
        ready: false,
        cancelled: false,
        config: null,
        run: null,
        media,
        pendingEvents: [],
        pendingSamples: [],
        nextChunkSequence: 0,
        flushPromise: Promise.resolve(),
        sampleTimer: null,
        flushTimer: null,
        mediaListeners: []
    };
    activeRuns.set(instance, state);

    const config = await getPlaybackDiagnosticsConfig();
    state.config = config;

    if (state.cancelled || !config.enabled) {
        if (activeRuns.get(instance) === state) {
            activeRuns.delete(instance);
        }
        return;
    }

    state.run = {
        id: createId(),
        version: 1,
        startedAt: nowIso(),
        updatedAt: nowIso(),
        endedAt: null,
        status: 'active',
        metadata: metadata(instance, transport),
        eventCount: 0,
        sampleCount: 0
    };
    state.ready = true;
    state.pendingEvents = state.pendingEvents.slice(0, config.maxEventsPerRun);
    state.run.eventCount = state.pendingEvents.length;

    const mediaEvents = [ 'waiting', 'stalled', 'playing', 'canplay', 'error', 'seeking', 'seeked', 'pause', 'play', 'ended' ];
    mediaEvents.forEach(type => {
        const listener = () => addEvent(state, `media.${type}`, {
            currentTime: Number(media.currentTime) || 0,
            forwardBufferSeconds: getForwardBufferSeconds(media)
        });
        media.addEventListener(type, listener);
        state.mediaListeners.push({ type, listener });
    });

    const sample = () => {
        if (state.run.sampleCount < config.maxSamplesPerRun) {
            state.pendingSamples.push(mediaSample(media));
            state.run.sampleCount++;
        }
    };
    sample();
    state.sampleTimer = setInterval(sample, config.sampleIntervalMs);
    state.flushTimer = setInterval(() => flushPlaybackDiagnostics(state), config.flushIntervalMs);

    await persistRun(state.run);
    await prune(config);
}

export function recordHlsDiagnostic(instance, type, data) {
    const state = activeRuns.get(instance);
    if (state) {
        addEvent(state, `hls.${type}`, hlsEventDetails(data));
    }
}

export function summarizePlaybackRun(run) {
    let bufferCount = 0;
    let bufferTotal = 0;
    let bufferMinimum = Number.POSITIVE_INFINITY;
    let bufferMaximum = Number.NEGATIVE_INFINITY;
    let firstDroppedFrames = null;
    let lastDroppedFrames = null;

    run.samples.forEach(sample => {
        if (Number.isFinite(sample.forwardBufferSeconds)) {
            bufferCount++;
            bufferTotal += sample.forwardBufferSeconds;
            bufferMinimum = Math.min(bufferMinimum, sample.forwardBufferSeconds);
            bufferMaximum = Math.max(bufferMaximum, sample.forwardBufferSeconds);
        }

        if (Number.isFinite(sample.droppedVideoFrames)) {
            if (firstDroppedFrames === null) {
                firstDroppedFrames = sample.droppedVideoFrames;
            }
            lastDroppedFrames = sample.droppedVideoFrames;
        }
    });

    return {
        waitingEvents: run.events.filter(event => event.type === 'media.waiting').length,
        stalledEvents: run.events.filter(event => event.type === 'media.stalled').length,
        hlsErrors: run.events.filter(event => event.type === 'hls.error').length,
        httpErrors: run.events.filter(event => event.type === 'hls.error' && event.statusCode >= 400).length,
        minimumForwardBufferSeconds: bufferCount ? bufferMinimum : null,
        averageForwardBufferSeconds: bufferCount ? bufferTotal / bufferCount : null,
        maximumForwardBufferSeconds: bufferCount ? bufferMaximum : null,
        droppedVideoFrames: firstDroppedFrames !== null && lastDroppedFrames !== null ?
            Math.max(0, lastDroppedFrames - firstDroppedFrames) :
            null
    };
}

export async function stopPlaybackDiagnostics(instance, media, status = 'stopped') {
    const state = activeRuns.get(instance);
    if (!state) {
        return;
    }

    activeRuns.delete(instance);
    state.cancelled = true;
    clearInterval(state.sampleTimer);
    clearInterval(state.flushTimer);
    const mediaElement = media || state.media;
    state.mediaListeners.forEach(({ type, listener }) => {
        mediaElement?.removeEventListener(type, listener);
    });

    if (!state.ready) {
        return;
    }

    state.run.status = status;
    state.run.endedAt = nowIso();
    await flushPlaybackDiagnostics(state);
    const completeRun = await loadCompleteRun(state.run);
    state.run.summary = summarizePlaybackRun(completeRun);
    await persistRun(state.run);
    await reportRun({ ...completeRun, summary: state.run.summary }, state.config);
}

export async function listPlaybackDiagnostics() {
    const runs = await getAllRuns();
    return runs
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .map(run => ({
            id: run.id,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            status: run.status,
            metadata: run.metadata,
            eventCount: run.eventCount ?? run.events?.length ?? 0,
            sampleCount: run.sampleCount ?? run.samples?.length ?? 0
        }));
}

export async function exportPlaybackDiagnostics(runId) {
    const runs = await getAllRuns();
    const selected = runId ? runs.filter(run => run.id === runId) : runs;
    const completeRuns = await Promise.all(selected.map(loadCompleteRun));
    const blob = new Blob([ JSON.stringify(completeRuns, null, 2) ], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jellyfin-playback-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

export async function clearPlaybackDiagnostics() {
    await Promise.all([
        withStore(RUN_STORE_NAME, 'readwrite', store => store.clear()),
        withStore(CHUNK_STORE_NAME, 'readwrite', store => store.clear())
    ]);
}

if (typeof window !== 'undefined') {
    window.JellyfinPlaybackDiagnostics = {
        list: listPlaybackDiagnostics,
        export: exportPlaybackDiagnostics,
        clear: clearPlaybackDiagnostics
    };
}
