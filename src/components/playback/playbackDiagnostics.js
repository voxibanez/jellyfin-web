import { getPlaybackDiagnosticsConfig } from '../../scripts/settings/webSettings';

const DB_NAME = 'jellyfin-playback-diagnostics';
const DB_VERSION = 2;
const RUN_STORE_NAME = 'runs';
const CHUNK_STORE_NAME = 'chunks';
const activeRuns = new WeakMap();
const SENSITIVE_KEY_PATTERN = /api[-_]?key|token|authorization|deviceid|password|secret|sessionid/i;
const DANGEROUS_HLS_FIELDS = new Set([
    'fragments',
    'partList',
    'url',
    'base',
    'relurl',
    '_url',
    'data',
    '_data',
    'loader',
    'keyLoader',
    'initSegment',
    'encryptedFragments',
    'variableList'
]);
const COMPACT_HLS_EVENTS = new Set([
    'hls.fragmentLoading',
    'hls.fragmentLoaded',
    'hls.fragmentBuffered',
    'hls.levelLoading',
    'hls.levelLoaded',
    'hls.manifestParsed'
]);
const INCIDENT_EVENT_TYPES = new Set([
    'media.waiting',
    'media.stalled',
    'media.error',
    'hls.error'
]);

function parseIso(value) {
    return Date.parse(value) || 0;
}

function estimateJsonBytes(value) {
    return new Blob([ JSON.stringify(value) ]).size;
}

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

export function sanitizeDiagnosticValue(value, depth = 0) {
    if (value === null || value === undefined) {
        return value ?? null;
    }

    if (typeof value === 'string') {
        return value.includes('://') || value.includes('?') ?
            redactUrl(value) :
            value;
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (depth >= 4) {
        return '[truncated]';
    }

    if (Array.isArray(value)) {
        return value.slice(0, 20).map(item => sanitizeDiagnosticValue(item, depth + 1));
    }

    return Object.entries(value).reduce((result, [ key, item ]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            result[key] = '[redacted]';
        } else if (DANGEROUS_HLS_FIELDS.has(key)) {
            result[key] = '[omitted]';
        } else {
            result[key] = sanitizeDiagnosticValue(item, depth + 1);
        }

        return result;
    }, {});
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

function compactSample(sample) {
    return {
        ts: sample.ts,
        currentTime: sample.currentTime,
        duration: sample.duration,
        forwardBufferSeconds: sample.forwardBufferSeconds,
        readyState: sample.readyState,
        networkState: sample.networkState,
        paused: sample.paused,
        seeking: sample.seeking,
        playbackRate: sample.playbackRate,
        droppedVideoFrames: sample.droppedVideoFrames,
        totalVideoFrames: sample.totalVideoFrames
    };
}

function pushRing(buffer, entry, windowSeconds) {
    buffer.push(entry);
    const cutoff = parseIso(entry.ts) - (windowSeconds * 1000);
    while (buffer.length && parseIso(buffer[0].ts) < cutoff) {
        buffer.shift();
    }
}

function shouldKeepCompactEvent(event) {
    return INCIDENT_EVENT_TYPES.has(event.type)
        || event.type === 'media.playing'
        || event.type === 'media.canplay'
        || event.type === 'media.pause'
        || event.type === 'media.play'
        || event.type === 'media.seeking'
        || event.type === 'media.seeked'
        || event.type === 'media.ended'
        || event.statusCode >= 400
        || event.fatal
        || event.delayed;
}

function shouldKeepCompactSample(sample) {
    return !sample.paused
        && Number.isFinite(sample.forwardBufferSeconds)
        && sample.forwardBufferSeconds <= 2;
}

function markIncident(state, event) {
    if (!state.ready || state.run.incidentCount >= state.config.maxIncidentWindows) {
        return;
    }

    const incidentAt = parseIso(event.ts);
    const existing = state.incidentWindows.find(window => incidentAt >= window.startMs && incidentAt <= window.endMs);
    if (existing) {
        existing.endMs = Math.max(existing.endMs, incidentAt + (state.config.postIncidentWindowSeconds * 1000));
        existing.triggers.push({
            ts: event.ts,
            type: event.type,
            statusCode: event.statusCode ?? null,
            details: event.details ?? null
        });
        return;
    }

    const window = {
        id: createId(),
        startMs: incidentAt - (state.config.preIncidentWindowSeconds * 1000),
        endMs: incidentAt + (state.config.postIncidentWindowSeconds * 1000),
        triggers: [{
            ts: event.ts,
            type: event.type,
            statusCode: event.statusCode ?? null,
            details: event.details ?? null
        }]
    };
    state.incidentWindows.push(window);
    state.run.incidentCount++;
    state.run.hasIncident = true;
    state.pendingEvents.push(...state.recentEvents.filter(recent => parseIso(recent.ts) >= window.startMs));
    state.pendingSamples.push(...state.recentSamples.filter(recent => parseIso(recent.ts) >= window.startMs));
}

function shouldTriggerIncident(event) {
    return INCIDENT_EVENT_TYPES.has(event.type)
        || event.statusCode >= 400
        || event.fatal
        || event.delayed
        || (event.type === 'hls.error' && event.details === 'bufferStalledError');
}

function recordSummaryEvent(run, event) {
    const summary = run.summary;
    summary.eventCounts[event.type] = (summary.eventCounts[event.type] || 0) + 1;

    if (event.type === 'media.waiting') {
        summary.waitingEvents++;
    }
    if (event.type === 'media.stalled') {
        summary.stalledEvents++;
    }
    if (event.type === 'hls.error') {
        summary.hlsErrors++;
    }
    if (event.statusCode >= 400) {
        summary.httpErrors++;
    }
    if (event.delayed) {
        summary.slowSegments++;
    }
}

function addEvent(state, type, details = {}) {
    const event = {
        ts: nowIso(),
        type,
        ...sanitizeDiagnosticValue(details)
    };

    if (!state.ready) {
        if (!state.cancelled && state.pendingEvents.length < 100) {
            state.pendingEvents.push(event);
        }
        return;
    }

    pushRing(state.recentEvents, event, state.config.preIncidentWindowSeconds);
    recordSummaryEvent(state.run, event);

    if (shouldKeepCompactEvent(event) && state.run.eventCount < state.config.maxEventsPerRun) {
        state.pendingEvents.push(event);
        state.run.eventCount++;
    }

    if (shouldTriggerIncident(event)) {
        markIncident(state, event);
    }
}

function recordSample(state, sample) {
    if (!state.ready) {
        return;
    }

    const compact = compactSample(sample);
    pushRing(state.recentSamples, compact, state.config.preIncidentWindowSeconds);
    updateSampleSummary(state.run, compact);

    if (shouldKeepCompactSample(compact) && state.run.sampleCount < state.config.maxSamplesPerRun) {
        state.pendingSamples.push(compact);
        state.run.sampleCount++;
    }

    if (
        !compact.paused
        && !compact.seeking
        && Number.isFinite(compact.forwardBufferSeconds)
        && compact.forwardBufferSeconds < 1
    ) {
        markIncident(state, {
            ...compact,
            type: 'sample.lowBuffer'
        });
    }
}

function hlsEventDetails(data = {}) {
    const stats = data.stats || data.frag?.stats || {};

    const details = {
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

    const loadSeconds = Number.isFinite(details.loadStartMs) && Number.isFinite(details.loadEndMs) ?
        (details.loadEndMs - details.loadStartMs) / 1000 :
        null;
    details.loadSeconds = loadSeconds;
    details.delayed = Number.isFinite(loadSeconds)
        && Number.isFinite(details.duration)
        && details.duration > 0
        && loadSeconds > details.duration;

    return details;
}

function metadata(instance, transport) {
    const options = instance._currentPlayOptions || {};
    const mediaSource = options.mediaSource || {};

    return {
        transport,
        serverId: options.item?.ServerId || null,
        itemId: options.item?.Id || null,
        itemName: options.item?.Name || null,
        mediaSourceId: mediaSource.Id || null,
        playMethod: options.playMethod || null,
        playSessionId: options.playSessionId || null,
        container: mediaSource.Container || null,
        url: redactUrl(options.url),
        userAgent: globalThis.navigator?.userAgent || null,
        selectedBitrate: options.maxBitrate || null
    };
}

function createSummary() {
    return {
        eventCounts: {},
        waitingEvents: 0,
        stalledEvents: 0,
        hlsErrors: 0,
        httpErrors: 0,
        slowSegments: 0,
        samples: 0,
        minimumForwardBufferSeconds: null,
        averageForwardBufferSeconds: null,
        maximumForwardBufferSeconds: null,
        firstDroppedVideoFrames: null,
        lastDroppedVideoFrames: null,
        droppedVideoFrames: null,
        estimatedBytes: 0
    };
}

function updateSampleSummary(run, sample) {
    const summary = run.summary;
    summary.samples++;

    if (Number.isFinite(sample.forwardBufferSeconds)) {
        summary.minimumForwardBufferSeconds = summary.minimumForwardBufferSeconds === null ?
            sample.forwardBufferSeconds :
            Math.min(summary.minimumForwardBufferSeconds, sample.forwardBufferSeconds);
        summary.maximumForwardBufferSeconds = summary.maximumForwardBufferSeconds === null ?
            sample.forwardBufferSeconds :
            Math.max(summary.maximumForwardBufferSeconds, sample.forwardBufferSeconds);

        const previousAverage = summary.averageForwardBufferSeconds || 0;
        summary.averageForwardBufferSeconds = previousAverage + ((sample.forwardBufferSeconds - previousAverage) / summary.samples);
    }

    if (Number.isFinite(sample.droppedVideoFrames)) {
        if (summary.firstDroppedVideoFrames === null) {
            summary.firstDroppedVideoFrames = sample.droppedVideoFrames;
        }
        summary.lastDroppedVideoFrames = sample.droppedVideoFrames;
        summary.droppedVideoFrames = Math.max(0, summary.lastDroppedVideoFrames - summary.firstDroppedVideoFrames);
    }
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

function trimTrailingSlashes(value) {
    let end = value.length;

    while (end > 0 && value[end - 1] === '/') {
        end--;
    }

    return value.slice(0, end);
}

async function reportRun(run, config) {
    if (!config.reportUrl || !config.uploadIncidentDiagnostics || !run.hasIncident) {
        return;
    }

    try {
        const { ServerConnections } = await import('../../lib/jellyfin-apiclient');
        const authorizationHeader = run.metadata?.serverId ?
            ServerConnections.getApiClient(run.metadata.serverId)?.authorizationHeader :
            ServerConnections.currentApiClient()?.authorizationHeader;

        if (!authorizationHeader) {
            throw new Error('missing Jellyfin authorization header');
        }

        const reportBaseUrl = trimTrailingSlashes(config.reportUrl);
        const initResponse = await fetch(`${reportBaseUrl}/v1/uploads/init`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Authorization': authorizationHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                runId: run.id,
                itemId: run.metadata?.itemId || null,
                playSessionId: run.metadata?.playSessionId || null,
                startedAt: run.startedAt,
                endedAt: run.endedAt
            })
        });

        if (!initResponse.ok) {
            throw new Error(`upload init failed: ${initResponse.status}`);
        }

        const upload = await initResponse.json();
        const payload = new Blob([ JSON.stringify(sanitizeDiagnosticValue(run)) ], { type: 'application/json' });
        const CompressionStreamCtor = globalThis['CompressionStream'];
        const compressed = typeof CompressionStreamCtor === 'function' ?
            await new Response(payload.stream().pipeThrough(new CompressionStreamCtor('gzip'))).blob() :
            payload;

        if (compressed.size > config.maxCompressedUploadBytes) {
            throw new Error(`diagnostics upload exceeds ${config.maxCompressedUploadBytes} bytes`);
        }

        const fallbackUploadPath = `/v1/uploads/${upload.uploadId}`;
        const uploadPath = upload.uploadUrl || fallbackUploadPath;
        const uploadUrl = uploadPath.startsWith('http') ? uploadPath : `${reportBaseUrl}${uploadPath}`;
        const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Authorization': `Bearer ${upload.token}`,
                'Content-Type': 'application/json',
                'Content-Encoding': compressed === payload ? 'identity' : 'gzip'
            },
            body: compressed
        });

        if (!uploadResponse.ok) {
            throw new Error(`upload failed: ${uploadResponse.status}`);
        }
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
                const estimatedBytes = estimateJsonBytes({ events, samples });
                if (state.run.summary.estimatedBytes + estimatedBytes > state.config.maxLocalRunBytes) {
                    state.run.summary.truncated = true;
                    return persistRun(state.run);
                }

                state.run.summary.estimatedBytes += estimatedBytes;
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
        mediaListeners: [],
        recentEvents: [],
        recentSamples: [],
        incidentWindows: []
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
        sampleCount: 0,
        incidentCount: 0,
        hasIncident: false,
        incidentWindows: [],
        summary: createSummary()
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

    const sample = () => recordSample(state, mediaSample(media));
    sample();
    state.sampleTimer = setInterval(sample, config.sampleIntervalMs);
    state.flushTimer = setInterval(() => flushPlaybackDiagnostics(state), config.flushIntervalMs);

    await persistRun(state.run);
    await prune(config);
}

export function recordHlsDiagnostic(instance, type, data) {
    const state = activeRuns.get(instance);
    if (state) {
        const eventType = `hls.${type}`;
        if (COMPACT_HLS_EVENTS.has(eventType) || eventType === 'hls.error') {
            addEvent(state, eventType, hlsEventDetails(data));
        }
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

    const summary = {
        ...(run.summary || {}),
        waitingEvents: run.events.filter(event => event.type === 'media.waiting').length,
        stalledEvents: run.events.filter(event => event.type === 'media.stalled').length,
        hlsErrors: run.events.filter(event => event.type === 'hls.error').length,
        httpErrors: run.events.filter(event => event.type === 'hls.error' && event.statusCode >= 400).length,
        minimumForwardBufferSeconds: bufferCount ? bufferMinimum : run.summary?.minimumForwardBufferSeconds ?? null,
        averageForwardBufferSeconds: bufferCount ? bufferTotal / bufferCount : run.summary?.averageForwardBufferSeconds ?? null,
        maximumForwardBufferSeconds: bufferCount ? bufferMaximum : run.summary?.maximumForwardBufferSeconds ?? null,
        droppedVideoFrames: firstDroppedFrames !== null && lastDroppedFrames !== null ?
            Math.max(0, lastDroppedFrames - firstDroppedFrames) :
            run.summary?.droppedVideoFrames ?? null
    };

    delete summary.firstDroppedVideoFrames;
    delete summary.lastDroppedVideoFrames;
    return summary;
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
    state.run.incidentWindows = state.incidentWindows.map(window => ({
        id: window.id,
        startedAt: new Date(window.startMs).toISOString(),
        endedAt: new Date(window.endMs).toISOString(),
        triggers: window.triggers
    }));
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
