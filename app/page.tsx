"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE" | "UNKNOWN";

type LogFileData = {
  id: string;
  name: string;
  size: number;
  service: string;
  pod: string;
  content: string;
};

type LogEvent = {
  id: string;
  fileName: string;
  lineNumber: number;
  raw: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  pod: string;
  traceId: string;
  spanId: string;
  message: string;
};

type RootCandidate = {
  event: LogEvent;
  score: number;
  reasons: string[];
};

type AnalysisResult = {
  traceId: string;
  confidence: number;
  root: RootCandidate;
  summary: string;
  title: string;
  events: LogEvent[];
  evidence: LogEvent[];
  alternatives: RootCandidate[];
  filesScanned: number;
  linesScanned: number;
  serviceCount: number;
};

const SAMPLE_LOGS = [
  {
    name: "collateral-service-7db9f8c6b9-m2q4p.log",
    content: `2026-08-21T10:14:32.102Z INFO [collateral-service,8f4c2a11d6e742f8,aa0101] [pod=collateral-service-7db9f8c6b9-m2q4p] c.d.c.api.InstrumentController : POST /api/v1/instruments facilityId=COL-8921
2026-08-21T10:14:32.116Z INFO [collateral-service,8f4c2a11d6e742f8,aa0102] [pod=collateral-service-7db9f8c6b9-m2q4p] c.d.c.service.CollateralService : Validated collateral COL-8921; calling instrument-service
2026-08-21T10:14:32.371Z ERROR [collateral-service,8f4c2a11d6e742f8,aa0103] [pod=collateral-service-7db9f8c6b9-m2q4p] c.d.c.client.InstrumentClient : Downstream instrument creation failed with HTTP 503 for facility COL-8921
2026-08-21T10:14:32.373Z WARN [collateral-service,8f4c2a11d6e742f8,aa0104] [pod=collateral-service-7db9f8c6b9-m2q4p] c.d.c.api.ErrorHandler : Returning 502 Bad Gateway requestId=req-4817`,
  },
  {
    name: "instrument-service-66f95ff79b-r9kx2.log",
    content: `2026-08-21T10:14:32.159Z INFO [instrument-service,8f4c2a11d6e742f8,bb0201] [pod=instrument-service-66f95ff79b-r9kx2] c.d.i.api.InstrumentController : Create instrument request received for facility COL-8921
2026-08-21T10:14:32.202Z INFO [instrument-service,8f4c2a11d6e742f8,bb0202] [pod=instrument-service-66f95ff79b-r9kx2] c.d.i.validation.CurrencyValidator : Calling reference-data-service GET /api/v2/currencies/IRR
2026-08-21T10:14:32.335Z ERROR [instrument-service,8f4c2a11d6e742f8,bb0203] [pod=instrument-service-66f95ff79b-r9kx2] c.d.i.validation.CurrencyValidator : Upstream reference-data call returned HTTP 503; propagating InstrumentCreationException
2026-08-21T10:14:32.347Z ERROR [instrument-service,8f4c2a11d6e742f8,bb0204] [pod=instrument-service-66f95ff79b-r9kx2] c.d.i.api.ErrorHandler : Instrument creation failed for facility COL-8921`,
  },
  {
    name: "reference-data-service-59c77c8df4-v8n1s.log",
    content: `2026-08-21T10:14:32.247Z INFO [reference-data-service,8f4c2a11d6e742f8,cc0301] [pod=reference-data-service-59c77c8df4-v8n1s] c.d.r.api.CurrencyController : GET /api/v2/currencies/IRR
2026-08-21T10:14:32.298Z ERROR [reference-data-service,8f4c2a11d6e742f8,cc0302] [pod=reference-data-service-59c77c8df4-v8n1s] c.d.r.repository.CurrencyRepository : Database query failed in findByCode(IRR)
2026-08-21T10:14:32.299Z ERROR [reference-data-service,8f4c2a11d6e742f8,cc0302] [pod=reference-data-service-59c77c8df4-v8n1s] c.d.r.repository.CurrencyRepository : Caused by: org.postgresql.util.PSQLException: Connection to refdata-postgres:5432 refused
2026-08-21T10:14:32.304Z WARN [reference-data-service,8f4c2a11d6e742f8,cc0303] [pod=reference-data-service-59c77c8df4-v8n1s] c.d.r.api.ErrorHandler : Returning HTTP 503 SERVICE_UNAVAILABLE`,
  },
];

const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "while", "when", "what",
  "went", "wrong", "error", "failed", "failure", "service", "call", "some",
  "into", "during", "unable", "could", "would", "should", "create", "creating",
]);

function inferIdentity(fileName: string) {
  const base = fileName.replace(/\.(log|txt|json|out)$/i, "");
  const podMatch = base.match(/^(.+?)-([a-f0-9]{7,10})-([a-z0-9]{5})$/i);
  if (podMatch) return { service: podMatch[1], pod: base };
  const split = base.split(/__|--pod--/);
  return { service: split[0] || "unknown-service", pod: split[1] || base };
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function countMatches(value: string, tokens: string[]) {
  const haystack = value.toLowerCase();
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

function jsonValue(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

function parseJsonLine(raw: string) {
  if (!raw.trimStart().startsWith("{")) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serviceFromJson(record: Record<string, unknown> | null) {
  if (!record) return "";
  const direct = jsonValue(record, ["serviceName", "service_name", "application", "app"]);
  if (direct) return direct;
  if (typeof record.service === "string") return record.service;
  if (record.service && typeof record.service === "object") {
    return jsonValue(record.service as Record<string, unknown>, ["name"]);
  }
  return "";
}

function normalizeLevel(value: string): LogLevel {
  const level = value.toUpperCase();
  return ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"].includes(level) ? level as LogLevel : "UNKNOWN";
}

function parseLogs(files: LogFileData[]) {
  const events: LogEvent[] = [];

  files.forEach((file) => {
    const fallback = inferIdentity(file.name);
    let context = {
      timestamp: "",
      service: fallback.service,
      pod: fallback.pod,
      traceId: "",
      spanId: "",
    };

    file.content.split(/\r?\n/).forEach((raw, index) => {
      if (!raw.trim()) return;

      const json = parseJsonLine(raw);
      const timestamp = jsonValue(json, ["@timestamp", "timestamp", "time", "dateTime"])
        || raw.match(/\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?/)?.[0]
        || context.timestamp;
      const level = normalizeLevel(jsonValue(json, ["level", "log_level", "severity"]) || raw.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/)?.[1] || "");
      const bracketTrace = raw.match(/\[([a-zA-Z0-9._-]+),([a-fA-F0-9-]{8,}),([a-fA-F0-9-]{4,})\]/);
      const namedTrace = jsonValue(json, ["traceId", "trace_id", "trace.id", "correlationId", "correlation_id", "requestId", "request_id"])
        || raw.match(/(?:traceId|trace_id|trace-id|trace|correlationId|correlation_id|requestId|request_id)["']?\s*[=:]\s*["']?([a-zA-Z0-9-]+)/i)?.[1];
      const namedSpan = jsonValue(json, ["spanId", "span_id", "span.id"])
        || raw.match(/(?:spanId|span_id|span-id|span)["']?\s*[=:]\s*["']?([a-zA-Z0-9-]+)/i)?.[1];
      const namedService = raw.match(/(?:service|application|app)\s*[=:]\s*["']?([a-zA-Z0-9._-]+)/i)?.[1];
      const pod = jsonValue(json, ["pod", "podName", "pod_name", "kubernetes.pod_name"])
        || raw.match(/pod["']?\s*[=:]\s*["']?([a-zA-Z0-9._-]+)/i)?.[1]
        || context.pod;
      const message = jsonValue(json, ["message", "msg", "error.message", "exception"])
        || (raw.includes(" : ") ? raw.slice(raw.lastIndexOf(" : ") + 3).trim() : raw.trim());

      const parsed = {
        timestamp,
        service: serviceFromJson(json) || namedService || bracketTrace?.[1] || context.service,
        pod,
        traceId: namedTrace || bracketTrace?.[2] || context.traceId,
        spanId: namedSpan || bracketTrace?.[3] || context.spanId,
      };

      if (timestamp) context = parsed;

      events.push({
        id: `${file.id}-${index + 1}`,
        fileName: file.name,
        lineNumber: index + 1,
        raw,
        timestamp: parsed.timestamp,
        level,
        service: parsed.service,
        pod: parsed.pod,
        traceId: parsed.traceId || `untraced:${file.id}`,
        spanId: parsed.spanId,
        message,
      });
    });
  });

  return events;
}

function rootTitle(message: string, service: string) {
  const value = message.toLowerCase();
  if (value.includes("connection") && (value.includes("refused") || value.includes("failed"))) return "Database connection refused";
  if (value.includes("constraint") || value.includes("sqlstate 23")) return "Database constraint violation";
  if (value.includes("nullpointerexception") || value.includes("null reference")) return "Unhandled null reference";
  if (value.includes("timeout") || value.includes("timed out")) return "Downstream operation timed out";
  if (value.includes("outofmemory")) return "Service memory exhausted";
  if (value.includes("unknownhost")) return "Service hostname could not be resolved";
  return `Failure originated in ${service}`;
}

function analyzeFiles(files: LogFileData[], clue: string, suspiciousCall: string): AnalysisResult | null {
  const allEvents = parseLogs(files);
  if (!allEvents.length) return null;

  const clueTokens = tokenize(clue);
  const callTokens = tokenize(suspiciousCall);
  const byTrace = new Map<string, LogEvent[]>();

  const hasCorrelationIds = allEvents.some((event) => !event.traceId.startsWith("untraced:"));
  if (!hasCorrelationIds) {
    byTrace.set("heuristic-time-window", allEvents);
  } else {
    allEvents.forEach((event) => {
      const list = byTrace.get(event.traceId) || [];
      list.push(event);
      byTrace.set(event.traceId, list);
    });
  }

  const rankedTraces = [...byTrace.entries()].map(([traceId, events]) => {
    const score = events.reduce((total, event) => {
      const searchable = `${event.raw} ${event.fileName}`;
      return total
        + (event.level === "ERROR" ? 10 : event.level === "WARN" ? 3 : 0)
        + countMatches(searchable, clueTokens) * 4
        + countMatches(searchable, callTokens) * 7;
    }, 0) + new Set(events.map((event) => event.service)).size * 3;
    return { traceId, events, score };
  }).sort((a, b) => b.score - a.score);

  const selected = rankedTraces[0];
  const ordered = [...selected.events].sort((a, b) => {
    const time = a.timestamp.localeCompare(b.timestamp);
    return time || a.lineNumber - b.lineNumber;
  });
  const errorEvents = ordered.filter((event) => event.level === "ERROR" || /exception|caused by|5\d\d/i.test(event.message));

  const candidates = errorEvents.map((event, index): RootCandidate => {
    const text = event.message.toLowerCase();
    const reasons: string[] = [];
    let score = event.level === "ERROR" ? 20 : 8;

    if (/caused by|root cause/.test(text)) { score += 34; reasons.push("explicit cause"); }
    if (/connection refused|constraint|deadlock|nullpointerexception|unknownhost|outofmemory|sqlstate|authentication failed|certificate.*expired/.test(text)) {
      score += 30;
      reasons.push("low-level failure");
    }
    if (/exception|psqlexception|ioexception/.test(text)) { score += 11; reasons.push("exception signal"); }
    if (/timeout|timed out/.test(text)) { score += 17; reasons.push("timeout signal"); }
    if (/upstream|downstream|propagat|feignexception|webclientresponseexception|returning|returned http|bad gateway/.test(text)) {
      score -= 14;
      reasons.push("likely propagated symptom");
    }

    const queryMatches = countMatches(event.raw, clueTokens) + countMatches(event.raw, callTokens);
    if (queryMatches) { score += Math.min(queryMatches * 3, 12); reasons.push("matches incident clue"); }
    score += Math.max(0, errorEvents.length - index);
    return { event, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const root = candidates[0] || { event: ordered[0], score: 1, reasons: ["only available signal"] };
  const serviceCount = new Set(ordered.map((event) => event.service)).size;
  const confidence = Math.min(97, Math.max(52, Math.round(55 + root.score * 0.42 + Math.min(serviceCount * 2, 8))));
  const evidence = ordered
    .filter((event) => event.level === "ERROR" || event.id === root.event.id || /calling|received|returning/i.test(event.message))
    .slice(0, 8);

  const propagatedServices = ordered
    .filter((event) => event.level === "ERROR" && event.service !== root.event.service)
    .map((event) => event.service)
    .filter((service, index, list) => list.indexOf(service) === index)
    .join(" and ");
  const summary = `${root.event.service} contains the strongest low-level failure. The later errors in ${propagatedServices || "the calling service"} are consistent with propagation, not the original fault.`;

  return {
    traceId: selected.traceId,
    confidence,
    root,
    summary,
    title: rootTitle(root.event.message, root.event.service),
    events: ordered,
    evidence,
    alternatives: candidates.slice(1, 3),
    filesScanned: files.length,
    linesScanned: files.reduce((sum, file) => sum + file.content.split(/\r?\n/).length, 0),
    serviceCount,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortTrace(traceId: string) {
  if (traceId.startsWith("untraced:")) return "No trace ID";
  return traceId.length > 14 ? `${traceId.slice(0, 8)}…${traceId.slice(-4)}` : traceId;
}

function timeOnly(timestamp: string) {
  const match = timestamp.match(/T(\d{2}:\d{2}:\d{2}\.\d{3})/);
  return match?.[1] || timestamp || "—";
}

export default function Home() {
  const [files, setFiles] = useState<LogFileData[]>([]);
  const [clue, setClue] = useState("");
  const [suspiciousCall, setSuspiciousCall] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const services = useMemo(() => [...new Set(files.map((file) => file.service))], [files]);

  async function addFiles(list: FileList | File[]) {
    const accepted = Array.from(list).filter((file) => /\.(log|txt|json|out)$/i.test(file.name));
    if (!accepted.length) {
      setNotice("Choose .log, .txt, .out, or JSON log files.");
      return;
    }
    const oversized = accepted.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setNotice(`${oversized.name} is larger than the 12 MB MVP limit.`);
      return;
    }
    const next = await Promise.all(accepted.map(async (file) => {
      const identity = inferIdentity(file.name);
      return {
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        size: file.size,
        service: identity.service,
        pod: identity.pod,
        content: await file.text(),
      };
    }));
    setFiles((current) => {
      const ids = new Set(current.map((file) => file.id));
      return [...current, ...next.filter((file) => !ids.has(file.id))];
    });
    setResult(null);
    setNotice("");
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  function loadExample() {
    setFiles(SAMPLE_LOGS.map((file, index) => {
      const identity = inferIdentity(file.name);
      return { ...file, id: `sample-${index}`, size: new Blob([file.content]).size, ...identity };
    }));
    setClue("Instrument creation failed for facility COL-8921");
    setSuspiciousCall("POST /api/v1/instruments");
    setResult(null);
    setNotice("Demo loaded. Run the investigation to follow the failure across three services.");
  }

  function runAnalysis() {
    if (!files.length) {
      setNotice("Add at least one log file before starting the investigation.");
      return;
    }
    if (!clue.trim() && !suspiciousCall.trim()) {
      setNotice("Add a clue or suspicious call so TraceLens knows where to begin.");
      return;
    }
    setIsAnalyzing(true);
    setNotice("");
    window.setTimeout(() => {
      const next = analyzeFiles(files, clue, suspiciousCall);
      setResult(next);
      setIsAnalyzing(false);
      if (!next) setNotice("No readable log events were found in these files.");
    }, 720);
  }

  function resetInvestigation() {
    setFiles([]);
    setClue("");
    setSuspiciousCall("");
    setResult(null);
    setNotice("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="TraceLens home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>TraceLens</span>
          <span className="beta">MVP</span>
        </div>
        <div className="topbar-meta">
          <span className="privacy"><span className="status-dot" /> Local analysis</span>
          <button className="ghost-button" type="button" onClick={resetInvestigation}>New investigation</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="setup-panel">
          <div className="eyebrow"><span>01</span> Incident setup</div>
          <h1>Find where the failure <em>actually</em> began.</h1>
          <p className="intro">Correlate Spring Boot logs across services and pods. Every conclusion links back to a source line.</p>

          <div className="field-group">
            <label htmlFor="clue">What went wrong?</label>
            <textarea
              id="clue"
              value={clue}
              onChange={(event) => { setClue(event.target.value); setResult(null); }}
              placeholder="e.g. Collateral failed while creating an instrument for facility COL-8921"
              rows={4}
            />
            <span className="field-hint">Include an entity ID, error phrase, or approximate time.</span>
          </div>

          <div className="field-group">
            <label htmlFor="suspicious-call">Suspicious call <span>optional</span></label>
            <div className="input-prefix">
              <span>↗</span>
              <input
                id="suspicious-call"
                value={suspiciousCall}
                onChange={(event) => { setSuspiciousCall(event.target.value); setResult(null); }}
                placeholder="POST /api/v1/instruments"
              />
            </div>
          </div>

          <div className="field-group upload-group">
            <div className="label-row">
              <label>Service logs</label>
              {files.length > 0 && <span>{files.length} files · {formatBytes(totalSize)}</span>}
            </div>
            <input ref={inputRef} className="sr-only" type="file" multiple accept=".log,.txt,.json,.out" onChange={handleFileInput} />
            <div
              className={`dropzone ${isDragging ? "dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <span className="upload-icon">⇧</span>
              <strong>Drop logs here</strong>
              <span>or <button type="button" onClick={() => inputRef.current?.click()}>choose files</button></span>
              <small>Multiple pods · up to 12 MB each</small>
            </div>
          </div>

          {files.length > 0 && (
            <div className="file-list" aria-label="Selected log files">
              {files.map((file) => (
                <div className="file-item" key={file.id}>
                  <span className="file-glyph">LOG</span>
                  <div>
                    <strong>{file.service}</strong>
                    <span>{file.pod} · {formatBytes(file.size)}</span>
                  </div>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => { setFiles((current) => current.filter((item) => item.id !== file.id)); setResult(null); }}>×</button>
                </div>
              ))}
            </div>
          )}

          {notice && <p className="notice">{notice}</p>}

          <button className="analyze-button" type="button" disabled={isAnalyzing} onClick={runAnalysis}>
            <span>{isAnalyzing ? "Correlating traces…" : "Investigate root cause"}</span>
            <span>{isAnalyzing ? "•••" : "→"}</span>
          </button>
          <button className="demo-button" type="button" onClick={loadExample}>Load a three-service example</button>

          <div className="local-note">
            <span>⌁</span>
            <p><strong>Your logs stay on this device.</strong> This MVP analyzes files in your browser and does not upload them.</p>
          </div>
        </aside>

        <section className="results-panel" aria-live="polite">
          {!result && !isAnalyzing && (
            <div className="empty-state">
              <div className="empty-visual" aria-hidden="true">
                <span className="service-node node-one">Collateral</span>
                <span className="service-node node-two">Instrument</span>
                <span className="service-node node-three">Service C</span>
                <span className="trace-line line-one" />
                <span className="trace-line line-two" />
                <span className="fault-pulse">!</span>
              </div>
              <div className="eyebrow"><span>02</span> Correlated evidence</div>
              <h2>One request. Many services.<br />One probable origin.</h2>
              <p>TraceLens follows trace IDs, timestamps, exceptions, and propagation language to separate the first failure from its downstream symptoms.</p>
              <div className="empty-steps">
                <span><b>1</b> Match the incident</span>
                <span><b>2</b> Rebuild the call path</span>
                <span><b>3</b> Rank root signals</span>
              </div>
            </div>
          )}

          {isAnalyzing && (
            <div className="loading-state">
              <div className="radar"><span /><span /><i /></div>
              <h2>Reconstructing the incident</h2>
              <p>Matching clues, ordering events, and distinguishing root failures from propagated errors.</p>
              <div className="loading-bar"><span /></div>
            </div>
          )}

          {result && !isAnalyzing && (
            <div className="report">
              <div className="report-header">
                <div>
                  <div className="eyebrow"><span>02</span> Investigation result</div>
                  <h2>{result.title}</h2>
                  <p>Trace <code>{shortTrace(result.traceId)}</code> · {result.events[0]?.timestamp.slice(0, 10)}</p>
                </div>
                <div className="confidence" aria-label={`${result.confidence} percent confidence`}>
                  <strong>{result.confidence}%</strong>
                  <span>confidence</span>
                </div>
              </div>

              <article className="root-card">
                <div className="root-accent" />
                <div className="root-label"><span>●</span> Most likely origin</div>
                <div className="root-grid">
                  <div>
                    <span className="service-chip">{result.root.event.service}</span>
                    <h3>{result.root.event.message}</h3>
                    <p>{result.summary}</p>
                  </div>
                  <dl>
                    <div><dt>Pod</dt><dd>{result.root.event.pod}</dd></div>
                    <div><dt>Time</dt><dd>{timeOnly(result.root.event.timestamp)}</dd></div>
                    <div><dt>Source</dt><dd>{result.root.event.fileName}:{result.root.event.lineNumber}</dd></div>
                  </dl>
                </div>
                <div className="source-line">
                  <span>{result.root.event.lineNumber}</span>
                  <code>{result.root.event.raw}</code>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(result.root.event.raw)} aria-label="Copy source line">Copy</button>
                </div>
              </article>

              <section className="call-path">
                <div className="section-heading">
                  <div><span className="section-number">01</span><h3>Failure path</h3></div>
                  <span>{result.serviceCount} services · {result.events.length} matched events</span>
                </div>
                <div className="path-list">
                  {[...new Set(result.events.map((event) => event.service))].map((service, index, list) => {
                    const event = result.events.find((item) => item.service === service);
                    const isRoot = service === result.root.event.service;
                    const hasError = result.events.some((item) => item.service === service && item.level === "ERROR");
                    return (
                      <div className={`path-step ${isRoot ? "is-root" : ""}`} key={service}>
                        <div className="path-top">
                          <span className="path-index">{String(index + 1).padStart(2, "0")}</span>
                          {index < list.length - 1 && <span className="path-arrow">→</span>}
                        </div>
                        <strong>{service}</strong>
                        <span>{isRoot ? "Probable origin" : hasError ? "Propagated error" : "Request observed"}</span>
                        <small>{timeOnly(event?.timestamp || "")}</small>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="evidence-section">
                <div className="section-heading">
                  <div><span className="section-number">02</span><h3>Evidence timeline</h3></div>
                  <span>Ordered across pods</span>
                </div>
                <div className="timeline-table">
                  <div className="timeline-head">
                    <span>Time</span><span>Service / pod</span><span>Level</span><span>Message</span><span>Source</span>
                  </div>
                  {result.evidence.map((event) => (
                    <div className={`timeline-row ${event.id === result.root.event.id ? "highlighted" : ""}`} key={event.id}>
                      <time>{timeOnly(event.timestamp)}</time>
                      <div className="service-cell"><strong>{event.service}</strong><span>{event.pod}</span></div>
                      <span className={`level level-${event.level.toLowerCase()}`}>{event.level}</span>
                      <p>{event.message}</p>
                      <span className="line-ref">L{event.lineNumber}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="report-footer">
                <div>
                  <span>Files scanned</span><strong>{result.filesScanned}</strong>
                </div>
                <div>
                  <span>Lines inspected</span><strong>{result.linesScanned.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Services linked</span><strong>{result.serviceCount}</strong>
                </div>
                <div className="method-note">
                  <span>Analysis method</span><strong>Trace correlation + root-signal ranking</strong>
                </div>
              </section>
            </div>
          )}
        </section>
      </section>
      <footer className="page-footer">
        <span>TraceLens</span>
        <span>Evidence-first incident analysis for distributed Spring Boot systems</span>
        <span>{services.length ? `${services.length} services ready` : "Ready for logs"}</span>
      </footer>
    </main>
  );
}
