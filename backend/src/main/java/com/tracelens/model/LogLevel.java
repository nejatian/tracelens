package com.tracelens.model;

import java.util.Locale;

public enum LogLevel {
    ERROR,
    WARN,
    INFO,
    DEBUG,
    TRACE,
    UNKNOWN;

    public static LogLevel from(String value) {
        if (value == null || value.isBlank()) {
            return UNKNOWN;
        }
        try {
            return valueOf(value.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ignored) {
            return UNKNOWN;
        }
    }
}
