import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaError } from 'types/mediaError';
import Events from '../utils/events';
import { bindEventsToHlsPlayer } from './htmlMediaHelper';

describe('bindEventsToHlsPlayer', () => {
    let handlers;
    let hls;
    let elem;
    let instance;

    beforeEach(() => {
        globalThis.Hls = {
            Events: {
                ERROR: 'error'
            },
            ErrorTypes: {}
        };
        globalThis.Hls.Events.MANIFEST_PARSED = 'manifestParsed';
        globalThis.Hls.ErrorTypes.MEDIA_ERROR = 'mediaError';
        globalThis.Hls.ErrorTypes.NETWORK_ERROR = 'networkError';

        handlers = {};
        hls = {
            destroy: vi.fn(),
            on: vi.fn((event, handler) => {
                handlers[event] = handler;
            }),
            startLoad: vi.fn()
        };
        elem = {
            addEventListener: vi.fn(),
            play: vi.fn().mockResolvedValue()
        };
        instance = {};
    });

    it('preserves hls.js retries for non-fatal HTTP errors', () => {
        const reject = vi.fn();

        bindEventsToHlsPlayer(instance, hls, elem, vi.fn(), vi.fn(), reject);
        handlers.error('error', {
            type: 'networkError',
            fatal: false,
            response: { code: 500 }
        });

        expect(hls.destroy).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
    });

    it('reports a fatal HTTP error that occurs after playback starts', async () => {
        const onError = vi.fn();
        const reject = vi.fn();
        const resolve = vi.fn();
        Events.on(instance, 'error', onError);

        bindEventsToHlsPlayer(instance, hls, elem, vi.fn(), resolve, reject);
        handlers.manifestParsed();
        await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

        handlers.error('error', {
            type: 'networkError',
            fatal: true,
            response: { code: 500 }
        });

        expect(hls.destroy).toHaveBeenCalledOnce();
        expect(reject).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(
            { type: 'error' },
            { type: MediaError.SERVER_ERROR }
        );
    });

    it('rejects startup when the initial HTTP error is fatal', () => {
        const reject = vi.fn();

        bindEventsToHlsPlayer(instance, hls, elem, vi.fn(), vi.fn(), reject);
        handlers.error('error', {
            type: 'networkError',
            fatal: true,
            response: { code: 500 }
        });

        expect(hls.destroy).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(MediaError.SERVER_ERROR);
    });
});
