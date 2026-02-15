'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Terminal, Cpu, Eye, Gauge, ShieldCheck, Layers3 } from 'lucide-react';

// Types
interface Log {
  id: string;
  type: 'thought' | 'action' | 'error' | 'status';
  message: string;
  timestamp: string;
}

interface Step {
  id: number;
  thought: string;
  action: string;
  targetId?: string;
  value?: string;
}

interface CursorPayload {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}

interface ModelOption {
  id: string;
  name: string;
}

interface TTSPayload {
  id: string;
  text: string;
  mimeType: string;
  audioBase64: string;
}

interface TraceSavedPayload {
  jsonPath: string;
  specPath: string;
  steps: number;
  jsonUrl?: string;
  specUrl?: string;
}

interface ReportReadyPayload {
  runId: string;
  jsonPath: string;
  csvPath: string;
  pdfPath: string;
  jsonUrl: string;
  csvUrl: string;
  pdfUrl: string;
}

export default function DriveDashboard() {
  // State
  const [url, setUrl] = useState('https://www.bmw-motorrad.de');
  const [persona, setPersona] = useState('helmut');

  // Persona profiles for dashboard display
  const personaProfiles: Record<string, { name: string; alter: string; beruf: string; technik: string; geduld: string; fokus: string; emoji: string }> = {
    dieter: {
      name: 'Dieter Krause',
      alter: '54 Jahre',
      beruf: 'Versicherungs-Sachbearbeiter',
      technik: 'Windows, Zoom 125%, nur Google',
      geduld: '⚡ Max. 3 Klicks',
      fokus: 'Einfachheit, große Buttons',
      emoji: '🧓'
    },
    lukas: {
      name: 'Lukas Chen',
      alter: '25 Jahre',
      beruf: 'UX-Designer, Startup Berlin',
      technik: 'iPhone 14, Mobile-First',
      geduld: '🎯 Analytisch & effizient',
      fokus: 'Touch-Targets, Responsive',
      emoji: '📱'
    },
    a11y: {
      name: 'Miriam Schneider',
      alter: '41 Jahre',
      beruf: 'Accessibility Consultant',
      technik: 'Desktop, Zoom & Reduced Motion',
      geduld: '🧭 Methodisch & aufmerksam',
      fokus: 'Labels, Verständlichkeit, Zugänglichkeit',
      emoji: '♿'
    },
    a11y_keyboard: {
      name: 'Miriam Schneider',
      alter: '41 Jahre',
      beruf: 'Accessibility Consultant (Keyboard)',
      technik: 'Keyboard-only, Reduced Motion, Desktop',
      geduld: '⌨️ Sehr strukturiert',
      fokus: 'Tab-Reihenfolge, Fokus, Tastaturbedienbarkeit',
      emoji: '⌨️'
    },
    helmut: {
      name: 'Helmut Berger',
      alter: '35 Jahre',
      beruf: 'Ingenieur bei Bosch',
      technik: 'MacBook Pro, tech-versiert',
      geduld: '🔍 Geduldig bei Recherche',
      fokus: 'Technische Daten, Konfigurator',
      emoji: '🏍️'
    },
    bare: {
      name: 'Bare LLM',
      alter: 'N/A',
      beruf: 'Neutraler Agent',
      technik: 'Keine Persona-Regeln',
      geduld: '🧪 Modellgetrieben',
      fokus: 'Aufgabe + visuelle Evidenz',
      emoji: '🤖'
    },
    monkey: {
      name: 'Monkey Mode',
      alter: 'N/A',
      beruf: 'Random Agent',
      technik: 'Zufallsaktionen ohne Persona',
      geduld: '🎲 Chaotisch',
      fokus: 'Fuzzing & Exploratives Klicken',
      emoji: '🐒'
    }
  };
  const [objective, setObjective] = useState('');
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState<Log[]>([]);
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [cursor, setCursor] = useState<CursorPayload | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [liveViewSize, setLiveViewSize] = useState({ width: 0, height: 0 });
  const [debugMode, setDebugMode] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [headlessMode, setHeadlessMode] = useState(false);
  const [saveTrace, setSaveTrace] = useState(false);
  const [saveThoughts, setSaveThoughts] = useState(false);
  const [saveScreenshots, setSaveScreenshots] = useState(false);
  const [modelName, setModelName] = useState('gemini-2.0-flash');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
  ]);
  const isMonkeyMode = persona === 'monkey';
  const isBareLlmMode = persona === 'bare';
  const activeProfile = personaProfiles[persona];
  const stepCount = steps.length;
  const compactModelName = modelName.length > 24 ? `${modelName.slice(0, 21)}...` : modelName;
  const [traceDownload, setTraceDownload] = useState<{ specUrl: string | null; jsonUrl: string | null }>(
    { specUrl: null, jsonUrl: null }
  );
  const [reportDownload, setReportDownload] = useState<{ pdfUrl: string | null; csvUrl: string | null; jsonUrl: string | null }>(
    { pdfUrl: null, csvUrl: null, jsonUrl: null }
  );

  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const liveViewRef = useRef<HTMLDivElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioContextRef = useRef<AudioContext | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ttsGainRef = useRef<GainNode | null>(null);

  // Stable addLog via useCallback
  const addLog = useCallback((type: Log['type'], message: string) => {
    setLogs(prev => [...prev, {
      id: `log-${crypto.randomUUID()}`,
      type,
      message,
      timestamp: new Date().toLocaleTimeString()
    }]);
  }, []);

  // Keep a ref to the latest addLog so the WS handler always uses the current one
  const addLogRef = useRef(addLog);
  useEffect(() => {
    addLogRef.current = addLog;
  }, [addLog]);

  const base64ToArrayBuffer = useCallback((base64: string): ArrayBuffer => {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }, []);

  const ensureTtsAudioContext = useCallback(async (): Promise<AudioContext | null> => {
    if (typeof window === 'undefined') return null;
    const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) return null;

    if (!ttsAudioContextRef.current) {
      const ctx = new AudioCtor();
      ttsAudioContextRef.current = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
      ttsGainRef.current = gain;
    }

    const ctx = ttsAudioContextRef.current;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // ignore resume failures
      }
    }

    if (ctx.state === 'running') {
      // One silent tick to keep Safari/iOS happy after unlock gesture.
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ttsGainRef.current || ctx.destination);
        src.start(0);
      } catch {
        // ignore
      }
      return ctx;
    }

    return null;
  }, []);

  const sendTtsDoneAck = useCallback((id: string) => {
    if (!id || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      wsRef.current.send(JSON.stringify({
        type: 'tts_done',
        payload: { id }
      }));
    } catch {
      // ignore send errors
    }
  }, []);

  const playTtsPayload = useCallback((payload: TTSPayload) => {
    if (!payload?.id) return;

    if (!ttsEnabled) {
      sendTtsDoneAck(payload.id);
      return;
    }

    if (!payload.audioBase64) {
      sendTtsDoneAck(payload.id);
      return;
    }

    const play = async () => {
      try {
        if (ttsAudioRef.current) {
          ttsAudioRef.current.pause();
          ttsAudioRef.current = null;
        }
        if (ttsSourceRef.current) {
          try {
            ttsSourceRef.current.stop();
          } catch {
            // ignore
          }
          ttsSourceRef.current = null;
        }

        const ctx = await ensureTtsAudioContext();
        if (!ctx) {
          addLogRef.current('error', 'TTS-Audio konnte nicht gestartet werden. Bitte einmal klicken, um Audio freizugeben.');
          sendTtsDoneAck(payload.id);
          return;
        }

        try {
          const wavBuffer = base64ToArrayBuffer(payload.audioBase64);
          const decoded = await ctx.decodeAudioData(wavBuffer.slice(0));
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.connect(ttsGainRef.current || ctx.destination);
          ttsSourceRef.current = source;
          source.onended = () => {
            if (ttsSourceRef.current === source) {
              ttsSourceRef.current = null;
            }
            sendTtsDoneAck(payload.id);
          };
          source.start(0);
          return;
        } catch {
          // Fallback to HTMLAudio for compatibility edge cases.
        }

        const src = `data:${payload.mimeType || 'audio/wav'};base64,${payload.audioBase64}`;
        const audio = new Audio(src);
        ttsAudioRef.current = audio;

        audio.onended = () => {
          sendTtsDoneAck(payload.id);
        };
        audio.onerror = () => {
          addLogRef.current('error', 'TTS-Audio konnte nicht abgespielt werden.');
          sendTtsDoneAck(payload.id);
        };
        audio.play().catch(() => {
          addLogRef.current('error', 'TTS-Playback wurde vom Browser blockiert. Bitte einmal im Fenster klicken.');
          sendTtsDoneAck(payload.id);
        });
      } catch {
        sendTtsDoneAck(payload.id);
      }
    };

    void play();
  }, [base64ToArrayBuffer, ensureTtsAudioContext, sendTtsDoneAck, ttsEnabled]);

  const playTtsRef = useRef(playTtsPayload);
  useEffect(() => {
    playTtsRef.current = playTtsPayload;
  }, [playTtsPayload]);

  const handleTtsToggle = useCallback(async () => {
    const nextEnabled = !ttsEnabled;
    setTtsEnabled(nextEnabled);
    if (!nextEnabled) return;

    const ctx = await ensureTtsAudioContext();
    if (!ctx) {
      addLogRef.current('error', 'Browser blockiert Audio. Bitte einmal in die Seite klicken und erneut versuchen.');
    }
  }, [ensureTtsAudioContext, ttsEnabled]);

  // WebSocket Connection
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3001');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setIsConnected(true);
      addLogRef.current('status', 'Connected to DRIVE Backend');
      try {
        ws.send(JSON.stringify({ type: 'tts_toggle', payload: { enabled: ttsEnabled } }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'status':
          setStatus(data.payload);
          addLogRef.current('status', `Agent status: ${data.payload}`);
          break;
        case 'thought':
          addLogRef.current('thought', data.payload);
          break;
        case 'screenshot':
          setCurrentImage(data.payload);
          break;
        case 'cursor':
          setCursor(data.payload);
          break;
        case 'step':
          // eslint-disable-next-line no-case-declarations
          const step = data.payload;
          addLogRef.current('action', `${step.action.toUpperCase()} -> ${step.targetId ? '#' + step.targetId : ''} ${step.value ? '"' + step.value + '"' : ''}`);
          setSteps(prev => [...prev, step]);
          break;
        case 'error':
          addLogRef.current('error', data.payload);
          break;
        case 'tts':
          playTtsRef.current(data.payload as TTSPayload);
          break;
        case 'trace_saved':
          // eslint-disable-next-line no-case-declarations
          const traceData = data.payload as TraceSavedPayload;
          addLogRef.current('status', `Trace gespeichert (${traceData.steps} Schritte)`);
          addLogRef.current('status', `Playwright Spec: ${traceData.specPath}`);
          addLogRef.current('status', `Trace JSON: ${traceData.jsonPath}`);
          setTraceDownload({
            specUrl: traceData.specUrl || null,
            jsonUrl: traceData.jsonUrl || null
          });
          break;
        case 'report_ready':
          // eslint-disable-next-line no-case-declarations
          const reportData = data.payload as ReportReadyPayload;
          addLogRef.current('status', `Report bereit (Run ${reportData.runId})`);
          addLogRef.current('status', `PDF: ${reportData.pdfPath}`);
          addLogRef.current('status', `Excel CSV: ${reportData.csvPath}`);
          setReportDownload({
            pdfUrl: reportData.pdfUrl || null,
            csvUrl: reportData.csvUrl || null,
            jsonUrl: reportData.jsonUrl || null
          });
          break;
      }
    };

    ws.onerror = (err) => {
      console.warn('[WS] Error event:', err);
      setIsConnected(false);
      setStatus('idle');
      addLogRef.current('error', 'WebSocket-Verbindung fehlgeschlagen. Läuft das Backend auf ws://localhost:3001?');
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setIsConnected(false);
    };

    return () => {
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
      if (ttsSourceRef.current) {
        try {
          ttsSourceRef.current.stop();
        } catch {
          // ignore
        }
        ttsSourceRef.current = null;
      }
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (!isConnected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      wsRef.current.send(JSON.stringify({ type: 'tts_toggle', payload: { enabled: ttsEnabled } }));
    } catch {
      // ignore
    }
  }, [isConnected, ttsEnabled]);

  useEffect(() => {
    if (!ttsEnabled) return;

    const unlock = () => {
      void ensureTtsAudioContext();
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [ensureTtsAudioContext, ttsEnabled]);

  useEffect(() => {
    const el = liveViewRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setLiveViewSize({ width: rect.width, height: rect.height });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;

    const loadModels = async () => {
      try {
        const res = await fetch('http://localhost:3001/models');
        const data = await res.json();
        const models = Array.isArray(data?.models) ? data.models : [];
        if (!active || models.length === 0) return;

        setAvailableModels(models);
        setModelName((prev) => models.some((m: ModelOption) => m.id === prev) ? prev : models[0].id);
      } catch {
        addLogRef.current('status', 'Model-Liste nicht erreichbar. Fallback auf gemini-2.0-flash.');
      }
    };

    loadModels();
    return () => { active = false; };
  }, []);

  // Scroll to bottom of logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleStart = async () => {
    setLogs([]);
    setSteps([]);
    setTraceDownload({ specUrl: null, jsonUrl: null });
    setReportDownload({ pdfUrl: null, csvUrl: null, jsonUrl: null });
    try {
      if (ttsEnabled) {
        await ensureTtsAudioContext();
      }
      const payloadObjective = isMonkeyMode ? '' : objective;
      const res = await fetch('http://localhost:3001/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          personaName: persona,
          objective: payloadObjective,
          debugMode,
          modelName,
          ttsEnabled,
          headlessMode,
          saveTrace,
          saveThoughts,
          saveScreenshots
        })
      });
      const data = await res.json();
      if (data.error) addLog('error', data.error);
    } catch (e) {
      addLog('error', 'Failed to start agent via API');
    }
  };

  const handleStop = async () => {
    try {
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
      if (ttsSourceRef.current) {
        try {
          ttsSourceRef.current.stop();
        } catch {
          // ignore
        }
        ttsSourceRef.current = null;
      }
      await fetch('http://localhost:3001/stop', { method: 'POST' });
    } catch (e) {
      addLog('error', 'Failed to stop agent via API');
    }
  };

  const getCursorStyle = () => {
    if (!cursor) return null;
    if (liveViewSize.width <= 0 || liveViewSize.height <= 0) return null;
    if (cursor.viewportWidth <= 0 || cursor.viewportHeight <= 0) return null;

    const scale = Math.min(
      liveViewSize.width / cursor.viewportWidth,
      liveViewSize.height / cursor.viewportHeight
    );

    const renderedWidth = cursor.viewportWidth * scale;
    const renderedHeight = cursor.viewportHeight * scale;
    const offsetX = (liveViewSize.width - renderedWidth) / 2;
    const offsetY = (liveViewSize.height - renderedHeight) / 2;
    const x = offsetX + cursor.x * scale;
    const y = offsetY + cursor.y * scale;

    return { left: `${x}px`, top: `${y}px` };
  };

  const cursorStyle = getCursorStyle();

  return (
    <div className="drive-shell flex min-h-screen flex-col overflow-hidden lg:h-screen lg:flex-row">
      <div className="drive-sidebar custom-scrollbar w-full overflow-y-auto p-5 sm:p-6 lg:w-[372px] lg:flex-shrink-0 lg:gap-6">
        <div className="drive-panel min-w-0 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-[#3b5f84] bg-[#0b2a47] p-2 shadow-[0_8px_20px_rgba(0,93,164,0.32)]">
              <Cpu className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="font-display text-3xl leading-none text-white">DRIVE</h1>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9db6d3]">Control Center</p>
              <p className="mt-1 text-[10px] leading-4 text-[#7fa6ca]">
                Digital Reasoning &amp; Intelligent Vision Engine
              </p>
            </div>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-[linear-gradient(90deg,#66c7ff_0%,#0066b1_40%,#4ea4da_73%,#d34d5a_100%)]" />
        </div>

        <div className="drive-panel mt-4 min-w-0 space-y-4 p-4">
          <div>
            <label className="drive-label mb-2 block">Target URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="drive-input text-sm"
              placeholder="https://..."
            />
          </div>

          <div>
            <label className="drive-label mb-2 block">Persona</label>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="drive-select text-sm"
            >
              <option value="dieter">🧓 Dieter (54, Ungeduldig)</option>
              <option value="lukas">📱 Lukas (25, Mobile UX)</option>
              <option value="a11y">♿ Miriam (A11y First)</option>
              <option value="a11y_keyboard">⌨️ Miriam (A11y Keyboard)</option>
              <option value="helmut">🏍️ Helmut (35, Motorrad Fan)</option>
              <option value="bare">🤖 Bare LLM (Keine Persona)</option>
              <option value="monkey">🐒 Monkey Mode (Random)</option>
            </select>
          </div>

          <div>
            <label className="drive-label mb-2 block">LLM Model</label>
            <select
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              disabled={isMonkeyMode}
              className="drive-select text-sm"
            >
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="drive-label mb-2 block">Mission Objective</label>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              disabled={isMonkeyMode}
              className="drive-textarea h-24 resize-none text-sm"
              placeholder={isMonkeyMode ? 'In Monkey Mode nicht aktiv' : "e.g. Find the red car and click 'Buy Now'"}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Debug Marks</span>
            <button
              type="button"
              onClick={() => setDebugMode((prev) => !prev)}
              data-on={debugMode}
              className="drive-toggle"
            >
              {debugMode ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Voice TTS</span>
            <button
              type="button"
              onClick={handleTtsToggle}
              data-on={ttsEnabled}
              className="drive-toggle"
            >
              {ttsEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Headless Browser</span>
            <button
              type="button"
              onClick={() => setHeadlessMode((prev) => !prev)}
              data-on={headlessMode}
              className="drive-toggle"
            >
              {headlessMode ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Save Trace</span>
            <button
              type="button"
              onClick={() => setSaveTrace((prev) => !prev)}
              data-on={saveTrace}
              className="drive-toggle"
            >
              {saveTrace ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Save Thoughts</span>
            <button
              type="button"
              onClick={() => setSaveThoughts((prev) => !prev)}
              data-on={saveThoughts}
              className="drive-toggle"
            >
              {saveThoughts ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Save Screenshots</span>
            <button
              type="button"
              onClick={() => setSaveScreenshots((prev) => !prev)}
              data-on={saveScreenshots}
              className="drive-toggle"
            >
              {saveScreenshots ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <div className="drive-panel mt-4 min-w-0 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-2xl">{activeProfile?.emoji}</span>
            <div>
              <p className="font-display text-xl leading-none text-white">{activeProfile?.name}</p>
              <p className="text-xs uppercase tracking-[0.11em] text-[#90a8c4]">{activeProfile?.alter}</p>
            </div>
          </div>
          {isMonkeyMode ? (
            <div className="drive-profile-note drive-profile-note--warn px-2.5 py-2 text-xs">
              Persona-Logik ist deaktiviert. Der Agent klickt und tippt zufaellig fuer exploratives Testing.
            </div>
          ) : isBareLlmMode ? (
            <div className="drive-profile-note drive-profile-note--bare px-2.5 py-2 text-xs">
              Bare LLM aktiv: keine Persona-Regeln, nur Aufgabe + visuelle Signale.
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#7f99b8]">Beruf</span>
                <span className="max-w-[62%] text-right text-[#d1e3f8]">{activeProfile?.beruf}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#7f99b8]">Technik</span>
                <span className="max-w-[62%] text-right text-[#d1e3f8]">{activeProfile?.technik}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#7f99b8]">Geduld</span>
                <span className="max-w-[62%] text-right text-[#d1e3f8]">{activeProfile?.geduld}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#7f99b8]">Fokus</span>
                <span className="max-w-[62%] text-right text-[#d1e3f8]">{activeProfile?.fokus}</span>
              </div>
            </div>
          )}
        </div>

        <div className="drive-divider my-4" />

        <div className="flex gap-3">
          <button
            onClick={handleStart}
            disabled={status !== 'idle' && status !== 'stopped'}
            className="drive-btn drive-btn--primary flex-1"
          >
            <Play size={16} className="fill-current" /> Initialize
          </button>
          <button
            onClick={handleStop}
            disabled={status === 'idle' || status === 'stopped'}
            className="drive-btn drive-btn--danger flex-1"
          >
            <Square size={16} className="fill-current" /> Abort
          </button>
        </div>

        {(traceDownload.specUrl || traceDownload.jsonUrl || reportDownload.pdfUrl || reportDownload.csvUrl || reportDownload.jsonUrl) && (
          <div className="drive-panel mt-3 p-3">
            <p className="drive-label mb-2 block">Downloads</p>
            <div className="grid grid-cols-1 gap-2">
              {traceDownload.specUrl && (
                <a
                  className="drive-download-link"
                  href={`http://localhost:3001${traceDownload.specUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Trace Spec
                </a>
              )}
              {traceDownload.jsonUrl && (
                <a
                  className="drive-download-link"
                  href={`http://localhost:3001${traceDownload.jsonUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Trace JSON
                </a>
              )}
              {reportDownload.pdfUrl && (
                <a
                  className="drive-download-link"
                  href={`http://localhost:3001${reportDownload.pdfUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Report PDF
                </a>
              )}
              {reportDownload.csvUrl && (
                <a
                  className="drive-download-link"
                  href={`http://localhost:3001${reportDownload.csvUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Report Excel CSV
                </a>
              )}
              {reportDownload.jsonUrl && (
                <a
                  className="drive-download-link"
                  href={`http://localhost:3001${reportDownload.jsonUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Report JSON
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="drive-main flex min-h-[62vh] min-w-0 flex-1 flex-col">
        <div className="drive-live relative flex min-h-[46vh] flex-1 flex-col overflow-hidden bg-[#071423]/55 p-4 sm:p-6 lg:min-h-0">
          <div className="drive-ribbon" />

          <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <h2 className="drive-heading flex items-center gap-2 font-display">
              <Eye size={16} /> Live Vision Feed
            </h2>
            <div className="drive-hud">
              <span className="drive-chip drive-chip--metric">
                <span className="drive-chip-label">
                  <Layers3 size={12} />
                  Model
                </span>
                <span className="drive-chip-value">{compactModelName}</span>
              </span>
              <span className="drive-chip drive-chip--metric">
                <span className="drive-chip-label">
                  <Gauge size={12} />
                  Steps
                </span>
                <span className="drive-chip-value">{stepCount}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${debugMode ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Debug</span>
                <span className="drive-chip-value">{debugMode ? 'ON' : 'OFF'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${ttsEnabled ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Voice</span>
                <span className="drive-chip-value">{ttsEnabled ? 'ON' : 'OFF'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${headlessMode ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Browser</span>
                <span className="drive-chip-value">{headlessMode ? 'HEADLESS' : 'VISIBLE'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${saveTrace ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Trace</span>
                <span className="drive-chip-value">{saveTrace ? 'ON' : 'OFF'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${saveThoughts ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Thoughts</span>
                <span className="drive-chip-value">{saveThoughts ? 'ON' : 'OFF'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${saveScreenshots ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Shots</span>
                <span className="drive-chip-value">{saveScreenshots ? 'ON' : 'OFF'}</span>
              </span>
              <span className={`drive-chip drive-chip--metric ${isConnected ? 'drive-chip--ok' : 'drive-chip--warn'}`}>
                <span className="drive-chip-label">WS</span>
                <span className="drive-chip-value">{isConnected ? 'ONLINE' : 'OFFLINE'}</span>
              </span>
              <span className="drive-chip drive-chip--metric">
                <span className="drive-chip-label">Status</span>
                <span className="drive-chip-value">{status.toUpperCase()}</span>
              </span>
              {status === 'thinking' && <span className="drive-chip drive-chip--metric drive-chip--on">Reasoning...</span>}
            </div>
          </div>

          <div ref={liveViewRef} className="drive-stream-wrap group relative flex-1">
            {currentImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentImage}
                alt="Live Agent View"
                className="h-full w-full bg-[#081321] object-contain opacity-100 transition-opacity duration-300"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-[#7b95b3]">
                <div className="h-16 w-16 animate-spin rounded-full border-2 border-[#324963] border-t-[#65c7ff]" />
                <p className="font-display text-lg uppercase tracking-[0.08em]">Waiting for stream</p>
              </div>
            )}

            {currentImage && cursorStyle && (
              <div
                className="pointer-events-none absolute z-30"
                style={cursorStyle}
              >
                <div className="relative -translate-x-1/2 -translate-y-1/2">
                  <div className="h-4 w-4 rounded-full border border-cyan-100 bg-cyan-300 shadow-[0_0_0_3px_rgba(34,211,238,0.24),0_8px_18px_rgba(2,6,23,0.48)]" />
                </div>
              </div>
            )}

            <div className="pointer-events-none absolute right-4 top-4 flex items-center gap-1.5 rounded-full border border-[#32506d] bg-[#060f1c]/80 px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] text-[#ecf6ff]">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff5c68]" />
              REC
            </div>
          </div>
        </div>

        <div className="drive-log flex h-[42vh] flex-col border-t border-[#203850] bg-[#060e19] p-0 lg:h-1/3">
          <div className="flex items-center justify-between border-b border-[#203850] bg-[#060f1b] px-4 py-3 sm:px-6">
            <h3 className="drive-heading flex items-center gap-2 font-display">
              <Terminal size={16} /> Mind Stream
            </h3>
            <span className="drive-pill flex items-center gap-1.5">
              <ShieldCheck size={12} />
              {isConnected ? 'Connection Secure' : 'Reconnecting'}
            </span>
          </div>

          <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-4 font-mono text-sm">
            {logs.length === 0 && (
              <div className="mt-4 text-center italic text-[#748dad]">System ready. Initialize to begin reasoning.</div>
            )}
            {logs.map((log) => (
              <div key={log.id} className="drive-log-entry flex gap-3">
                <span className="min-w-[64px] py-0.5 text-xs text-[#7189a7]">{log.timestamp}</span>
                <div className="max-w-4xl">
                  {log.type === 'thought' && (
                    <div className="drive-log-thought leading-relaxed font-normal">
                      <span className="drive-log-thought-tag">WAITING FOR INPUT &gt;</span>
                      {log.message}
                    </div>
                  )}
                  {log.type === 'action' && (
                    <div className="drive-log-action inline-block font-medium">
                      {log.message}
                    </div>
                  )}
                  {log.type === 'error' && (
                    <div className="drive-log-error font-medium">
                      Error: {log.message}
                    </div>
                  )}
                  {log.type === 'status' && (
                    <div className="drive-log-status mt-1 mb-1 w-full border-t border-[#27405b]/40 pt-1">
                      --- {log.message} ---
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
