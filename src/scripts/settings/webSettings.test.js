import { describe, expect, it } from 'vitest';

import {
    normalizeHlsBufferConfig,
    normalizePlaybackDiagnosticsConfig,
    toHlsJsBufferConfig
} from './webSettings';

describe('HLS buffer configuration', () => {
    it('uses the diagnostic fork defaults', () => {
        expect(normalizeHlsBufferConfig({})).toEqual({
            maxBufferLength: 30,
            highBitrateMaxBufferLength: 6,
            highBitrateThreshold: 25_000_000,
            maxMaxBufferLength: 120,
            maxBufferSize: 500 * 1024 * 1024,
            backBufferLength: 60
        });
    });

    it('accepts runtime overrides from config.json', () => {
        expect(normalizeHlsBufferConfig({
            hlsBuffer: {
                maxBufferLength: 45,
                highBitrateMaxBufferLength: 10,
                highBitrateThreshold: 40_000_000,
                maxMaxBufferLength: 240,
                maxBufferSize: 1024 * 1024 * 1024,
                backBufferLength: 90
            }
        })).toEqual({
            maxBufferLength: 45,
            highBitrateMaxBufferLength: 10,
            highBitrateThreshold: 40_000_000,
            maxMaxBufferLength: 240,
            maxBufferSize: 1024 * 1024 * 1024,
            backBufferLength: 90
        });
    });

    it('rejects invalid values and keeps the ceiling above the target', () => {
        expect(normalizeHlsBufferConfig({
            hlsBuffer: {
                maxBufferLength: 180,
                maxMaxBufferLength: 30,
                maxBufferSize: -1,
                backBufferLength: Number.NaN
            }
        })).toEqual({
            maxBufferLength: 180,
            highBitrateMaxBufferLength: 6,
            highBitrateThreshold: 25_000_000,
            maxMaxBufferLength: 180,
            maxBufferSize: 500 * 1024 * 1024,
            backBufferLength: 60
        });
    });

    it('selects the conservative high-bitrate target for hls.js', () => {
        const config = normalizeHlsBufferConfig({});

        expect(toHlsJsBufferConfig(config, true)).toEqual({
            maxBufferLength: 6,
            maxMaxBufferLength: 120,
            maxBufferSize: 500 * 1024 * 1024,
            backBufferLength: 60
        });
    });
});

describe('playback diagnostics configuration', () => {
    it('is enabled by default and can be opted out', () => {
        expect(normalizePlaybackDiagnosticsConfig({}).enabled).toBe(true);
        expect(normalizePlaybackDiagnosticsConfig({
            playbackDiagnostics: { enabled: false }
        }).enabled).toBe(false);
    });

    it('does not configure server reporting by default', () => {
        expect(normalizePlaybackDiagnosticsConfig({}).reportUrl).toBeNull();
    });
});
