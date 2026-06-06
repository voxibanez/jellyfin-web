import { describe, expect, it, vi } from 'vitest';

import { changeStreamWithEncodingCleanup } from './streamChange';

describe('stream change encoding cleanup', () => {
    it('still changes source when stopping the previous encoding fails', async () => {
        const setSource = vi.fn().mockResolvedValue('started');
        const stopActiveEncodings = vi.fn()
            .mockRejectedValueOnce(new Error('server unavailable'))
            .mockResolvedValueOnce();
        const onCleanupError = vi.fn();

        await expect(changeStreamWithEncodingCleanup({
            playSessionId: 'session',
            setSource,
            stopActiveEncodings,
            onCleanupError
        })).resolves.toBe('started');

        expect(setSource).toHaveBeenCalledOnce();
        expect(stopActiveEncodings).toHaveBeenCalledTimes(2);
        expect(onCleanupError).toHaveBeenCalledWith(expect.any(Error), 'before');
    });

    it('attempts cleanup after a source change failure', async () => {
        const setSource = vi.fn().mockRejectedValue(new Error('play failed'));
        const stopActiveEncodings = vi.fn().mockResolvedValue();

        await expect(changeStreamWithEncodingCleanup({
            playSessionId: 'session',
            setSource,
            stopActiveEncodings,
            onCleanupError: vi.fn()
        })).rejects.toThrow('play failed');

        expect(stopActiveEncodings).toHaveBeenCalledTimes(2);
    });
});
