'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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

interface ActionConfirmationPayload {
  id: string;
  createdAt: string;
  reason: string;
  riskLevel: 'high' | 'critical';
  url: string;
  action: string;
  value?: string;
  target?: {
    targetId?: string;
    tag?: string;
    role?: string;
    text?: string;
    href?: string;
  };
}

interface ActionConfirmationClearedPayload {
  id: string;
  approved: boolean;
  source: 'user' | 'timeout' | 'cancelled' | string;
  note?: string;
}

interface ResearchCandidatePayload {
  rank: number;
  title: string;
  score: number;
  price?: number;
  rating?: number;
  reviewCount?: number;
  signals: string[];
}

interface ResearchReportPayload {
  generatedAt: string;
  url: string;
  objective: string;
  siteProfileId: string;
  siteProfileLabel: string;
  metrics: {
    candidateCount: number;
    withPrice: number;
    withRating: number;
    withReviewCount: number;
    averageScore: number;
  };
  topCandidates: ResearchCandidatePayload[];
}

interface CampaignSiteInput {
  name: string;
  url: string;
}

interface CampaignSiteMetrics {
  goalReached: boolean;
  durationMs: number;
  totalSteps: number;
  deadEndRate: number;
  frustrationSignals: number;
  imageSurfaceScore: number;
  journeyScore: number;
}

interface CampaignSiteResult {
  siteName: string;
  siteUrl: string;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  metrics?: CampaignSiteMetrics;
  artifacts?: {
    reportPdfUrl?: string;
    reportCsvUrl?: string;
    reportJsonUrl?: string;
    traceJsonUrl?: string;
    traceSpecUrl?: string;
  };
}

interface CampaignResultPayload {
  campaignId: string;
  durationMs: number;
  sites: CampaignSiteResult[];
  comparison: {
    fastestSite?: string;
    mostEfficientSite?: string;
    bestJourneySite?: string;
    bestVisualSite?: string;
    highestFrictionSite?: string;
    highlights: string[];
  };
}

type UseCaseKey =
  | 'product_research'
  | 'appointment_booking'
  | 'checkout_validation'
  | 'workflow_automation'
  | 'competitive_benchmark'
  | 'custom';

interface UseCaseTemplate {
  label: string;
  description: string;
  objective: string;
  successCriteria: string;
  targetUrl: string;
  campaignMode: boolean;
  campaignSitesRaw?: string;
  persona?: string;
  toggles?: {
    debugMode?: boolean;
    saveTrace?: boolean;
    saveThoughts?: boolean;
    saveScreenshots?: boolean;
    headlessMode?: boolean;
    ttsEnabled?: boolean;
  };
}

const DEFAULT_CAMPAIGN_SITES_RAW = [
  'Amazon|https://www.amazon.de',
  'OTTO|https://www.otto.de',
  'MediaMarkt|https://www.mediamarkt.de'
].join('\n');

const USE_CASE_TEMPLATES: Record<Exclude<UseCaseKey, 'custom'>, UseCaseTemplate> = {
  product_research: {
    label: 'Product Research',
    description: 'Vergleiche Produkte mit Preis, Rating, Reviews und klarer Evidence.',
    objective: 'Find the best value product options for the target category and provide evidence-based ranking.',
    successCriteria: 'At least 5 products compared with price, rating and review count; clear top recommendation.',
    targetUrl: 'https://www.amazon.de',
    campaignMode: false,
    persona: 'helmut',
    toggles: {
      debugMode: true,
      saveTrace: true,
      saveThoughts: true,
      saveScreenshots: true,
      headlessMode: false
    }
  },
  appointment_booking: {
    label: 'Appointment Booking',
    description: 'Finde Termin-Slots robust und valide Navigationspfade bis kurz vor finaler Buchung.',
    objective: 'Navigate booking flow, find earliest available slots and stop before final confirmation.',
    successCriteria: 'Earliest slot identified, required fields mapped, and final confirmation step reached safely.',
    targetUrl: 'https://www.doctolib.de',
    campaignMode: false,
    persona: 'dieter',
    toggles: {
      debugMode: true,
      saveTrace: true,
      saveThoughts: true,
      saveScreenshots: true,
      headlessMode: false
    }
  },
  checkout_validation: {
    label: 'Checkout Validation',
    description: 'Teste Warenkorb- und Checkout-Reibung ohne finale Bestellung auszufuehren.',
    objective: 'Validate checkout usability and friction from product page to final review step without placing the order.',
    successCriteria: 'Cart, shipping, payment and review steps reached with friction points and blockers documented.',
    targetUrl: 'https://www.amazon.de',
    campaignMode: false,
    persona: 'lukas',
    toggles: {
      debugMode: true,
      saveTrace: true,
      saveThoughts: true,
      saveScreenshots: true,
      headlessMode: false
    }
  },
  workflow_automation: {
    label: 'Workflow Automation',
    description: 'Fuehre strukturierte Website-Aufgaben fuer Ops/Backoffice stabil und reproduzierbar aus.',
    objective: 'Complete the defined web workflow end-to-end and extract all required output fields.',
    successCriteria: 'Workflow completed with no dead-end loops and exportable step-by-step trace.',
    targetUrl: 'https://example.com',
    campaignMode: false,
    persona: 'bare',
    toggles: {
      debugMode: false,
      saveTrace: true,
      saveThoughts: true,
      saveScreenshots: true,
      headlessMode: false
    }
  },
  competitive_benchmark: {
    label: 'Competitive Benchmark',
    description: 'Vergleiche mehrere Websites in Journey, Friction und visueller Qualitaet.',
    objective: 'Benchmark competitor user journeys and identify usability, conversion and content quality differences.',
    successCriteria: 'At least 3 sites compared with report, highlights and ranking summary.',
    targetUrl: 'https://www.amazon.de',
    campaignMode: true,
    campaignSitesRaw: DEFAULT_CAMPAIGN_SITES_RAW,
    persona: 'lukas',
    toggles: {
      debugMode: true,
      saveTrace: true,
      saveThoughts: true,
      saveScreenshots: true,
      headlessMode: false
    }
  }
};

export default function DriveDashboard() {
  const initialTemplate = USE_CASE_TEMPLATES.product_research;

  // State
  const [useCase, setUseCase] = useState<UseCaseKey>('product_research');
  const [url, setUrl] = useState(initialTemplate.targetUrl);
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
      beruf: 'Engineering & Research',
      technik: 'MacBook Pro, power-user',
      geduld: '🔍 Geduldig bei Deep Research',
      fokus: 'Specs, Compare, Decision Quality',
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
    legal_eu: {
      name: 'Legal EU Auditor',
      alter: 'N/A',
      beruf: 'Compliance Analyst',
      technik: 'Regulatory Reasoning',
      geduld: '⚖️ Konservativ',
      fokus: 'Rechts- und Quellenbezug',
      emoji: '⚖️'
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
  const [objective, setObjective] = useState(initialTemplate.objective);
  const [successCriteria, setSuccessCriteria] = useState(initialTemplate.successCriteria);
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
  const [campaignMode, setCampaignMode] = useState(false);
  const [campaignSitesRaw, setCampaignSitesRaw] = useState(
    DEFAULT_CAMPAIGN_SITES_RAW
  );
  const [campaignRunning, setCampaignRunning] = useState(false);
  const [campaignResult, setCampaignResult] = useState<CampaignResultPayload | null>(null);
  const [modelName, setModelName] = useState('gemini-2.0-flash');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
  ]);
  const isMonkeyMode = persona === 'monkey';
  const isBareLlmMode = persona === 'bare';
  const activeProfile = personaProfiles[persona];
  const stepCount = steps.length;
  const compactModelName = modelName.length > 24 ? `${modelName.slice(0, 21)}...` : modelName;
  const isSingleRunBusy = status !== 'idle' && status !== 'stopped';
  const [traceDownload, setTraceDownload] = useState<{ specUrl: string | null; jsonUrl: string | null }>(
    { specUrl: null, jsonUrl: null }
  );
  const [reportDownload, setReportDownload] = useState<{ pdfUrl: string | null; csvUrl: string | null; jsonUrl: string | null }>(
    { pdfUrl: null, csvUrl: null, jsonUrl: null }
  );
  const [pendingConfirmation, setPendingConfirmation] = useState<ActionConfirmationPayload | null>(null);
  const [researchReport, setResearchReport] = useState<ResearchReportPayload | null>(null);
  const selectedUseCaseTemplate = useMemo(
    () => (useCase === 'custom' ? null : USE_CASE_TEMPLATES[useCase]),
    [useCase]
  );
  const compactUseCaseName = (selectedUseCaseTemplate?.label || 'Custom').toUpperCase();

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

  const applyUseCaseTemplate = useCallback((nextUseCase: UseCaseKey) => {
    if (nextUseCase === 'custom') return;
    const template = USE_CASE_TEMPLATES[nextUseCase];

    setUrl(template.targetUrl);
    setObjective(template.objective);
    setSuccessCriteria(template.successCriteria);
    setCampaignMode(template.campaignMode);
    if (template.campaignSitesRaw) {
      setCampaignSitesRaw(template.campaignSitesRaw);
    } else if (!template.campaignMode) {
      setCampaignSitesRaw(DEFAULT_CAMPAIGN_SITES_RAW);
    }
    if (template.persona) {
      setPersona(template.persona);
    }

    if (template.toggles) {
      if (typeof template.toggles.debugMode === 'boolean') setDebugMode(template.toggles.debugMode);
      if (typeof template.toggles.saveTrace === 'boolean') setSaveTrace(template.toggles.saveTrace);
      if (typeof template.toggles.saveThoughts === 'boolean') setSaveThoughts(template.toggles.saveThoughts);
      if (typeof template.toggles.saveScreenshots === 'boolean') setSaveScreenshots(template.toggles.saveScreenshots);
      if (typeof template.toggles.headlessMode === 'boolean') setHeadlessMode(template.toggles.headlessMode);
      if (typeof template.toggles.ttsEnabled === 'boolean') setTtsEnabled(template.toggles.ttsEnabled);
    }

    addLogRef.current('status', `Template applied: ${template.label}`);
  }, []);

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

  const submitActionConfirmation = useCallback(async (approved: boolean) => {
    const current = pendingConfirmation;
    if (!current) return;

    const payload = {
      id: current.id,
      approved,
      note: approved ? 'approved via ui' : 'rejected via ui'
    };

    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'action_confirmation',
          payload
        }));
      } else {
        await fetch('http://localhost:3001/confirm-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      addLogRef.current('status', `Risk action ${approved ? 'approved' : 'rejected'}: ${current.action.toUpperCase()}`);
      setPendingConfirmation((prev) => (prev?.id === current.id ? null : prev));
    } catch {
      addLogRef.current('error', 'Action confirmation konnte nicht gesendet werden.');
    }
  }, [pendingConfirmation]);

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
      addLogRef.current('status', 'Connected to AJETE Backend');
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
        case 'confirmation_required':
          // eslint-disable-next-line no-case-declarations
          const confirmPayload = data.payload as ActionConfirmationPayload;
          setPendingConfirmation(confirmPayload);
          addLogRef.current(
            'status',
            `Risk Gate: waiting for approval (${confirmPayload.action.toUpperCase()}${confirmPayload.target?.targetId ? ` #${confirmPayload.target.targetId}` : ''})`
          );
          break;
        case 'confirmation_cleared':
          // eslint-disable-next-line no-case-declarations
          const cleared = data.payload as ActionConfirmationClearedPayload;
          setPendingConfirmation((prev) => (prev?.id === cleared.id ? null : prev));
          addLogRef.current('status', `Risk Gate resolved: ${cleared.approved ? 'APPROVED' : 'REJECTED'} (${cleared.source})`);
          break;
        case 'research_report':
          // eslint-disable-next-line no-case-declarations
          const researchPayload = data.payload as ResearchReportPayload;
          setResearchReport(researchPayload);
          addLogRef.current(
            'status',
            `Research report updated (${researchPayload.topCandidates.length} candidates, avg ${researchPayload.metrics.averageScore})`
          );
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
    if (campaignMode) return;
    setLogs([]);
    setSteps([]);
    setTraceDownload({ specUrl: null, jsonUrl: null });
    setReportDownload({ pdfUrl: null, csvUrl: null, jsonUrl: null });
    setCampaignResult(null);
    setPendingConfirmation(null);
    setResearchReport(null);
    try {
      if (ttsEnabled) {
        await ensureTtsAudioContext();
      }
      const payloadObjective = isMonkeyMode
        ? ''
        : [objective.trim(), successCriteria.trim() ? `Success criteria: ${successCriteria.trim()}` : '']
          .filter(Boolean)
          .join('\n\n');
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
      setCampaignRunning(false);
      setPendingConfirmation(null);
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

  const parseCampaignSites = useCallback((): CampaignSiteInput[] => {
    const lines = campaignSitesRaw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const sites: CampaignSiteInput[] = [];
    for (const line of lines) {
      const parts = line.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
      const rawUrl = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      try {
        const parsed = new URL(normalizedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        const fallbackName = parsed.hostname.replace(/^www\./, '') || 'site';
        const rawName = parts.length > 1 ? parts.slice(0, -1).join(' | ') : fallbackName;
        sites.push({
          name: rawName || fallbackName,
          url: parsed.toString()
        });
      } catch {
        // skip malformed line
      }
    }

    return sites.slice(0, 10);
  }, [campaignSitesRaw]);

  const handleRunCampaign = async () => {
    if (campaignRunning) return;
    const sites = parseCampaignSites();
    if (sites.length === 0) {
      addLog('error', 'Benchmark benötigt mindestens eine gültige Site (Format: Name|https://example.com)');
      return;
    }

    setCampaignRunning(true);
    setCampaignResult(null);
    setLogs([]);
    setSteps([]);
    setTraceDownload({ specUrl: null, jsonUrl: null });
    setReportDownload({ pdfUrl: null, csvUrl: null, jsonUrl: null });
    setPendingConfirmation(null);
    setResearchReport(null);

    try {
      if (ttsEnabled) {
        await ensureTtsAudioContext();
      }

      const payloadObjective = isMonkeyMode
        ? ''
        : [objective.trim(), successCriteria.trim() ? `Success criteria: ${successCriteria.trim()}` : '']
          .filter(Boolean)
          .join('\n\n');
      const res = await fetch('http://localhost:3001/campaign/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sites,
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
      if (!res.ok || data?.error) {
        addLog('error', data?.error || 'Benchmark konnte nicht gestartet werden');
        return;
      }

      setCampaignResult(data as CampaignResultPayload);
      addLog('status', `Benchmark abgeschlossen (${sites.length} Sites, ${(Number(data.durationMs || 0) / 1000).toFixed(1)}s)`);
    } catch {
      addLog('error', 'Benchmark API ist nicht erreichbar');
    } finally {
      setCampaignRunning(false);
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
    <div className="drive-shell flex min-h-full flex-col overflow-hidden lg:h-full lg:flex-row">
      <div className="drive-sidebar custom-scrollbar w-full overflow-y-auto p-5 sm:p-6 lg:w-[372px] lg:flex-shrink-0 lg:gap-6">
        <div className="drive-panel min-w-0 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-[#3b5f84] bg-[#0b2a47] p-2 shadow-[0_8px_20px_rgba(0,93,164,0.32)]">
              <Cpu className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="font-display text-3xl leading-none text-white">AJETE</h1>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9db6d3]">Agent Operations Suite</p>
              <p className="mt-1 text-[10px] leading-4 text-[#7fa6ca]">
                Autonomous Job Execution &amp; Testing Engine
              </p>
            </div>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-[linear-gradient(90deg,#66c7ff_0%,#0066b1_40%,#4ea4da_73%,#d34d5a_100%)]" />
        </div>

        <div className="drive-panel mt-4 min-w-0 space-y-4 p-4">
          <div>
            <label className="drive-label mb-2 block">Use Case Template</label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                value={useCase}
                onChange={(e) => setUseCase(e.target.value as UseCaseKey)}
                className="drive-select text-sm"
              >
                <option value="product_research">Product Research</option>
                <option value="appointment_booking">Appointment Booking</option>
                <option value="checkout_validation">Checkout Validation</option>
                <option value="workflow_automation">Workflow Automation</option>
                <option value="competitive_benchmark">Competitive Benchmark</option>
                <option value="custom">Custom</option>
              </select>
              <button
                type="button"
                onClick={() => applyUseCaseTemplate(useCase)}
                disabled={useCase === 'custom'}
                className="drive-btn drive-btn--secondary !px-3 !py-2 !text-xs"
              >
                Apply
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-[#7c95b4]">
              {selectedUseCaseTemplate
                ? selectedUseCaseTemplate.description
                : 'Custom mode: define URL, objective and success criteria manually.'}
            </p>
          </div>

          <div>
            <label className="drive-label mb-2 block">Target URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={campaignMode}
              className="drive-input text-sm"
              placeholder={campaignMode ? 'Single URL in Benchmark Mode deaktiviert' : 'https://...'}
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
              <option value="helmut">🏍️ Helmut (35, Research Power User)</option>
              <option value="legal_eu">⚖️ Legal EU Auditor</option>
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
            <label className="drive-label mb-2 block">Task Objective</label>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              disabled={isMonkeyMode}
              className="drive-textarea h-24 resize-none text-sm"
              placeholder={isMonkeyMode ? 'In Monkey Mode nicht aktiv' : "e.g. Find top 5 products with best value and explain ranking"}
            />
          </div>

          <div>
            <label className="drive-label mb-2 block">Success Criteria</label>
            <textarea
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              disabled={isMonkeyMode}
              className="drive-textarea h-20 resize-none text-sm"
              placeholder={isMonkeyMode ? 'In Monkey Mode nicht aktiv' : 'e.g. include price, rating and review evidence for each recommendation'}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#2e486a] bg-[#071527]/75 px-3 py-2">
            <span className="drive-label !mb-0">Benchmark Mode</span>
            <button
              type="button"
              onClick={() => setCampaignMode((prev) => !prev)}
              data-on={campaignMode}
              className="drive-toggle"
            >
              {campaignMode ? 'ON' : 'OFF'}
            </button>
          </div>

          {campaignMode && (
            <div>
              <label className="drive-label mb-2 block">Benchmark Sites</label>
              <textarea
                value={campaignSitesRaw}
                onChange={(e) => setCampaignSitesRaw(e.target.value)}
                className="drive-textarea h-28 resize-y text-sm"
                placeholder={'Amazon|https://www.amazon.de\nOTTO|https://www.otto.de'}
              />
              <p className="mt-1 text-[11px] text-[#7c95b4]">
                Eine Site pro Zeile. Format: Name|URL oder nur URL. Maximal 10 Sites.
              </p>
            </div>
          )}

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

        {campaignMode ? (
          <div className="flex gap-3">
            <button
              onClick={handleRunCampaign}
              disabled={campaignRunning || isSingleRunBusy}
              className="drive-btn drive-btn--primary flex-1"
            >
              <Layers3 size={16} className="fill-current" /> {campaignRunning ? 'Running Benchmark...' : 'Run Benchmark'}
            </button>
            <button
              onClick={handleStop}
              disabled={!campaignRunning && !isSingleRunBusy}
              className="drive-btn drive-btn--danger flex-1"
            >
              <Square size={16} className="fill-current" /> Abort
            </button>
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={isSingleRunBusy || campaignRunning}
              className="drive-btn drive-btn--primary flex-1"
            >
              <Play size={16} className="fill-current" /> Initialize
            </button>
            <button
              onClick={handleStop}
              disabled={!isSingleRunBusy}
              className="drive-btn drive-btn--danger flex-1"
            >
              <Square size={16} className="fill-current" /> Abort
            </button>
          </div>
        )}

        {pendingConfirmation && (
          <div className="drive-panel mt-3 border-[#5f2d36] bg-[linear-gradient(160deg,rgba(56,18,24,0.66),rgba(22,8,12,0.9))] p-3">
            <p className="drive-label mb-1 block text-[#ffb4bf]">Risk Confirmation Required</p>
            <p className="text-xs leading-5 text-[#ffdce1]">
              {pendingConfirmation.riskLevel.toUpperCase()} | {pendingConfirmation.action.toUpperCase()}
              {pendingConfirmation.target?.targetId ? ` #${pendingConfirmation.target.targetId}` : ''}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-[#ffdce1]/90">{pendingConfirmation.reason}</p>
            {pendingConfirmation.target?.text && (
              <p className="mt-1 text-[11px] leading-5 text-[#ffdce1]/85">
                Target: {pendingConfirmation.target.text}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void submitActionConfirmation(false)}
                className="drive-btn drive-btn--danger !py-2 !text-xs"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => void submitActionConfirmation(true)}
                className="drive-btn drive-btn--primary !py-2 !text-xs"
              >
                Approve
              </button>
            </div>
          </div>
        )}

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

        {researchReport && (
          <div className="drive-panel mt-3 p-3">
            <p className="drive-label mb-1 block">Research Scoreboard</p>
            <p className="mb-2 text-[11px] text-[#7c95b4]">
              {researchReport.siteProfileLabel} | avg {researchReport.metrics.averageScore} | candidates {researchReport.metrics.candidateCount}
            </p>
            <div className="space-y-2">
              {researchReport.topCandidates.slice(0, 4).map((candidate) => (
                <div key={`research-candidate-${candidate.rank}-${candidate.title}`} className="rounded-md border border-[#24415f] bg-[#081829]/70 px-2.5 py-2">
                  <p className="text-xs font-medium text-[#dff0ff]">
                    #{candidate.rank} {candidate.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[#8fb3d5]">
                    Score {candidate.score}
                    {candidate.price !== undefined ? ` | ${candidate.price}` : ''}
                    {candidate.rating !== undefined ? ` | Rating ${candidate.rating}` : ''}
                    {candidate.reviewCount !== undefined ? ` | Reviews ${candidate.reviewCount}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {campaignResult && (
          <div className="drive-panel mt-3 p-3">
            <p className="drive-label mb-1 block">Benchmark Comparison</p>
            <p className="mb-2 text-[11px] text-[#7c95b4]">
              {campaignResult.campaignId} | {(campaignResult.durationMs / 1000).toFixed(1)}s total
            </p>
            <div className="space-y-1 text-xs text-[#d4e4f7]">
              {campaignResult.comparison.highlights.map((highlight, idx) => (
                <p key={`campaign-highlight-${idx}`}>- {highlight}</p>
              ))}
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[540px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#27405b] text-left text-[#88a7c8]">
                    <th className="py-1 pr-2 font-medium">Site</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                    <th className="py-1 pr-2 font-medium">Journey</th>
                    <th className="py-1 pr-2 font-medium">Steps</th>
                    <th className="py-1 pr-2 font-medium">Dead Ends</th>
                    <th className="py-1 pr-2 font-medium">Image</th>
                    <th className="py-1 pr-2 font-medium">Report</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignResult.sites.map((site, index) => (
                    <tr key={`campaign-site-${index}-${site.siteName}`} className="border-b border-[#1b2f45]/70 text-[#d4e4f7]">
                      <td className="py-1 pr-2">{site.siteName}</td>
                      <td className="py-1 pr-2">{site.status.toUpperCase()}</td>
                      <td className="py-1 pr-2">{site.metrics ? `${site.metrics.journeyScore}` : '-'}</td>
                      <td className="py-1 pr-2">{site.metrics ? `${site.metrics.totalSteps}` : '-'}</td>
                      <td className="py-1 pr-2">{site.metrics ? `${(site.metrics.deadEndRate * 100).toFixed(1)}%` : '-'}</td>
                      <td className="py-1 pr-2">{site.metrics ? `${site.metrics.imageSurfaceScore}` : '-'}</td>
                      <td className="py-1 pr-2">
                        {site.artifacts?.reportPdfUrl ? (
                          <a
                            href={`http://localhost:3001${site.artifacts.reportPdfUrl}`}
                            className="drive-download-link !px-2 !py-1"
                            target="_blank"
                            rel="noreferrer"
                          >
                            PDF
                          </a>
                        ) : site.error ? (
                          <span className="text-[#f17b89]">Error</span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                <span className="drive-chip-label">Use Case</span>
                <span className="drive-chip-value">{compactUseCaseName}</span>
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
              <span className={`drive-chip drive-chip--metric ${campaignMode ? 'drive-chip--on' : ''}`}>
                <span className="drive-chip-label">Mode</span>
                <span className="drive-chip-value">{campaignMode ? 'BENCHMARK' : 'SINGLE'}</span>
              </span>
              {pendingConfirmation && (
                <span className="drive-chip drive-chip--metric drive-chip--warn">
                  <span className="drive-chip-label">Risk Gate</span>
                  <span className="drive-chip-value">WAITING</span>
                </span>
              )}
              {researchReport && (
                <span className="drive-chip drive-chip--metric drive-chip--on">
                  <span className="drive-chip-label">Research</span>
                  <span className="drive-chip-value">LIVE</span>
                </span>
              )}
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
