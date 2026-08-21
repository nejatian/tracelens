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

## Run locally

Requires Node.js 22.13 or newer.

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

TraceLens normalizes log lines into structured events, selects the trace matching the incident clue, orders events across services, and ranks root-cause candidates. The current MVP uses deterministic TypeScript analysis and does not connect to an LLM.

## Main source

- `app/page.tsx` — interface, log parsing, trace correlation, and candidate ranking
- `app/globals.css` — responsive application styling
- `app/layout.tsx` — application metadata

## Live application

[trace-lens.nejatians.chatgpt.site](https://trace-lens.nejatians.chatgpt.site)
