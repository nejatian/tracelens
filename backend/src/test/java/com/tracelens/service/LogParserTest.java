package com.tracelens.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tracelens.model.LogEvent;
import com.tracelens.model.LogLevel;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class LogParserTest {

    private final LogParser parser = new LogParser(new ObjectMapper());

    @Test
    void parsesSpringTextAndJsonLogsIntoTheSameEventModel() throws Exception {
        MockMultipartFile textLog = file(
                "collateral-service-7db9f8c6b9-m2q4p.log",
                "2026-08-21T10:14:32.102Z INFO [collateral-service,91ec0fd2b7a94a61,a10001] "
                        + "[pod=collateral-service-7db9f8c6b9-m2q4p] c.d.Controller : POST /api/v1/instruments\n"
                        + "java.lang.IllegalStateException: propagated stack line"
        );
        MockMultipartFile jsonLog = file(
                "reference-data-service-59c77c8df4-v8n1s.json",
                "{\"@timestamp\":\"2026-08-21T10:14:32.350Z\",\"level\":\"ERROR\","
                        + "\"service\":\"reference-data-service\","
                        + "\"pod\":\"reference-data-service-59c77c8df4-v8n1s\","
                        + "\"traceId\":\"91ec0fd2b7a94a61\",\"spanId\":\"d40004\","
                        + "\"message\":\"PSQLException: Connection refused\"}"
        );

        List<LogEvent> events = parser.parse(List.of(textLog, jsonLog));

        assertThat(events).hasSize(3);
        assertThat(events.get(0).service()).isEqualTo("collateral-service");
        assertThat(events.get(0).traceId()).isEqualTo("91ec0fd2b7a94a61");
        assertThat(events.get(1).traceId()).isEqualTo("91ec0fd2b7a94a61");
        assertThat(events.get(2).level()).isEqualTo(LogLevel.ERROR);
        assertThat(events.get(2).service()).isEqualTo("reference-data-service");
        assertThat(events.get(2).message()).isEqualTo("PSQLException: Connection refused");
    }

    private static MockMultipartFile file(String name, String content) {
        return new MockMultipartFile(
                "files",
                name,
                "text/plain",
                content.getBytes(StandardCharsets.UTF_8)
        );
    }
}
