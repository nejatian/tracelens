# TraceLens

TraceLens is a local-first investigation tool for distributed Spring Boot logs. Upload log files from multiple services and Kubernetes pods, describe the incident, and TraceLens reconstructs the call path and ranks the most likely point of origin with exact file and line evidence.

## Features

- Multiple `.log`, `.txt`, `.out`, and JSON log files
- Spring Boot trace, correlation, and request ID extraction
- Cross-service and cross-pod event timeline
- Root-signal ranking for exceptions, connection failures, timeouts, and database errors
- Propagated-error detection for upstream/downstream HTTP failures
- Exact source file, pod, timestamp, and line references
- Browser-local processing: uploaded logs are not sent to a backend
- Built-in three-service example

## Architecture

- `app/` — Next.js/React interface
- `backend/` — Java 17 and Spring Boot analysis API
- Deterministic analysis only; no LLM or external API
- Files are processed in memory and are not persisted

## Run locally

Requirements:

- Node.js 22.13 or newer
- Java 17 or newer
- Maven 3.6.3 or newer

Start the Java backend:

```bash
cd backend
mvn spring-boot:run
```

In a second terminal, start the frontend:

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production build

```bash
npm run build
npm start
```

## How it works

The Java backend normalizes log lines into structured events, selects the trace matching the incident clue, orders events across services, and ranks root-cause candidates. It exposes:

```text
POST http://localhost:8080/api/incidents/analyze
Content-Type: multipart/form-data
```

Request fields:

- `files` — one or more `.log`, `.txt`, `.out`, or JSON files
- `clue` — description of what went wrong
- `suspiciousCall` — optional endpoint or call suspected by the investigator

The default UI uses the Java engine. Set `NEXT_PUBLIC_ANALYSIS_ENGINE=browser` only if you intentionally want the original TypeScript fallback.

## Main source

- `app/page.tsx` — interface and Java API integration
- `app/globals.css` — responsive application styling
- `app/layout.tsx` — application metadata
- `backend/src/main/java/com/tracelens/service/LogParser.java` — text and JSON parsing
- `backend/src/main/java/com/tracelens/service/AnalysisService.java` — trace correlation and root ranking

## Live application

[trace-lens.nejatians.chatgpt.site](https://trace-lens.nejatians.chatgpt.site)
