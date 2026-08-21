package com.tracelens.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tracelens.model.LogEvent;
import com.tracelens.model.LogLevel;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class LogParser {

    private static final Pattern TIMESTAMP = Pattern.compile(
            "\\d{4}-\\d{2}-\\d{2}[T ][0-9:.]+(?:Z|[+-]\\d{2}:?\\d{2})?"
    );
    private static final Pattern LEVEL = Pattern.compile("\\b(ERROR|WARN|INFO|DEBUG|TRACE)\\b");
    private static final Pattern BRACKET_TRACE = Pattern.compile(
            "\\[([a-zA-Z0-9._-]+),([a-fA-F0-9-]{8,}),([a-fA-F0-9-]{4,})\\]"
    );
    private static final Pattern NAMED_TRACE = Pattern.compile(
            "(?:traceId|trace_id|trace-id|trace|correlationId|correlation_id|requestId|request_id)[\\\"']?\\s*[=:]\\s*[\\\"']?([a-zA-Z0-9-]+)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern NAMED_SPAN = Pattern.compile(
            "(?:spanId|span_id|span-id|span)[\\\"']?\\s*[=:]\\s*[\\\"']?([a-zA-Z0-9-]+)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern NAMED_SERVICE = Pattern.compile(
            "(?:service|application|app)\\s*[=:]\\s*[\\\"']?([a-zA-Z0-9._-]+)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern POD = Pattern.compile(
            "pod[\\\"']?\\s*[=:]\\s*[\\\"']?([a-zA-Z0-9._-]+)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern POD_FILE_NAME = Pattern.compile(
            "^(.+?)-([a-f0-9]{7,10})-([a-z0-9]{5})$",
            Pattern.CASE_INSENSITIVE
    );

    private final ObjectMapper objectMapper;

    public LogParser(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public List<LogEvent> parse(List<MultipartFile> files) throws IOException {
        List<LogEvent> events = new ArrayList<>();

        for (int fileIndex = 0; fileIndex < files.size(); fileIndex++) {
            MultipartFile file = files.get(fileIndex);
            String fileName = Optional.ofNullable(file.getOriginalFilename())
                    .filter(name -> !name.isBlank())
                    .orElse("uploaded-" + fileIndex + ".log");
            Identity fallback = inferIdentity(fileName);
            Context context = new Context("", fallback.service(), fallback.pod(), "", "");

            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    file.getInputStream(), StandardCharsets.UTF_8))) {
                String raw;
                int lineNumber = 0;
                while ((raw = reader.readLine()) != null) {
                    lineNumber++;
                    if (raw.isBlank()) {
                        continue;
                    }

                    JsonNode json = parseJson(raw);
                    String timestamp = firstNonBlank(
                            text(json, "@timestamp", "timestamp", "time", "dateTime"),
                            firstMatch(TIMESTAMP, raw),
                            context.timestamp()
                    );
                    LogLevel level = LogLevel.from(firstNonBlank(
                            text(json, "level", "log_level", "severity"),
                            firstMatch(LEVEL, raw)
                    ));

                    Matcher bracket = BRACKET_TRACE.matcher(raw);
                    boolean hasBracketTrace = bracket.find();

                    String service = firstNonBlank(
                            serviceFromJson(json),
                            firstMatch(NAMED_SERVICE, raw),
                            hasBracketTrace ? bracket.group(1) : "",
                            context.service()
                    );
                    String pod = firstNonBlank(
                            text(json, "pod", "podName", "pod_name", "kubernetes.pod_name"),
                            firstMatch(POD, raw),
                            context.pod()
                    );
                    String traceId = firstNonBlank(
                            text(json, "traceId", "trace_id", "trace.id", "correlationId", "correlation_id", "requestId", "request_id"),
                            firstMatch(NAMED_TRACE, raw),
                            hasBracketTrace ? bracket.group(2) : "",
                            context.traceId()
                    );
                    String spanId = firstNonBlank(
                            text(json, "spanId", "span_id", "span.id"),
                            firstMatch(NAMED_SPAN, raw),
                            hasBracketTrace ? bracket.group(3) : "",
                            context.spanId()
                    );
                    String message = firstNonBlank(
                            text(json, "message", "msg", "error.message", "exception"),
                            messageFromText(raw)
                    );

                    Context parsed = new Context(timestamp, service, pod, traceId, spanId);
                    if (!timestamp.isBlank()) {
                        context = parsed;
                    }

                    events.add(new LogEvent(
                            fileIndex + "-" + lineNumber,
                            fileName,
                            lineNumber,
                            raw,
                            timestamp,
                            level,
                            service,
                            pod,
                            traceId.isBlank() ? "untraced:" + fileIndex : traceId,
                            spanId,
                            message
                    ));
                }
            }
        }

        return events;
    }

    private JsonNode parseJson(String raw) {
        if (!raw.stripLeading().startsWith("{")) {
            return null;
        }
        try {
            return objectMapper.readTree(raw);
        } catch (JsonProcessingException ignored) {
            return null;
        }
    }

    private static String serviceFromJson(JsonNode json) {
        String direct = text(json, "serviceName", "service_name", "application", "app");
        if (!direct.isBlank()) {
            return direct;
        }
        return text(json, "service", "service.name");
    }

    private static String text(JsonNode json, String... keys) {
        if (json == null) {
            return "";
        }
        for (String key : keys) {
            JsonNode value = json.get(key);
            if (value == null && key.contains(".")) {
                value = json;
                for (String part : key.split("\\.")) {
                    value = value == null ? null : value.get(part);
                }
            }
            if (value != null && value.isValueNode() && !value.isNull()) {
                return value.asText();
            }
        }
        return "";
    }

    private static String firstMatch(Pattern pattern, String value) {
        Matcher matcher = pattern.matcher(value);
        return matcher.find() ? matcher.group(matcher.groupCount() > 0 ? 1 : 0) : "";
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private static String messageFromText(String raw) {
        int separator = raw.lastIndexOf(" : ");
        return separator >= 0 ? raw.substring(separator + 3).trim() : raw.trim();
    }

    private static Identity inferIdentity(String fileName) {
        String base = fileName.replaceFirst("(?i)\\.(log|txt|json|out)$", "");
        Matcher podMatcher = POD_FILE_NAME.matcher(base);
        if (podMatcher.matches()) {
            return new Identity(podMatcher.group(1), base);
        }

        String[] split = base.split("__|--pod--", 2);
        String service = split.length > 0 && !split[0].isBlank() ? split[0] : "unknown-service";
        String pod = split.length > 1 && !split[1].isBlank() ? split[1] : base;
        return new Identity(service, pod);
    }

    private record Identity(String service, String pod) {
    }

    private record Context(String timestamp, String service, String pod, String traceId, String spanId) {
    }
}
