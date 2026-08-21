package com.tracelens.service;

import com.tracelens.model.AnalysisResult;
import com.tracelens.model.LogEvent;
import com.tracelens.model.LogLevel;
import com.tracelens.model.RootCandidate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

@Service
public class AnalysisService {

    private static final Set<String> STOP_WORDS = Set.of(
            "the", "and", "that", "this", "with", "from", "while", "when", "what",
            "went", "wrong", "error", "failed", "failure", "service", "call", "some",
            "into", "during", "unable", "could", "would", "should", "create", "creating"
    );

    private static final Pattern ERROR_SIGNAL = Pattern.compile(
            "exception|caused by|5\\d\\d", Pattern.CASE_INSENSITIVE
    );
    private static final Pattern EXPLICIT_CAUSE = Pattern.compile(
            "caused by|root cause", Pattern.CASE_INSENSITIVE
    );
    private static final Pattern LOW_LEVEL_FAILURE = Pattern.compile(
            "connection refused|constraint|deadlock|nullpointerexception|unknownhost|outofmemory|sqlstate|authentication failed|certificate.*expired",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern EXCEPTION = Pattern.compile(
            "exception|psqlexception|ioexception", Pattern.CASE_INSENSITIVE
    );
    private static final Pattern TIMEOUT = Pattern.compile(
            "timeout|timed out", Pattern.CASE_INSENSITIVE
    );
    private static final Pattern PROPAGATED = Pattern.compile(
            "upstream|downstream|propagat|feignexception|webclientresponseexception|returning|returned http|bad gateway",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern EVIDENCE_SIGNAL = Pattern.compile(
            "calling|received|returning", Pattern.CASE_INSENSITIVE
    );

    private final LogParser logParser;

    public AnalysisService(LogParser logParser) {
        this.logParser = logParser;
    }

    public AnalysisResult analyze(List<MultipartFile> files, String clue, String suspiciousCall) throws IOException {
        List<LogEvent> events = logParser.parse(files);
        return analyzeEvents(events, files.size(), clue, suspiciousCall);
    }

    AnalysisResult analyzeEvents(
            List<LogEvent> allEvents,
            int filesScanned,
            String clue,
            String suspiciousCall
    ) {
        if (allEvents.isEmpty()) {
            throw new IllegalArgumentException("No readable log events were found in the uploaded files.");
        }

        List<String> clueTokens = tokenize(clue);
        List<String> callTokens = tokenize(suspiciousCall);
        Map<String, List<LogEvent>> byTrace = groupByTrace(allEvents);

        TraceCandidate selected = byTrace.entrySet().stream()
                .map(entry -> new TraceCandidate(
                        entry.getKey(),
                        entry.getValue(),
                        scoreTrace(entry.getValue(), clueTokens, callTokens)
                ))
                .max(Comparator.comparingInt(TraceCandidate::score))
                .orElseThrow();

        List<LogEvent> ordered = new ArrayList<>(selected.events());
        ordered.sort(Comparator
                .comparing(LogEvent::timestamp, Comparator.nullsFirst(String::compareTo))
                .thenComparingInt(LogEvent::lineNumber));

        List<LogEvent> errorEvents = ordered.stream()
                .filter(event -> event.level() == LogLevel.ERROR || matches(ERROR_SIGNAL, event.message()))
                .toList();

        List<RootCandidate> candidates = scoreRootCandidates(errorEvents, clueTokens, callTokens);
        RootCandidate root = candidates.isEmpty()
                ? new RootCandidate(ordered.get(0), 1, List.of("only available signal"))
                : candidates.get(0);

        int serviceCount = (int) ordered.stream().map(LogEvent::service).distinct().count();
        int confidence = Math.min(97, Math.max(
                52,
                (int) Math.round(55 + root.score() * 0.42 + Math.min(serviceCount * 2, 8))
        ));

        List<LogEvent> evidence = ordered.stream()
                .filter(event -> event.level() == LogLevel.ERROR
                        || event.id().equals(root.event().id())
                        || matches(EVIDENCE_SIGNAL, event.message()))
                .limit(8)
                .toList();

        LinkedHashSet<String> propagatedServices = new LinkedHashSet<>();
        ordered.stream()
                .filter(event -> event.level() == LogLevel.ERROR)
                .filter(event -> !event.service().equals(root.event().service()))
                .map(LogEvent::service)
                .forEach(propagatedServices::add);

        String propagated = propagatedServices.isEmpty()
                ? "the calling service"
                : String.join(" and ", propagatedServices);
        String summary = root.event().service()
                + " contains the strongest low-level failure. The later errors in "
                + propagated
                + " are consistent with propagation, not the original fault.";

        return new AnalysisResult(
                selected.traceId(),
                confidence,
                root,
                summary,
                rootTitle(root.event().message(), root.event().service()),
                List.copyOf(ordered),
                evidence,
                candidates.stream().skip(1).limit(2).toList(),
                filesScanned,
                allEvents.size(),
                serviceCount
        );
    }

    private static Map<String, List<LogEvent>> groupByTrace(List<LogEvent> events) {
        boolean hasCorrelationIds = events.stream()
                .anyMatch(event -> !event.traceId().startsWith("untraced:"));

        if (!hasCorrelationIds) {
            return Map.of("heuristic-time-window", events);
        }

        Map<String, List<LogEvent>> byTrace = new LinkedHashMap<>();
        for (LogEvent event : events) {
            byTrace.computeIfAbsent(event.traceId(), ignored -> new ArrayList<>()).add(event);
        }
        return byTrace;
    }

    private static int scoreTrace(List<LogEvent> events, List<String> clueTokens, List<String> callTokens) {
        int score = 0;
        Set<String> services = new LinkedHashSet<>();
        for (LogEvent event : events) {
            String searchable = event.raw() + " " + event.fileName();
            score += event.level() == LogLevel.ERROR ? 10 : event.level() == LogLevel.WARN ? 3 : 0;
            score += countMatches(searchable, clueTokens) * 4;
            score += countMatches(searchable, callTokens) * 7;
            services.add(event.service());
        }
        return score + services.size() * 3;
    }

    private static List<RootCandidate> scoreRootCandidates(
            List<LogEvent> errorEvents,
            List<String> clueTokens,
            List<String> callTokens
    ) {
        List<RootCandidate> candidates = new ArrayList<>();

        for (int index = 0; index < errorEvents.size(); index++) {
            LogEvent event = errorEvents.get(index);
            String message = event.message();
            List<String> reasons = new ArrayList<>();
            int score = event.level() == LogLevel.ERROR ? 20 : 8;

            if (matches(EXPLICIT_CAUSE, message)) {
                score += 34;
                reasons.add("explicit cause");
            }
            if (matches(LOW_LEVEL_FAILURE, message)) {
                score += 30;
                reasons.add("low-level failure");
            }
            if (matches(EXCEPTION, message)) {
                score += 11;
                reasons.add("exception signal");
            }
            if (matches(TIMEOUT, message)) {
                score += 17;
                reasons.add("timeout signal");
            }
            if (matches(PROPAGATED, message)) {
                score -= 14;
                reasons.add("likely propagated symptom");
            }

            int queryMatches = countMatches(event.raw(), clueTokens)
                    + countMatches(event.raw(), callTokens);
            if (queryMatches > 0) {
                score += Math.min(queryMatches * 3, 12);
                reasons.add("matches incident clue");
            }

            score += Math.max(0, errorEvents.size() - index);
            candidates.add(new RootCandidate(event, score, List.copyOf(reasons)));
        }

        candidates.sort(Comparator.comparingInt(RootCandidate::score).reversed());
        return candidates;
    }

    private static List<String> tokenize(String value) {
        if (value == null || value.isBlank()) {
            return List.of();
        }
        return Arrays.stream(value.toLowerCase(Locale.ROOT).split("[^a-z0-9/_-]+"))
                .filter(token -> token.length() > 2)
                .filter(Predicate.not(STOP_WORDS::contains))
                .toList();
    }

    private static int countMatches(String value, List<String> tokens) {
        String searchable = value.toLowerCase(Locale.ROOT);
        return (int) tokens.stream().filter(searchable::contains).count();
    }

    private static boolean matches(Pattern pattern, String value) {
        return pattern.matcher(value == null ? "" : value).find();
    }

    private static String rootTitle(String message, String service) {
        String value = message.toLowerCase(Locale.ROOT);
        if (value.contains("connection") && (value.contains("refused") || value.contains("failed"))) {
            return "Database connection refused";
        }
        if (value.contains("constraint") || value.contains("sqlstate 23")) {
            return "Database constraint violation";
        }
        if (value.contains("nullpointerexception") || value.contains("null reference")) {
            return "Unhandled null reference";
        }
        if (value.contains("timeout") || value.contains("timed out")) {
            return "Downstream operation timed out";
        }
        if (value.contains("outofmemory")) {
            return "Service memory exhausted";
        }
        if (value.contains("unknownhost")) {
            return "Service hostname could not be resolved";
        }
        return "Failure originated in " + service;
    }

    private record TraceCandidate(String traceId, List<LogEvent> events, int score) {
    }
}
