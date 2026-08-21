package com.tracelens.model;

import java.util.List;

public record RootCandidate(
        LogEvent event,
        int score,
        List<String> reasons
) {
}
