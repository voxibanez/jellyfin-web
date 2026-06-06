export function enableAdaptiveHls(url, mediaType, mediaSource) {
    if (!url
        || mediaType !== 'Video'
        || mediaSource?.TranscodingSubProtocol !== 'hls'
        || mediaSource?.LiveStreamId
    ) {
        return url;
    }

    const parsedUrl = new URL(url);
    parsedUrl.searchParams.set('EnableAdaptiveBitrateStreaming', 'true');
    return parsedUrl.toString();
}
