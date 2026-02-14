# DRIVE

**D**igital **R**easoning & **I**ntelligent **V**ision **E**ngine  
Prototype for autonomous web journeys and UX simulation.

## Overview

DRIVE consists of:

- `backend/`: Playwright-based browser agent + Gemini integration (vision/action loop, SoM overlays, cursor simulation, TTS, tab-following).
- `frontend/`: Control dashboard (persona selection, model selection, debug mode, TTS toggle, headless toggle, live stream + mind stream).

## Features

- Persona-based browsing (`Dieter`, `Lukas`, `Helmut`, `Bare LLM`, `Monkey`)
- Set-of-Marks (SoM) element overlays
- Human-like ghost cursor movement
- Cookie banner handling with DOM + coordinate fallback
- Gemini model selection from API
- Optional Gemini TTS playback of thoughts (blocking until playback ends)
- Optional headless browser execution
- Auto-follow when clicks open a new tab

## Project Structure

```text
drive/
  backend/
  frontend/
```

## Prerequisites

- Node.js 20+ (recommended)
- npm
- A Gemini API key

## Setup

### 1) Backend

```bash
cd backend
cp .env.example .env
```

Set your key in `backend/.env`:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Install and run:

```bash
npm install
npm run dev
```

Backend runs on `http://localhost:3001`.

### 2) Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:3000`.

## Security

- Never commit real API keys.
- Use `backend/.env` for local secrets.
- Keep only template values in `.env.example`.

## Notes

- TTS in browsers may require one user interaction to unlock audio playback.
- In headless mode, UI streaming still works via backend screenshots.

