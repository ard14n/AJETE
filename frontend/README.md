# DRIVE Control Center (Frontend)

DRIVE is a prototype control center for evaluating browser-agent behavior on real websites.
This frontend provides a live operator cockpit for:

- live visual stream from the active browser page
- persona-driven mission runs
- runtime control toggles (debug, TTS, headless, trace/report persistence)
- reasoning and action timeline (“Mind Stream”)
- downloadable artifacts for QA and regression workflows

The UI is optimized for fast operator feedback loops in simulation and test scenarios (e.g. BMW digital journeys).

## What DRIVE does

A backend browser agent (Playwright + Gemini) explores a target website and sends a real-time stream to this UI.
The agent:

- scans pages with **Set-of-Marks (SoM)** overlays
- reasons step-by-step in persona mode, bare LLM mode, or monkey mode
- executes actions (`click`, `type`, `scroll`, `wait`)
- follows popups/new tabs automatically
- can synthesize persona thoughts via Gemini TTS

The frontend renders all of this in real time and allows run orchestration.

## Core Concepts

## 1) Set-of-Marks (SoM)

SoM draws numbered overlays on interactive elements in the page screenshot.
These IDs are used by the model for grounded interaction decisions.

- `Debug Marks = ON`: overlays are visible in operator stream.
- `Debug Marks = OFF`: overlays are hidden in operator stream.
- LLM still receives marked context for grounded targeting.

## 2) Human-like Cursor

DRIVE uses a visual “ghost cursor” to make actions easier to follow:

- smooth path movement
- click pulse feedback
- synchronized with action execution and stream rendering

## 3) Persona Modes

The UI supports different operating personas and test modes:

- domain personas (e.g. Helmut, Dieter, Lukas)
- accessibility personas (A11y and A11y Keyboard)
- `Bare LLM` (no persona rules)
- `Monkey Mode` (random exploration/fuzz behavior)

## 4) Artifact-first Testing

Each run can persist artifacts for deterministic replay and reporting.

## Feature Toggles

The sidebar exposes runtime toggles:

- `Debug Marks`
- `Voice TTS`
- `Headless Browser`
- `Save Trace`
- `Save Thoughts`
- `Save Screenshots`

### Save Trace

When enabled, DRIVE exports:

- trace JSON (step-level machine-readable data)
- generated Playwright `.spec.ts` replay script (non-LLM deterministic replay)

### Save Thoughts

When enabled, DRIVE exports:

- `thoughts.json`
- `thoughts.txt`

### Save Screenshots

When enabled, DRIVE exports per-step screenshots from the live stream frame.

## Report Generator

At run end, DRIVE generates report artifacts automatically:

- `report.pdf` (operator-ready summary)
- `steps.csv` (Excel-compatible)
- `report.json` (structured full report)

The report includes:

- run metadata (persona, model, objective, timing)
- action breakdown
- totals: steps, thoughts, screenshots, errors
- unique target count
- failed target count
- recent thought timeline
- embedded screenshot previews

## Artifact Structure

Artifacts are served by backend via `/downloads/*` and stored under:

```text
backend/artifacts/<run-id>/
  trace/
    trace-<run-id>.json
    trace-<run-id>.spec.ts
  thoughts/
    thoughts.json
    thoughts.txt
  screenshots/
    step-0001.png
    step-0002.png
    ...
  report/
    report.pdf
    steps.csv
    report.json
```

The frontend automatically shows download buttons as soon as `trace_saved` and/or `report_ready` events arrive.

## Local Setup

This folder contains the Next.js UI only.
The agent backend must run separately on `http://localhost:3001`.

## Prerequisites

- Node.js 18+
- npm
- running backend service at `localhost:3001`

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run build
npm run start
```

## Lint

```bash
npm run lint
```

## Backend Contract (used by this UI)

### HTTP

- `POST /start` starts a run
- `POST /stop` stops a run
- `GET /models` returns available Gemini models

### WebSocket events consumed by UI

- `status`
- `thought`
- `step`
- `screenshot`
- `cursor`
- `tts`
- `trace_saved`
- `report_ready`
- `error`

## Frontend Highlights

- modern dashboard layout with BMW-inspired visual language
- responsive live-feed scaling
- status/metric chips for model, steps, flags, and websocket state
- mission timeline with timestamped thought/action logs
- direct artifact download actions after each run

## Intended Usage

DRIVE is designed as an agent behavior prototype for:

- UX journey simulation
- regression trace capture
- explainable step-by-step demo runs
- accessibility-focused exploratory testing
- deterministic replay pipeline handoff to classic Playwright tests

## Notes

- This frontend does not include secrets.
- Gemini API keys belong in backend `.env` only.
- Do not commit real credentials.
