export interface Theme {
    name: string
    default?: boolean;
    id: string
    color: string
}

export interface MenuLink {
    name: string
    icon?: string
    url: string
}

export interface HlsBufferConfig {
    maxBufferLength?: number
    highBitrateMaxBufferLength?: number
    highBitrateThreshold?: number
    maxMaxBufferLength?: number
    maxBufferSize?: number
    backBufferLength?: number
}

export interface PlaybackDiagnosticsConfig {
    enabled?: boolean
    sampleIntervalMs?: number
    flushIntervalMs?: number
    maxRuns?: number
    maxAgeDays?: number
    maxEventsPerRun?: number
    maxSamplesPerRun?: number
    reportUrl?: string | null
}

export interface WebConfig {
    includeCorsCredentials?: boolean
    hlsBuffer?: HlsBufferConfig
    playbackDiagnostics?: PlaybackDiagnosticsConfig
    multiserver?: boolean
    themes?: Theme[]
    menuLinks?: MenuLink[]
    servers?: string[]
    plugins?: string[]
}
