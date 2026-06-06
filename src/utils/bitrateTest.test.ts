import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jellyfin/sdk/lib/utils/api/system-api', () => ({
    getSystemApi: () => ({
        getEndpointInfo: () => Promise.resolve({ data: { IsInNetwork: true } })
    })
}));

describe('automatic bitrate detection', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does not replace a measured LAN bitrate with a 140 Mbps floor', async () => {
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => {
            const value = clock;
            clock += 1000;
            return value;
        });

        class FakeXMLHttpRequest {
            readyState = 0;
            response = { size: 0 };
            status = 200;
            timeout = 0;

            open(_method: string, url: string) {
                this.response.size = Number(new URL(url).searchParams.get('Size'));
            }

            setRequestHeader() {
                return undefined;
            }

            send() {
                this.readyState = 2;
                this.onreadystatechange?.();
                this.onload?.();
            }

            onreadystatechange?: () => void;
            onload?: () => void;
        }
        Object.defineProperty(FakeXMLHttpRequest, 'HEADERS_RECEIVED', { value: 2 });

        vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

        const { detectBitrate } = await import('./bitrateTest');
        const bitrate = await detectBitrate({
            basePath: 'https://media.example',
            authorizationHeader: 'MediaBrowser token'
        } as never, true);

        expect(bitrate).toBe(5_600_000);
        expect(bitrate).toBeLessThan(140_000_000);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
});
