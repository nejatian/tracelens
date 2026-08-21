package com.tracelens.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tracelens.model.AnalysisResult;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class AnalysisServiceTest {

    private final AnalysisService analysisService = new AnalysisService(
            new LogParser(new ObjectMapper())
    );

    @Test
    void identifiesTheLowLevelFailureInsteadOfPropagatedHttpErrors() throws Exception {
        MockMultipartFile collateral = file(
                "collateral-service-7db9f8c6b9-m2q4p.log",
                "2026-08-21T10:14:32.102Z INFO [collateral-service,91ec0fd2b7a94a61,a10001] "
                        + "c.d.Controller : POST /api/v1/instruments facilityId=COL-8921\n"
                        + "2026-08-21T10:14:32.496Z ERROR [collateral-service,91ec0fd2b7a94a61,a10002] "
                        + "c.d.Client : Downstream instrument-service returned HTTP 503"
        );
        MockMultipartFile instrument = file(
                "instrument-service-66f95ff79b-r9kx2.log",
                "2026-08-21T10:14:32.191Z INFO [instrument-service,91ec0fd2b7a94a61,b20001] "
                        + "c.d.Client : Calling reference-data-service GET /api/v2/currencies/IRR\n"
                        + "2026-08-21T10:14:32.442Z ERROR [instrument-service,91ec0fd2b7a94a61,b20002] "
                        + "c.d.Client : Upstream reference-data-service returned HTTP 503; propagating InstrumentCreationException"
        );
        MockMultipartFile referenceData = file(
                "reference-data-service-59c77c8df4-v8n1s.log",
                "2026-08-21T10:14:32.349Z ERROR [reference-data-service,91ec0fd2b7a94a61,d40001] "
                        + "c.d.Repository : Database query failed\n"
                        + "2026-08-21T10:14:32.350Z ERROR [reference-data-service,91ec0fd2b7a94a61,d40002] "
                        + "c.d.Repository : Caused by: org.postgresql.util.PSQLException: Connection to refdata-postgres:5432 refused"
        );

        AnalysisResult result = analysisService.analyze(
                List.of(collateral, instrument, referenceData),
                "Instrument creation failed for facility COL-8921",
                "POST /api/v1/instruments"
        );

        assertThat(result.traceId()).isEqualTo("91ec0fd2b7a94a61");
        assertThat(result.root().event().service()).isEqualTo("reference-data-service");
        assertThat(result.root().event().lineNumber()).isEqualTo(2);
        assertThat(result.title()).isEqualTo("Database connection refused");
        assertThat(result.confidence()).isGreaterThanOrEqualTo(85);
        assertThat(result.serviceCount()).isEqualTo(3);
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
