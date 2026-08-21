package com.tracelens.model;

public record LogEvent(
        String id,
        String fileName,
        int lineNumber,
        String raw,
        String timestamp,
        LogLevel level,
        String service,
        String pod,
        String traceId,
        String spanId,
        String message
) {
}
