export function getPlaybackBitrate(mediaSource, playbackUrl) {
    if (playbackUrl) {
        const parameters = new URL(playbackUrl, globalThis.location?.href || 'http://localhost').searchParams;
        const transcodingBitrate = [ 'VideoBitrate', 'AudioBitrate' ]
            .reduce((total, name) => total + (Number(parameters.get(name)) || 0), 0);

        if (transcodingBitrate > 0) {
            return transcodingBitrate;
        }
    }

    if (Number.isFinite(mediaSource?.Bitrate) && mediaSource.Bitrate > 0) {
        return mediaSource.Bitrate;
    }

    return (mediaSource?.MediaStreams || [])
        .filter(stream => stream.Type === 'Video' || stream.Type === 'Audio')
        .reduce((total, stream) => total + (Number(stream.BitRate) || 0), 0);
}
