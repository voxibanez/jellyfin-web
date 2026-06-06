export async function changeStreamWithEncodingCleanup({
    playSessionId,
    setSource,
    stopActiveEncodings,
    onCleanupError
}) {
    if (playSessionId) {
        try {
            await stopActiveEncodings(playSessionId);
        } catch (error) {
            onCleanupError(error, 'before');
        }
    }

    try {
        return await setSource();
    } finally {
        if (playSessionId) {
            stopActiveEncodings(playSessionId).catch(error => {
                onCleanupError(error, 'after');
            });
        }
    }
}
