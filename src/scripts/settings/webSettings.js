import DefaultConfig from '../../config.json';
import fetchLocal from '../../utils/fetchLocal.ts';

let data;

async function getConfig() {
    if (data) return Promise.resolve(data);
    try {
        const response = await fetchLocal('config.json', {
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error('network response was not ok');
        }

        data = await response.json();

        return data;
    } catch (error) {
        console.warn('failed to fetch the web config file:', error);
        data = DefaultConfig;
        return data;
    }
}

export function getIncludeCorsCredentials() {
    return getConfig()
        .then(config => !!config.includeCorsCredentials)
        .catch(error => {
            console.log('cannot get web config:', error);
            return false;
        });
}

const DEFAULT_HLS_BUFFER = Object.freeze({
    maxBufferLength: 45,
    highBitrateMaxBufferLength: 15,
    highBitrateThreshold: 25_000_000,
    maxMaxBufferLength: 120,
    maxBufferSize: 128 * 1024 * 1024,
    backBufferLength: 30
});

function positiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ?
        value :
        fallback;
}

export function normalizeHlsBufferConfig(config) {
    const configured = config?.hlsBuffer || {};
    const maxBufferLength = positiveNumber(configured.maxBufferLength, DEFAULT_HLS_BUFFER.maxBufferLength);
    const maxMaxBufferLength = Math.max(
        maxBufferLength,
        positiveNumber(configured.maxMaxBufferLength, DEFAULT_HLS_BUFFER.maxMaxBufferLength)
    );

    return {
        maxBufferLength,
        highBitrateMaxBufferLength: positiveNumber(
            configured.highBitrateMaxBufferLength,
            DEFAULT_HLS_BUFFER.highBitrateMaxBufferLength
        ),
        highBitrateThreshold: positiveNumber(
            configured.highBitrateThreshold,
            DEFAULT_HLS_BUFFER.highBitrateThreshold
        ),
        maxMaxBufferLength,
        maxBufferSize: positiveNumber(configured.maxBufferSize, DEFAULT_HLS_BUFFER.maxBufferSize),
        backBufferLength: positiveNumber(configured.backBufferLength, DEFAULT_HLS_BUFFER.backBufferLength)
    };
}

export function getHlsBufferConfig() {
    return getConfig()
        .then(normalizeHlsBufferConfig)
        .catch(error => {
            console.log('cannot get web config:', error);
            return { ...DEFAULT_HLS_BUFFER };
        });
}

export function toHlsJsBufferConfig(config, highBitrate = false) {
    return {
        maxBufferLength: highBitrate ? config.highBitrateMaxBufferLength : config.maxBufferLength,
        maxMaxBufferLength: config.maxMaxBufferLength,
        maxBufferSize: config.maxBufferSize,
        backBufferLength: config.backBufferLength
    };
}

const DEFAULT_PLAYBACK_DIAGNOSTICS = Object.freeze({
    enabled: true,
    sampleIntervalMs: 1000,
    flushIntervalMs: 30000,
    maxRuns: 20,
    maxAgeDays: 7,
    maxEventsPerRun: 50000,
    maxSamplesPerRun: 30000,
    reportUrl: null
});

export function normalizePlaybackDiagnosticsConfig(config) {
    const configured = config?.playbackDiagnostics || {};

    return {
        enabled: configured.enabled !== false,
        sampleIntervalMs: positiveNumber(configured.sampleIntervalMs, DEFAULT_PLAYBACK_DIAGNOSTICS.sampleIntervalMs),
        flushIntervalMs: positiveNumber(configured.flushIntervalMs, DEFAULT_PLAYBACK_DIAGNOSTICS.flushIntervalMs),
        maxRuns: positiveNumber(configured.maxRuns, DEFAULT_PLAYBACK_DIAGNOSTICS.maxRuns),
        maxAgeDays: positiveNumber(configured.maxAgeDays, DEFAULT_PLAYBACK_DIAGNOSTICS.maxAgeDays),
        maxEventsPerRun: positiveNumber(configured.maxEventsPerRun, DEFAULT_PLAYBACK_DIAGNOSTICS.maxEventsPerRun),
        maxSamplesPerRun: positiveNumber(configured.maxSamplesPerRun, DEFAULT_PLAYBACK_DIAGNOSTICS.maxSamplesPerRun),
        reportUrl: typeof configured.reportUrl === 'string' && configured.reportUrl ?
            configured.reportUrl :
            null
    };
}

export function getPlaybackDiagnosticsConfig() {
    return getConfig()
        .then(normalizePlaybackDiagnosticsConfig)
        .catch(error => {
            console.log('cannot get web config:', error);
            return { ...DEFAULT_PLAYBACK_DIAGNOSTICS };
        });
}

export function getMultiServer() {
    // Enable multi-server support when served by webpack
    if (__WEBPACK_SERVE__) {
        return Promise.resolve(true);
    }

    return getConfig().then(config => {
        return !!config.multiserver;
    }).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}

export function getServers() {
    return getConfig().then(config => {
        return config.servers || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

const baseDefaultTheme = {
    'name': 'Dark',
    'id': 'dark',
    'default': true
};

let internalDefaultTheme = baseDefaultTheme;

const checkDefaultTheme = (themes) => {
    if (themes) {
        const defaultTheme = themes.find((theme) => theme.default);

        if (defaultTheme) {
            internalDefaultTheme = defaultTheme;
            return;
        }
    }

    internalDefaultTheme = baseDefaultTheme;
};

export function getThemes() {
    return getConfig().then(config => {
        if (!Array.isArray(config.themes)) {
            console.error('web config is invalid, missing themes:', config);
        }
        const themes = Array.isArray(config.themes) ? config.themes : DefaultConfig.themes;
        checkDefaultTheme(themes);
        return themes;
    }).catch(error => {
        console.log('cannot get web config:', error);
        checkDefaultTheme();
        return DefaultConfig.themes;
    });
}

export const getDefaultTheme = () => internalDefaultTheme;

export function getMenuLinks() {
    return getConfig().then(config => {
        if (!config.menuLinks) {
            console.error('web config is invalid, missing menuLinks:', config);
        }
        return config.menuLinks || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

export function getPlugins() {
    return getConfig().then(config => {
        if (!config.plugins) {
            console.error('web config is invalid, missing plugins:', config);
        }
        return config.plugins || DefaultConfig.plugins;
    }).catch(error => {
        console.log('cannot get web config:', error);
        return DefaultConfig.plugins;
    });
}
