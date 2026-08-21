package com.tracelens.model;

import java.util.List;

public record AnalysisResult(
        String traceId,
        int confidence,
        RootCandidate root,
        String summary,
        String title,
        List<LogEvent> events,
        List<LogEvent> evidence,
        List<RootCandidate> alternatives,
        int filesScanned,
        int linesScanned,
        int serviceCount
) {
}
