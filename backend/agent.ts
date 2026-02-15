import { EventEmitter } from 'events';
import { chromium, Browser, BrowserContext, Locator, Page } from 'playwright';
import { PersonaConfig, PersonaTTSConfig } from './config/personas';
import { injectSoM, setSoMOverlayVisibility, SoMElementMeta, SoMResult } from './utils/som';
import { CursorPoint, ensureVisualCursor, generateHumanCursorPath, moveVisualCursor, showCursorClickEffect } from './utils/cursor';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import path from 'path';

// --- LLM Providers ---

export interface LLMResponse {
    thought: string;
    action: 'click' | 'scroll' | 'type' | 'wait' | 'done' | 'stop';
    targetId?: string;
    value?: string;
}

export interface LLMGenerationOptions {
    bareMode?: boolean;
    modelName?: string;
}

export interface LLMProvider {
    generate(screenshotBase64: string, systemPrompt: string, history: any[], options?: LLMGenerationOptions): Promise<LLMResponse>;
}

interface AgentStartOptions {
    monkeyMode?: boolean;
    debugMode?: boolean;
    bareLlmMode?: boolean;
    modelName?: string;
    ttsEnabled?: boolean;
    headlessMode?: boolean;
    saveTrace?: boolean;
    saveThoughts?: boolean;
    saveScreenshots?: boolean;
}

interface TTSAudioPayload {
    audioBase64: string;
    mimeType: string;
}

type TraceActionType = 'goto' | 'click' | 'type' | 'scroll' | 'wait' | 'tab-switch';

interface TraceStep {
    id: number;
    timestamp: string;
    action: TraceActionType;
    selector?: string;
    value?: string;
    x?: number;
    y?: number;
    deltaY?: number;
    waitMs?: number;
    url: string;
    note?: string;
}

interface TraceExport {
    version: 1;
    createdAt: string;
    runId: string;
    startUrl: string;
    finalUrl: string;
    objective: string;
    persona: string;
    modelName: string;
    steps: TraceStep[];
}

interface ThoughtRecord {
    timestamp: string;
    message: string;
    url: string;
}

interface StepRecord {
    id: number;
    timestamp: string;
    url: string;
    thought: string;
    action: string;
    targetId?: string;
    value?: string;
}

interface ErrorRecord {
    timestamp: string;
    message: string;
}

interface ScreenshotRecord {
    step: number;
    filename: string;
    filePath: string;
    url: string;
}

interface ReportSummary {
    runId: string;
    persona: string;
    objective: string;
    modelName: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    totalSteps: number;
    totalThoughts: number;
    totalErrors: number;
    totalScreenshots: number;
    uniqueTargets: number;
    actionBreakdown: Record<string, number>;
    failedTargetCount: number;
    toggles: {
        saveTrace: boolean;
        saveThoughts: boolean;
        saveScreenshots: boolean;
    };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_TTS_VOICE = 'Kore';
const DEFAULT_TTS_LANGUAGE = 'de-DE';

const extractFirstJsonObject = (text: string): string | null => {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
};

const parseModelJson = (responseText: string): any => {
    const trimmed = responseText.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

    try {
        return JSON.parse(trimmed);
    } catch {
        const jsonBlock = extractFirstJsonObject(trimmed);
        if (!jsonBlock) throw new Error('Invalid JSON response from Gemini');
        return JSON.parse(jsonBlock);
    }
};

const normalizeDecision = (raw: any): LLMResponse => {
    const rawAction = String(raw?.action || '').toLowerCase().trim();
    const mappedAction: LLMResponse['action'] =
        rawAction === 'click' ? 'click' :
            rawAction === 'scroll' ? 'scroll' :
                rawAction === 'type' ? 'type' :
                    rawAction === 'done' ? 'done' :
                        rawAction === 'stop' ? 'stop' :
                            rawAction === 'fail' ? 'done' :
                                'wait';

    const thought = typeof raw?.thought === 'string' && raw.thought.trim().length > 0
        ? raw.thought.trim()
        : 'Ich bin unsicher und warte kurz.';

    const targetId = raw?.targetId !== undefined && raw?.targetId !== null
        ? String(raw.targetId).trim()
        : undefined;

    const rawValue = raw?.value ?? raw?.inputValue;
    const value = typeof rawValue === 'string' ? rawValue : undefined;

    return {
        thought,
        action: mappedAction,
        targetId: targetId || undefined,
        value
    };
};

export class MockProvider implements LLMProvider {
    async generate(screenshotBase64: string, systemPrompt: string, history: any[], options?: LLMGenerationOptions): Promise<LLMResponse> {
        await new Promise(r => setTimeout(r, 1000)); // Simulate thinking
        return {
            thought: "This is a mock response. I am clicking on a random element.",
            action: 'wait',
            targetId: '0'
        };
    }
}

export class GeminiProvider implements LLMProvider {
    private genAI: GoogleGenerativeAI;
    private model: any;
    private modelName: string = "gemini-2.0-flash";

    constructor(apiKey: string) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: this.modelName });
    }

    private getModel(modelName?: string) {
        const desired = (modelName || this.modelName).trim() || this.modelName;
        if (!this.model || desired !== this.modelName) {
            this.modelName = desired;
            this.model = this.genAI.getGenerativeModel({ model: this.modelName });
        }
        return this.model;
    }

    async generate(screenshotBase64: string, systemPrompt: string, history: any[], options?: LLMGenerationOptions): Promise<LLMResponse> {
        const bareMode = Boolean(options?.bareMode);
        // Build history context so the LLM knows what it already did
        let historyContext = '';
        if (history.length > 0) {
            const recentHistory = history.slice(-10); // Last 10 steps
            historyContext = `\n=== BISHERIGE SCHRITTE (${history.length} insgesamt, letzte ${recentHistory.length}) ===\n`;
            recentHistory.forEach((h, i) => {
                historyContext += `Schritt ${history.length - recentHistory.length + i + 1}: ${h.thought} → ${h.action}${h.targetId ? ' #' + h.targetId : ''}${h.value ? ' "' + h.value + '"' : ''}\n`;
            });
            historyContext += `\nWICHTIG: Wiederhole KEINE Aktion, die du schon gemacht hast! Wenn etwas nicht funktioniert hat, probiere einen anderen Weg.\n`;
        }

        const rulesSection = bareMode ? `
=== REGELN ===
1. Sei präzise und beschreibe kurz, was du visuell siehst und warum du die nächste Aktion wählst.
2. Nutze keine Persona oder Rollenspiel-Elemente.
3. Wenn du dein Ziel erreicht hast oder nicht weiterkommst, nutze action "done".
4. Wiederhole nicht unnötig dieselbe Aktion auf derselben ID.
` : `
=== REGELN ===
1. BLEIB IN DEINER ROLLE. Du bist die beschriebene Person. Denke, fühle und reagiere als diese Person.
2. Dein "thought" ist das, was du LAUT SAGST. Sprich natürlich, umgangssprachlich, authentisch.
3. Beschreibe was du siehst, was du davon hältst, und warum du die nächste Aktion wählst.
4. Zeige Emotionen! Frustration, Verwirrung, Begeisterung, Langeweile — alles laut aussprechen.
5. Wenn du dein Ziel erreicht hast oder aufgibst, nutze action "done".
6. WIEDERHOLE NICHT dieselbe Aktion! Wenn du etwas schon geklickt hast, versuche etwas anderes.
`;

        const prompt = `
${systemPrompt ? `${systemPrompt}\n` : ''}

=== AUFGABE ===
Du interagierst visuell mit einer Webseite. Du siehst einen Screenshot mit einem "Set-of-Marks" (SoM) Overlay.
Interaktive Elemente sind mit ROTEN Rahmen und numerischen IDs markiert.

=== METHODE: LAUTES DENKEN (Think Aloud Protocol) ===
Du sprichst ALLE deine Gedanken LAUT aus — als würdest du neben einem UX-Forscher sitzen, der dir zuhört.
Sage alles, was dir durch den Kopf geht: Was du siehst, was du suchst, was dich verwirrt, was dich nervt, was dir gefällt.

Beispiele für lautes Denken:
- "OK, ich bin jetzt auf der Startseite. Ich sehe ein großes Bild mit einem Motorrad. Wo finde ich denn hier die Modelle?"
- "Hmm, das Menü oben hat viele Punkte. Ich probier mal 'Modelle'... da muss es doch sein."
- "Ugh, da kam ein Pop-up. Nervt mich. Wo ist das Kreuz zum Schließen?"
- "Oh, das sieht gut aus! Die R 1300 GS. Mal schauen, was die kostet."
${historyContext}
${rulesSection}

=== AUSGABE ===
Antworte NUR mit validem JSON. Format:
{
  "thought": "Was du gerade LAUT SAGST (Deutsch, Ich-Form, in Charakter, natürlich gesprochen)...",
  "action": "click" | "scroll" | "type" | "wait" | "done",
  "targetId": "Die ID-Nummer im roten Rahmen (nur bei click/type)",
  "value": "Text zum Eintippen (nur bei type)"
}
`;

        const maxRetries = 3;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const model = this.getModel(options?.modelName);
                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: screenshotBase64, mimeType: "image/png" } }
                ]);
                const responseText = result.response.text();
                const parsed = parseModelJson(responseText);
                return normalizeDecision(parsed);
            } catch (error: any) {
                const status = error?.status;
                const isRateLimited = status === 429;
                const isRetriable = isRateLimited || status === 503;

                if (isRetriable && attempt < maxRetries - 1) {
                    const backoffMs = 1200 * (attempt + 1);
                    await sleep(backoffMs);
                    continue;
                }

                if (isRateLimited) {
                    console.error("Gemini Error (429):", error);
                    return {
                        thought: `Rate-Limit bei Gemini (${options?.modelName || this.modelName}) erreicht. Ich warte kurz und versuche es gleich erneut.`,
                        action: 'wait'
                    };
                }

                console.error("Gemini Error:", error);
                return { thought: "Error interacting with AI.", action: 'wait' };
            }
        }

        return { thought: "Error interacting with AI.", action: 'wait' };
    }
}

// --- Agent Core ---

export class DriveAgent extends EventEmitter {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private cursorPosition: CursorPoint = { x: 32, y: 32 };
    public isRunning: boolean = false;
    private isMonkeyMode = false;
    private isBareLlmMode = false;
    private isDebugMode = true;
    private isTtsEnabled = false;
    private isHeadlessMode = false;
    private isSaveTraceEnabled = false;
    private isSaveThoughtsEnabled = false;
    private isSaveScreenshotsEnabled = false;
    private selectedModelName = 'gemini-2.0-flash';
    private history: LLMResponse[] = [];
    private failedTargetIds: Map<string, number> = new Map();
    private stagnationCounter = 0;
    private apiKey?: string;
    private ttsConfig: PersonaTTSConfig = {
        voiceName: DEFAULT_TTS_VOICE,
        languageCode: DEFAULT_TTS_LANGUAGE,
        systemInstruction: ''
    };
    private readonly ttsModelCandidates = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
    private pendingTtsAckId: string | null = null;
    private pendingTtsAckResolve: (() => void) | null = null;
    private pendingTtsAckTimer: ReturnType<typeof setTimeout> | null = null;
    private trackedPages: WeakSet<Page> = new WeakSet<Page>();
    private autoFollowedPages: WeakSet<Page> = new WeakSet<Page>();
    private traceSteps: TraceStep[] = [];
    private traceStepCounter = 0;
    private traceStartUrl = '';
    private traceObjective = '';
    private tracePersonaName = '';
    private traceSavedThisRun = false;
    private currentRunId = '';
    private currentRunDir = '';
    private runStartedAt = '';
    private thoughtLog: ThoughtRecord[] = [];
    private stepLog: StepRecord[] = [];
    private errorLog: ErrorRecord[] = [];
    private screenshotLog: ScreenshotRecord[] = [];
    private generatedTraceJsonPath: string | null = null;
    private generatedTraceSpecPath: string | null = null;
    private generatedReportJsonPath: string | null = null;
    private generatedReportPdfPath: string | null = null;
    private generatedReportCsvPath: string | null = null;
    private llm: LLMProvider;

    constructor(apiKey?: string) {
        super();
        this.apiKey = apiKey;
        if (apiKey) {
            this.llm = new GeminiProvider(apiKey);
        } else {
            console.warn("No API Key provided, using MockProvider");
            this.llm = new MockProvider();
        }

        this.on('thought', (message) => {
            if (typeof message !== 'string') return;
            this.thoughtLog.push({
                timestamp: new Date().toISOString(),
                message,
                url: this.page?.url() || this.traceStartUrl || ''
            });
        });

        this.on('step', (step: any) => {
            if (!step || typeof step !== 'object') return;
            this.stepLog.push({
                id: Number(step.id) || (this.stepLog.length + 1),
                timestamp: new Date().toISOString(),
                url: this.page?.url() || this.traceStartUrl || '',
                thought: typeof step.thought === 'string' ? step.thought : '',
                action: typeof step.action === 'string' ? step.action : '',
                targetId: step.targetId !== undefined && step.targetId !== null ? String(step.targetId) : undefined,
                value: typeof step.value === 'string' ? step.value : undefined
            });
        });

        this.on('error', (err: any) => {
            const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
            this.errorLog.push({
                timestamp: new Date().toISOString(),
                message
            });
        });
    }

    private getArtifactsRootDir() {
        return path.resolve(process.cwd(), 'artifacts');
    }

    private toDownloadUrl(absPath: string): string {
        const relative = path.relative(this.getArtifactsRootDir(), absPath).split(path.sep).join('/');
        return `/downloads/${relative}`;
    }

    private formatIsoForFile(date: Date): string {
        return date.toISOString().replace(/[:.]/g, '-');
    }

    private async initializeRunStorage(personaName: string) {
        const started = new Date();
        const timestamp = this.formatIsoForFile(started);
        const personaSlug = this.sanitizeFileFragment(personaName, 'persona');
        this.currentRunId = `${timestamp}-${personaSlug}`;
        this.currentRunDir = path.join(this.getArtifactsRootDir(), this.currentRunId);
        this.runStartedAt = started.toISOString();
        await fs.mkdir(this.currentRunDir, { recursive: true });
    }

    private sanitizeFileFragment(input: string, fallback: string): string {
        const cleaned = input
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return cleaned || fallback;
    }

    private escapeTsString(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
    }

    private createTraceStep(step: Omit<TraceStep, 'id' | 'timestamp' | 'url'>) {
        if (!this.isSaveTraceEnabled) return;
        this.traceStepCounter += 1;
        this.traceSteps.push({
            id: this.traceStepCounter,
            timestamp: new Date().toISOString(),
            url: this.page?.url() || this.traceStartUrl || '',
            ...step
        });
    }

    private async captureSelectorForLocator(locator: Locator): Promise<string | null> {
        try {
            const selector = await locator.evaluate((el) => {
                const escapeCss = (value: string): string => {
                    const css = (window as any).CSS;
                    if (css?.escape) return css.escape(value);
                    return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
                };

                const quoteAttr = (value: string): string =>
                    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

                const unique = (sel: string): boolean => {
                    try {
                        return document.querySelectorAll(sel).length === 1;
                    } catch {
                        return false;
                    }
                };

                const element = el as HTMLElement;
                const tag = element.tagName.toLowerCase();

                if (element.id) {
                    const idSelector = `#${escapeCss(element.id)}`;
                    if (unique(idSelector)) return idSelector;
                }

                const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
                for (const attr of testAttrs) {
                    const value = element.getAttribute(attr);
                    if (!value) continue;
                    const selector = `[${attr}="${quoteAttr(value)}"]`;
                    if (unique(selector)) return selector;
                }

                if ((tag === 'input' || tag === 'textarea' || tag === 'select')) {
                    const name = element.getAttribute('name');
                    if (name) {
                        const selector = `${tag}[name="${quoteAttr(name)}"]`;
                        if (unique(selector)) return selector;
                    }

                    const placeholder = element.getAttribute('placeholder');
                    if (placeholder) {
                        const selector = `${tag}[placeholder="${quoteAttr(placeholder)}"]`;
                        if (unique(selector)) return selector;
                    }
                }

                if (tag === 'a') {
                    const href = element.getAttribute('href');
                    if (href) {
                        const selector = `a[href="${quoteAttr(href)}"]`;
                        if (unique(selector)) return selector;
                    }
                }

                const ariaLabel = element.getAttribute('aria-label');
                if (ariaLabel) {
                    const selector = `${tag}[aria-label="${quoteAttr(ariaLabel)}"]`;
                    if (unique(selector)) return selector;
                }

                const chain: string[] = [];
                let current: HTMLElement | null = element;
                while (current && current !== document.body && chain.length < 7) {
                    let part = current.tagName.toLowerCase();
                    if (current.id) {
                        part += `#${escapeCss(current.id)}`;
                        chain.unshift(part);
                        break;
                    }

                    const parent = current.parentElement;
                    if (parent) {
                        const sameTagSiblings = Array.from(parent.children)
                            .filter((child) => (child as HTMLElement).tagName === current!.tagName);
                        const position = sameTagSiblings.indexOf(current) + 1;
                        part += `:nth-of-type(${Math.max(1, position)})`;
                    }
                    chain.unshift(part);
                    current = parent as HTMLElement | null;
                }

                const fallback = chain.join(' > ');
                return fallback || null;
            });

            return typeof selector === 'string' && selector.trim().length > 0 ? selector : null;
        } catch {
            return null;
        }
    }

    private csvEscape(value: unknown): string {
        const raw = String(value ?? '');
        if (!/[",\n]/.test(raw)) return raw;
        return `"${raw.replace(/"/g, '""')}"`;
    }

    private buildMetricsSummary(endedAtIso: string): ReportSummary {
        const actionBreakdown: Record<string, number> = {};
        const targetSet = new Set<string>();

        for (const step of this.stepLog) {
            actionBreakdown[step.action] = (actionBreakdown[step.action] || 0) + 1;
            if (step.targetId) targetSet.add(step.targetId);
        }

        const failedTargetCount = Array.from(this.failedTargetIds.values()).reduce((acc, value) => acc + value, 0);
        const startedMs = Date.parse(this.runStartedAt || endedAtIso);
        const endedMs = Date.parse(endedAtIso);
        const durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs)
            ? Math.max(0, endedMs - startedMs)
            : 0;

        return {
            runId: this.currentRunId,
            persona: this.tracePersonaName,
            objective: this.traceObjective,
            modelName: this.selectedModelName,
            startedAt: this.runStartedAt || endedAtIso,
            endedAt: endedAtIso,
            durationMs,
            totalSteps: this.stepLog.length,
            totalThoughts: this.thoughtLog.length,
            totalErrors: this.errorLog.length,
            totalScreenshots: this.screenshotLog.length,
            uniqueTargets: targetSet.size,
            actionBreakdown,
            failedTargetCount,
            toggles: {
                saveTrace: this.isSaveTraceEnabled,
                saveThoughts: this.isSaveThoughtsEnabled,
                saveScreenshots: this.isSaveScreenshotsEnabled
            }
        };
    }

    private async persistThoughtArtifacts() {
        if (!this.isSaveThoughtsEnabled) return;
        if (!this.currentRunDir) return;

        const thoughtDir = path.join(this.currentRunDir, 'thoughts');
        await fs.mkdir(thoughtDir, { recursive: true });

        const jsonPath = path.join(thoughtDir, 'thoughts.json');
        const txtPath = path.join(thoughtDir, 'thoughts.txt');

        const txtContent = this.thoughtLog
            .map((item) => `[${item.timestamp}] ${item.message}`)
            .join('\n');

        await fs.writeFile(jsonPath, JSON.stringify(this.thoughtLog, null, 2), 'utf8');
        await fs.writeFile(txtPath, txtContent, 'utf8');
    }

    private async persistStepScreenshot(stepNumber: number, screenshotBase64: string) {
        if (!this.isSaveScreenshotsEnabled) return;
        if (!this.currentRunDir || !screenshotBase64) return;

        try {
            const screenshotDir = path.join(this.currentRunDir, 'screenshots');
            await fs.mkdir(screenshotDir, { recursive: true });
            const filename = `step-${String(stepNumber).padStart(4, '0')}.png`;
            const filePath = path.join(screenshotDir, filename);
            await fs.writeFile(filePath, Buffer.from(screenshotBase64, 'base64'));
            this.screenshotLog.push({
                step: stepNumber,
                filename,
                filePath,
                url: this.toDownloadUrl(filePath)
            });
        } catch (error) {
            console.warn('Failed to persist screenshot artifact:', error);
        }
    }

    private async buildReportPdf(summary: ReportSummary, outputPath: string) {
        const screenshotPreviews = [];
        for (const shot of this.screenshotLog.slice(0, 12)) {
            try {
                const base64 = await fs.readFile(shot.filePath, 'base64');
                screenshotPreviews.push({
                    step: shot.step,
                    dataUrl: `data:image/png;base64,${base64}`
                });
            } catch {
                // ignore unreadable screenshot
            }
        }

        const actionRows = Object.entries(summary.actionBreakdown)
            .map(([action, count]) => `<tr><td>${action}</td><td style="text-align:right">${count}</td></tr>`)
            .join('');

        const thoughtRows = this.thoughtLog
            .slice(-20)
            .map((thought) => `<tr><td>${thought.timestamp}</td><td>${thought.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td></tr>`)
            .join('');

        const screenshotCards = screenshotPreviews
            .map((shot) => `<div style="break-inside:avoid;margin:0 0 14px 0"><div style="font-size:11px;color:#4f5f76;margin-bottom:4px">Step ${shot.step}</div><img src="${shot.dataUrl}" style="width:100%;border:1px solid #d6dfeb;border-radius:6px" /></div>`)
            .join('');

        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>DRIVE Report ${summary.runId}</title>
<style>
body { font-family: Arial, sans-serif; color:#0f1b2a; margin: 24px; }
h1 { margin: 0 0 6px 0; font-size: 26px; }
h2 { margin: 18px 0 8px 0; font-size: 16px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
th, td { border: 1px solid #d3dce8; padding: 6px 8px; font-size: 12px; vertical-align: top; }
th { background: #f1f6fb; text-align: left; }
.meta { color:#3b4f67; font-size:12px; margin: 2px 0; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
</style>
</head>
<body>
  <h1>DRIVE Session Report</h1>
  <div class="meta"><strong>Run ID:</strong> ${summary.runId}</div>
  <div class="meta"><strong>Persona:</strong> ${summary.persona}</div>
  <div class="meta"><strong>Objective:</strong> ${summary.objective || '-'}</div>
  <div class="meta"><strong>Model:</strong> ${summary.modelName}</div>
  <div class="meta"><strong>Duration:</strong> ${(summary.durationMs / 1000).toFixed(1)}s</div>

  <h2>Metrics</h2>
  <table>
    <tr><th>Total Steps</th><th>Total Thoughts</th><th>Total Screenshots</th><th>Total Errors</th><th>Unique Targets</th></tr>
    <tr><td>${summary.totalSteps}</td><td>${summary.totalThoughts}</td><td>${summary.totalScreenshots}</td><td>${summary.totalErrors}</td><td>${summary.uniqueTargets}</td></tr>
  </table>

  <h2>Action Breakdown</h2>
  <table>
    <tr><th>Action</th><th>Count</th></tr>
    ${actionRows || '<tr><td colspan="2">No actions recorded</td></tr>'}
  </table>

  <h2>Recent Thoughts</h2>
  <table>
    <tr><th>Timestamp</th><th>Thought</th></tr>
    ${thoughtRows || '<tr><td colspan="2">No thoughts recorded</td></tr>'}
  </table>

  <h2>Screenshots (first 12)</h2>
  <div class="grid">
    ${screenshotCards || '<div>No screenshots saved for this run.</div>'}
  </div>
</body>
</html>`;

        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
            await page.setContent(html, { waitUntil: 'domcontentloaded' });
            await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
        } finally {
            await browser.close();
        }
    }

    private async persistReportArtifacts() {
        if (!this.currentRunDir) return;

        const endedAt = new Date().toISOString();
        const summary = this.buildMetricsSummary(endedAt);
        const reportDir = path.join(this.currentRunDir, 'report');
        await fs.mkdir(reportDir, { recursive: true });

        const reportPayload = {
            summary,
            files: {
                traceJson: this.generatedTraceJsonPath,
                traceSpec: this.generatedTraceSpecPath
            },
            thoughts: this.thoughtLog,
            steps: this.stepLog,
            errors: this.errorLog,
            screenshots: this.screenshotLog
        };

        const reportJsonPath = path.join(reportDir, 'report.json');
        const reportCsvPath = path.join(reportDir, 'steps.csv');
        const reportPdfPath = path.join(reportDir, 'report.pdf');

        const csvRows = [
            ['id', 'timestamp', 'action', 'targetId', 'value', 'thought', 'url'],
            ...this.stepLog.map((step) => [
                String(step.id),
                step.timestamp,
                step.action,
                step.targetId || '',
                step.value || '',
                step.thought || '',
                step.url || ''
            ])
        ].map((row) => row.map((value) => this.csvEscape(value)).join(','));

        await fs.writeFile(reportJsonPath, JSON.stringify(reportPayload, null, 2), 'utf8');
        await fs.writeFile(reportCsvPath, `${csvRows.join('\n')}\n`, 'utf8');
        await this.buildReportPdf(summary, reportPdfPath);

        this.generatedReportJsonPath = reportJsonPath;
        this.generatedReportCsvPath = reportCsvPath;
        this.generatedReportPdfPath = reportPdfPath;

        this.emit('report_ready', {
            runId: this.currentRunId,
            jsonPath: reportJsonPath,
            csvPath: reportCsvPath,
            pdfPath: reportPdfPath,
            jsonUrl: this.toDownloadUrl(reportJsonPath),
            csvUrl: this.toDownloadUrl(reportCsvPath),
            pdfUrl: this.toDownloadUrl(reportPdfPath)
        });
        this.emit('thought', `🧾 Report bereit: ${reportPdfPath}`);
    }

    private buildTraceSpec(trace: TraceExport): string {
        const testName = `DRIVE trace replay (${trace.persona || 'agent'})`;
        const lines: string[] = [];

        lines.push(`import { test } from '@playwright/test';`);
        lines.push('');
        lines.push(`test('${this.escapeTsString(testName)}', async ({ page, context }) => {`);
        lines.push(`  let activePage = page;`);
        lines.push(`  await activePage.goto('${this.escapeTsString(trace.startUrl)}', { waitUntil: 'domcontentloaded' });`);

        for (const step of trace.steps) {
            const note = step.note ? ` // ${this.escapeTsString(step.note)}` : '';
            if (step.action === 'goto') {
                lines.push(`  await activePage.goto('${this.escapeTsString(step.url || trace.startUrl)}', { waitUntil: 'domcontentloaded' });${note}`);
                continue;
            }

            if (step.action === 'click') {
                if (step.selector) {
                    lines.push(`  await activePage.locator('${this.escapeTsString(step.selector)}').first().click({ timeout: 15000 });${note}`);
                } else if (typeof step.x === 'number' && typeof step.y === 'number') {
                    lines.push(`  await activePage.mouse.click(${Math.round(step.x)}, ${Math.round(step.y)});${note}`);
                }
                continue;
            }

            if (step.action === 'type') {
                if (step.selector) {
                    lines.push(`  {`);
                    lines.push(`    const field = activePage.locator('${this.escapeTsString(step.selector)}').first();`);
                    lines.push(`    await field.fill('');`);
                    lines.push(`    await field.type('${this.escapeTsString(step.value || '')}', { delay: 45 });`);
                    lines.push(`  }${note}`);
                } else if (step.value) {
                    lines.push(`  await activePage.keyboard.type('${this.escapeTsString(step.value)}', { delay: 45 });${note}`);
                }
                continue;
            }

            if (step.action === 'scroll') {
                const deltaY = Number.isFinite(step.deltaY) ? Math.round(step.deltaY as number) : 520;
                lines.push(`  await activePage.mouse.wheel(0, ${deltaY});${note}`);
                continue;
            }

            if (step.action === 'wait') {
                const waitMs = Number.isFinite(step.waitMs) ? Math.max(0, Math.round(step.waitMs as number)) : 2000;
                lines.push(`  await activePage.waitForTimeout(${waitMs});${note}`);
                continue;
            }

            if (step.action === 'tab-switch') {
                lines.push(`  {`);
                lines.push(`    const pages = context.pages();`);
                lines.push(`    activePage = pages[pages.length - 1] || activePage;`);
                lines.push(`    await activePage.bringToFront();${note}`);
                lines.push(`    await activePage.waitForLoadState('domcontentloaded').catch(() => {});`);
                lines.push(`  }`);
            }
        }

        lines.push('});');
        lines.push('');
        return lines.join('\n');
    }

    private async persistTraceArtifacts() {
        if (!this.isSaveTraceEnabled) return;
        if (this.traceSavedThisRun) return;
        if (this.traceSteps.length === 0) return;
        if (!this.currentRunDir) return;

        const traceDir = path.join(this.currentRunDir, 'trace');
        await fs.mkdir(traceDir, { recursive: true });

        const traceData: TraceExport = {
            version: 1,
            createdAt: new Date().toISOString(),
            runId: this.currentRunId,
            startUrl: this.traceStartUrl,
            finalUrl: this.page?.url() || this.traceStartUrl,
            objective: this.traceObjective,
            persona: this.tracePersonaName,
            modelName: this.selectedModelName,
            steps: this.traceSteps
        };

        const base = `trace-${this.currentRunId}`;
        const jsonPath = path.join(traceDir, `${base}.json`);
        const specPath = path.join(traceDir, `${base}.spec.ts`);
        await fs.writeFile(jsonPath, JSON.stringify(traceData, null, 2), 'utf8');
        await fs.writeFile(specPath, this.buildTraceSpec(traceData), 'utf8');

        this.generatedTraceJsonPath = jsonPath;
        this.generatedTraceSpecPath = specPath;
        this.traceSavedThisRun = true;
        this.emit('trace_saved', {
            jsonPath,
            specPath,
            jsonUrl: this.toDownloadUrl(jsonPath),
            specUrl: this.toDownloadUrl(specPath),
            steps: this.traceSteps.length
        });
        this.emit('thought', `💾 Trace gespeichert: ${specPath}`);
    }

    async start(url: string, persona: PersonaConfig, objective?: string, options?: AgentStartOptions) {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isMonkeyMode = Boolean(options?.monkeyMode);
        this.isBareLlmMode = Boolean(options?.bareLlmMode);
        this.isDebugMode = options?.debugMode !== false;
        this.isTtsEnabled = Boolean(options?.ttsEnabled);
        this.isHeadlessMode = Boolean(options?.headlessMode);
        this.isSaveTraceEnabled = Boolean(options?.saveTrace);
        this.isSaveThoughtsEnabled = Boolean(options?.saveThoughts);
        this.isSaveScreenshotsEnabled = Boolean(options?.saveScreenshots);
        this.selectedModelName = (options?.modelName || 'gemini-2.0-flash').trim() || 'gemini-2.0-flash';
        this.ttsConfig = {
            voiceName: persona.tts?.voiceName || DEFAULT_TTS_VOICE,
            languageCode: persona.tts?.languageCode || DEFAULT_TTS_LANGUAGE,
            systemInstruction: persona.tts?.systemInstruction || ''
        };
        this.trackedPages = new WeakSet<Page>();
        this.autoFollowedPages = new WeakSet<Page>();
        this.history = [];
        this.failedTargetIds.clear();
        this.stagnationCounter = 0;
        this.traceSteps = [];
        this.traceStepCounter = 0;
        this.traceStartUrl = url;
        this.traceObjective = objective || '';
        this.tracePersonaName = persona.name;
        this.traceSavedThisRun = false;
        this.thoughtLog = [];
        this.stepLog = [];
        this.errorLog = [];
        this.screenshotLog = [];
        this.generatedTraceJsonPath = null;
        this.generatedTraceSpecPath = null;
        this.generatedReportJsonPath = null;
        this.generatedReportPdfPath = null;
        this.generatedReportCsvPath = null;
        this.currentRunId = '';
        this.currentRunDir = '';
        this.runStartedAt = '';
        this.clearPendingTtsAck();
        this.emit('status', 'starting');

        try {
            await this.initializeRunStorage(persona.name);
            this.browser = await chromium.launch({ headless: this.isHeadlessMode });
            this.context = await this.browser.newContext(persona.contextOptions);
            this.page = await this.context.newPage();
            this.attachContextTabHandlers();
            this.attachPageLifecycleHandlers(this.page);
            this.autoFollowedPages.add(this.page);

            this.emit('thought', `Starting session as ${persona.name} on ${url}`);
            if (objective) this.emit('thought', `Mission: ${objective}`);
            if (this.isMonkeyMode) {
                this.emit('thought', 'Monkey Mode aktiv: Personas und LLM-Rollenlogik sind deaktiviert.');
            }
            if (this.isBareLlmMode) {
                this.emit('thought', 'Bare LLM Persona aktiv: keine Persona-Regeln.');
            }
            this.emit('thought', `Model: ${this.selectedModelName}`);
            this.emit('thought', `Debug Mode: ${this.isDebugMode ? 'ON' : 'OFF'}`);
            this.emit('thought', `Voice TTS: ${this.isTtsEnabled ? 'ON' : 'OFF'}`);
            this.emit('thought', `Browser Mode: ${this.isHeadlessMode ? 'HEADLESS' : 'VISIBLE'}`);
            this.emit('thought', `Save Trace: ${this.isSaveTraceEnabled ? 'ON' : 'OFF'}`);
            this.emit('thought', `Save Thoughts: ${this.isSaveThoughtsEnabled ? 'ON' : 'OFF'}`);
            this.emit('thought', `Save Screenshots: ${this.isSaveScreenshotsEnabled ? 'ON' : 'OFF'}`);
            if (this.isTtsEnabled) {
                this.emit('thought', `TTS Voice: ${this.ttsConfig.voiceName} (${this.ttsConfig.languageCode})`);
            }

            // Use domcontentloaded to avoid waiting for heavy SPAs to fully load
            try {
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (navError: any) {
                this.emit('thought', `⚠️ Navigation warning: ${navError.message}. Continuing anyway...`);
            }
            this.createTraceStep({ action: 'goto', note: 'initial navigation' });

            // Wait for SPA hydration
            await this.page.waitForTimeout(2000);
            await this.initializeCursor();

            const personaPrompt = (this.isMonkeyMode || this.isBareLlmMode)
                ? ''
                : ((persona as any).systemPrompt || (persona as any).basePrompt || '');
            this.loop(personaPrompt, objective);
        } catch (e) {
            this.emit('error', e);
            this.stop();
        }
    }

    async stop() {
        this.isRunning = false;
        this.isMonkeyMode = false;
        this.isBareLlmMode = false;
        this.isDebugMode = true;
        this.isTtsEnabled = false;
        this.isHeadlessMode = false;
        const shouldPersistTrace = this.isSaveTraceEnabled;
        const shouldPersistThoughts = this.isSaveThoughtsEnabled;
        const shouldPersistScreenshots = this.isSaveScreenshotsEnabled;
        this.selectedModelName = 'gemini-2.0-flash';
        this.ttsConfig = {
            voiceName: DEFAULT_TTS_VOICE,
            languageCode: DEFAULT_TTS_LANGUAGE,
            systemInstruction: ''
        };
        this.trackedPages = new WeakSet<Page>();
        this.autoFollowedPages = new WeakSet<Page>();
        this.clearPendingTtsAck();
        if (shouldPersistTrace) {
            try {
                await this.persistTraceArtifacts();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unbekannter Fehler beim Trace-Speichern';
                this.emit('thought', `⚠️ Trace konnte nicht gespeichert werden: ${message}`);
            }
        }
        if (shouldPersistThoughts) {
            try {
                await this.persistThoughtArtifacts();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unbekannter Fehler beim Thought-Export';
                this.emit('thought', `⚠️ Thoughts konnten nicht gespeichert werden: ${message}`);
            }
        }
        if (shouldPersistTrace || shouldPersistThoughts || shouldPersistScreenshots || this.stepLog.length > 0) {
            try {
                await this.persistReportArtifacts();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unbekannter Fehler beim Report-Export';
                this.emit('thought', `⚠️ Report konnte nicht erstellt werden: ${message}`);
            }
        }
        this.isSaveTraceEnabled = false;
        this.isSaveThoughtsEnabled = false;
        this.isSaveScreenshotsEnabled = false;
        this.emit('status', 'stopped');
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
        this.page = null;
        this.context = null;
        this.browser = null;
    }

    private attachContextTabHandlers() {
        if (!this.context) return;
        this.context.on('page', (newPage) => {
            void this.followNewPage(newPage, 'context');
        });
    }

    private attachPageLifecycleHandlers(page: Page) {
        if (this.trackedPages.has(page)) return;
        this.trackedPages.add(page);

        page.on('popup', (popup) => {
            void this.followNewPage(popup, 'popup');
        });

        page.on('close', () => {
            if (!this.isRunning || this.page !== page) return;
            void this.recoverFromActivePageLoss('⚠️ Aktiver Tab wurde geschlossen.');
        });

        page.on('crash', () => {
            if (!this.isRunning || this.page !== page) return;
            console.error('Active page crashed');
            void this.recoverFromActivePageLoss('⚠️ Aktiver Tab ist abgestuerzt.');
        });
    }

    private getFallbackPage(exclude?: Page): Page | null {
        if (!this.context) return null;
        for (const candidate of this.context.pages()) {
            if (candidate === exclude) continue;
            if (!candidate.isClosed()) return candidate;
        }
        return null;
    }

    private async recoverFromActivePageLoss(message: string) {
        this.emit('thought', message);
        const fallback = this.getFallbackPage(this.page || undefined);
        if (fallback) {
            await this.switchToPage(fallback, 'fallback');
            return;
        }
        this.isRunning = false;
    }

    private async followNewPage(newPage: Page, source: string) {
        if (!this.isRunning) return;
        if (newPage.isClosed()) return;
        this.attachPageLifecycleHandlers(newPage);
        if (newPage === this.page) return;
        if (this.autoFollowedPages.has(newPage)) return;
        this.autoFollowedPages.add(newPage);

        if (newPage.url() === 'about:blank') {
            await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => { });
        }

        await this.switchToPage(newPage, source);
    }

    private async switchToPage(nextPage: Page, source: string) {
        if (!this.isRunning) return;
        if (nextPage.isClosed()) return;
        if (this.page === nextPage) return;

        this.page = nextPage;
        await nextPage.bringToFront().catch(() => { });
        await this.initializeCursor().catch(() => { });
        const nextUrl = nextPage.url();
        this.createTraceStep({
            action: 'tab-switch',
            note: `source=${source} url=${nextUrl || '(unbekannt)'}`
        });
        this.emit('thought', `🔀 Neuer Tab erkannt (${source}). Folge zu ${nextUrl || '(unbekannt)'}.`);
    }

    public notifyTtsPlaybackDone(requestId?: string) {
        if (!requestId || !this.pendingTtsAckId) return;
        if (requestId !== this.pendingTtsAckId) return;
        this.clearPendingTtsAck();
    }

    public setTtsEnabled(enabled: boolean) {
        this.isTtsEnabled = enabled;
    }

    private clearPendingTtsAck() {
        const resolve = this.pendingTtsAckResolve;
        this.pendingTtsAckResolve = null;
        this.pendingTtsAckId = null;
        if (this.pendingTtsAckTimer) {
            clearTimeout(this.pendingTtsAckTimer);
            this.pendingTtsAckTimer = null;
        }
        if (resolve) resolve();
    }

    private parseSampleRateFromMime(mimeType?: string): number {
        const matched = String(mimeType || '').match(/rate=(\d+)/i);
        const rate = matched?.[1] ? Number(matched[1]) : NaN;
        return Number.isFinite(rate) && rate > 0 ? rate : 24000;
    }

    private pcm16ToWavBase64(pcmBase64: string, sampleRate = 24000, channels = 1): string {
        const pcmBuffer = Buffer.from(pcmBase64, 'base64');
        const bytesPerSample = 2;
        const blockAlign = channels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const wavBuffer = Buffer.alloc(44 + pcmBuffer.length);

        wavBuffer.write('RIFF', 0);
        wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
        wavBuffer.write('WAVE', 8);
        wavBuffer.write('fmt ', 12);
        wavBuffer.writeUInt32LE(16, 16);
        wavBuffer.writeUInt16LE(1, 20); // PCM
        wavBuffer.writeUInt16LE(channels, 22);
        wavBuffer.writeUInt32LE(sampleRate, 24);
        wavBuffer.writeUInt32LE(byteRate, 28);
        wavBuffer.writeUInt16LE(blockAlign, 32);
        wavBuffer.writeUInt16LE(16, 34);
        wavBuffer.write('data', 36);
        wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
        pcmBuffer.copy(wavBuffer, 44);

        return wavBuffer.toString('base64');
    }

    private async requestTtsAudio(text: string): Promise<TTSAudioPayload | null> {
        if (!this.apiKey) return null;

        for (const model of this.ttsModelCandidates) {
            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...(this.ttsConfig.systemInstruction
                            ? { systemInstruction: { parts: [{ text: this.ttsConfig.systemInstruction }] } }
                            : {}),
                        contents: [{ parts: [{ text }] }],
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                languageCode: this.ttsConfig.languageCode || DEFAULT_TTS_LANGUAGE,
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName: this.ttsConfig.voiceName || DEFAULT_TTS_VOICE }
                                }
                            }
                        }
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    console.warn(`TTS request failed on ${model}: ${response.status} ${response.statusText} ${errorText}`);
                    continue;
                }

                const payload = await response.json() as any;
                const part = payload?.candidates?.[0]?.content?.parts?.find((candidatePart: any) => candidatePart?.inlineData || candidatePart?.inline_data);
                const inlineData = part?.inlineData || part?.inline_data;
                const audioBase64 = inlineData?.data;
                const mimeType = inlineData?.mimeType || inlineData?.mime_type || 'audio/L16;rate=24000';

                if (!audioBase64 || typeof audioBase64 !== 'string') {
                    continue;
                }

                if (String(mimeType).toLowerCase().includes('wav')) {
                    return { audioBase64, mimeType: 'audio/wav' };
                }

                const sampleRate = this.parseSampleRateFromMime(mimeType);
                return {
                    audioBase64: this.pcm16ToWavBase64(audioBase64, sampleRate, 1),
                    mimeType: 'audio/wav'
                };
            } catch (error) {
                console.warn(`TTS request error on ${model}:`, error);
            }
        }

        return null;
    }

    private async speakThoughtAndWait(text: string) {
        if (!this.isRunning || !this.isTtsEnabled) return;
        const normalizedText = String(text || '').trim();
        if (!normalizedText) return;

        const audioPayload = await this.requestTtsAudio(normalizedText);
        if (!audioPayload) {
            this.emit('thought', '⚠️ TTS konnte nicht erzeugt werden. Ich mache ohne Audio weiter.');
            return;
        }

        const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = Math.min(45000, Math.max(7000, normalizedText.length * 70));

        await new Promise<void>((resolve) => {
            this.pendingTtsAckId = requestId;
            this.pendingTtsAckResolve = resolve;
            this.pendingTtsAckTimer = setTimeout(() => {
                console.warn(`TTS playback timeout for ${requestId}`);
                this.clearPendingTtsAck();
            }, timeoutMs);

            this.emit('tts', {
                id: requestId,
                text: normalizedText,
                mimeType: audioPayload.mimeType,
                audioBase64: audioPayload.audioBase64
            });
        });
    }

    private async loop(systemPrompt: string, objective?: string) {
        let stepCount = 0;
        while (this.isRunning) {
            if (!this.page || this.page.isClosed()) {
                console.log("Page closed, stopping loop.");
                break;
            }
            stepCount++;

            try {
                // 0. Handle Cookie Banners (Heuristic)
                await this.handleCookieBanner();

                // 1. Inject SoM & Stabilize
                this.emit('status', 'scanning');
                let somResult: SoMResult | null = null;
                try {
                    // Timeout SoM injection at 5s to prevent hangs on heavy SPAs
                    somResult = await Promise.race([
                        injectSoM(this.page),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('SoM timeout')), 5000))
                    ]) as SoMResult;
                } catch (e: any) {
                    console.warn("SoM Injection skipped:", e.message);
                    this.emit('thought', `⚡ SoM overlay skipped (${e.message}). Continuing with raw screenshot.`);
                }

                await this.ensureCursorReady();

                // 2. Screenshot
                let screenshotBase64 = '';
                try {
                    const llmScreenshotBuffer = await this.page.screenshot({ fullPage: false });
                    screenshotBase64 = llmScreenshotBuffer.toString('base64');

                    let streamScreenshotBase64 = screenshotBase64;
                    if (!this.isDebugMode) {
                        try {
                            await setSoMOverlayVisibility(this.page, false);
                            const cleanStreamBuffer = await this.page.screenshot({ fullPage: false });
                            streamScreenshotBase64 = cleanStreamBuffer.toString('base64');
                        } finally {
                            await setSoMOverlayVisibility(this.page, true).catch(() => { });
                        }
                    }

                    this.emit('screenshot', `data:image/png;base64,${streamScreenshotBase64}`);
                    await this.persistStepScreenshot(stepCount, streamScreenshotBase64);
                } catch (e) {
                    console.log("Screenshot failed, page likely closed.");
                    break;
                }

                // 3. Ask AI
                this.emit('status', 'thinking');

                const dynamicHints = this.isMonkeyMode ? '' : await this.buildStepHints(somResult, objective);
                const combinedPrompt = `
${systemPrompt}
${objective ? `\nDEIN AKTUELLES ZIEL: ${objective}` : ''}
${dynamicHints}
`;

                const decision = this.isMonkeyMode
                    ? this.generateMonkeyDecision(somResult)
                    : await this.llm.generate(screenshotBase64, combinedPrompt, this.history, {
                        bareMode: this.isBareLlmMode,
                        modelName: this.selectedModelName
                    });

                // 3.5 Push decision into history for context in next step
                this.history.push(decision);

                if (this.detectStagnation()) {
                    this.emit('thought', "⚠️ Ich drehe mich im Kreis und stoppe hier, damit wir den Plan neu setzen können.");
                    break;
                }

                this.emit('thought', decision.thought);
                await this.speakThoughtAndWait(decision.thought);
                this.emit('step', { id: stepCount, ...decision });

                if (decision.action === 'done' || decision.action === 'stop') {
                    this.emit('thought', 'Task completed or stopped by AI.');
                    break;
                }

                // 4. Execute Action
                this.emit('status', 'acting');
                await this.executeAction(decision);

                // 5. Short wait
                try {
                    await this.page.waitForTimeout(1000);
                } catch (e) {
                    // Ignore timeout errors if page is closed
                }

            } catch (e: any) {
                console.error("Loop Error:", e);
                this.emit('thought', `Error: ${e.message}`);
                const missingTargetMatch = String(e.message || '').match(/(?:Element|Input)\s+(\d+)/);
                if (missingTargetMatch?.[1]) {
                    const targetId = missingTargetMatch[1];
                    this.failedTargetIds.set(targetId, (this.failedTargetIds.get(targetId) || 0) + 1);
                }
                // Don't crash, just wait a bit and try again (or stop if critical)
                try {
                    await this.page?.waitForTimeout(5000);
                } catch (ignore) { }
            }
        }
        await this.stop();
    }

    private async isCookieSurfaceVisible() {
        if (!this.page) return false;
        return this.page.evaluate(() => {
            const keywords = ['cookie', 'cookies', 'consent', 'datenschutz', 'privacy', 'privatsphäre'];
            const selectors = [
                '[id*="cookie"]',
                '[class*="cookie"]',
                '[id*="consent"]',
                '[class*="consent"]',
                '[data-testid*="cookie"]',
                '[data-testid*="consent"]',
                '[aria-label*="cookie" i]',
                '[role="dialog"]'
            ];

            const isVisible = (el: Element) => {
                if (!(el instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0' &&
                    rect.width > 20 &&
                    rect.height > 20;
            };

            const bySelector = selectors.some(selector => {
                const found = document.querySelector(selector);
                return !!found && isVisible(found);
            });
            if (bySelector) return true;

            const textCandidates = Array.from(document.querySelectorAll('div,section,aside,dialog,form,[role="dialog"]'));
            return textCandidates.some(el => {
                if (!isVisible(el)) return false;
                const text = (el.textContent || '').toLowerCase();
                if (!text || text.length < 20) return false;
                if (!keywords.some(k => text.includes(k))) return false;
                const rect = (el as HTMLElement).getBoundingClientRect();
                return rect.height > 80 || rect.top > window.innerHeight * 0.45;
            });
        }).catch(() => false);
    }

    private async clickAtPoint(point: CursorPoint) {
        if (!this.page) return;
        await this.moveCursorHumanLike(point, 0.8);
        await showCursorClickEffect(this.page, point, 'down');
        await this.page.mouse.down();
        await this.page.waitForTimeout(this.randomBetween(35, 90));
        await showCursorClickEffect(this.page, point, 'up');
        await this.page.mouse.up();
    }

    private async clickCookieCandidate(locator: Locator, source: string) {
        if (!this.page) return false;
        const visible = await locator.isVisible({ timeout: 250 }).catch(() => false);
        if (!visible) return false;

        const selector = await this.captureSelectorForLocator(locator);
        await locator.scrollIntoViewIfNeeded().catch(() => { });
        let clickedPoint: CursorPoint | null = null;
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
            const point = this.pickTargetPoint(box);
            clickedPoint = point;
            await this.clickAtPoint(point);
        } else {
            await locator.click({ timeout: 2000 }).catch(() => { });
        }

        await this.page.waitForTimeout(850);
        const stillVisible = await this.isCookieSurfaceVisible();
        if (!stillVisible) {
            console.log(`🍪 Cookie dismissed via ${source}`);
            this.createTraceStep({
                action: 'click',
                selector: selector || undefined,
                x: clickedPoint ? Math.round(clickedPoint.x) : undefined,
                y: clickedPoint ? Math.round(clickedPoint.y) : undefined,
                note: `cookie banner (${source})`
            });
            this.emit('thought', "🍪 Cookie-Banner akzeptiert.");
            return true;
        }
        return false;
    }

    private async findCookieAcceptPoint(): Promise<{ point: CursorPoint; label: string } | null> {
        if (!this.page) return null;
        const result = await this.page.evaluate(() => {
            const acceptPatterns = [
                /^alle\s+akzeptieren$/i,
                /^alles\s+akzeptieren$/i,
                /^accept\s+all(?:\s+cookies)?$/i,
                /^allow\s+all$/i,
                /^zustimmen$/i,
                /^einverstanden$/i,
                /^i\s+agree$/i
            ];
            const contextPatterns = [/cookie/i, /consent/i, /datenschutz/i, /privacy/i, /privatsphäre/i];

            const isVisible = (el: Element) => {
                if (!(el instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0' &&
                    rect.width >= 28 &&
                    rect.height >= 16 &&
                    rect.bottom > 0 &&
                    rect.right > 0 &&
                    rect.top < window.innerHeight &&
                    rect.left < window.innerWidth;
            };

            const hasCookieContext = (el: Element) => {
                let current: Element | null = el;
                for (let i = 0; i < 6 && current; i++) {
                    const attrString = `${current.id || ''} ${(current as HTMLElement).className || ''} ${current.getAttribute('data-testid') || ''}`.toLowerCase();
                    const text = ((current as HTMLElement).innerText || current.textContent || '').toLowerCase();
                    if (contextPatterns.some(p => p.test(attrString) || p.test(text))) return true;
                    current = current.parentElement;
                }
                return false;
            };

            const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], span, div'));
            let best: { x: number; y: number; score: number; label: string } | null = null;

            for (const el of nodes) {
                if (!isVisible(el)) continue;
                const rawText = (el as HTMLInputElement).value || (el as HTMLElement).innerText || el.textContent || '';
                const text = rawText.replace(/\s+/g, ' ').trim();
                if (!text) continue;
                if (!acceptPatterns.some(p => p.test(text))) continue;

                const rect = (el as HTMLElement).getBoundingClientRect();
                let score = 10;
                if (/^alle\s+akzeptieren$/i.test(text)) score += 25;
                if (/^accept\s+all/i.test(text)) score += 20;
                if (hasCookieContext(el)) score += 18;
                if (rect.top > window.innerHeight * 0.45) score += 6;
                score += Math.min(10, (rect.width * rect.height) / 6000);

                const candidate = {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    score,
                    label: text
                };

                if (!best || candidate.score > best.score) best = candidate;
            }

            return best;
        }).catch(() => null);

        if (!result) return null;
        return {
            point: { x: result.x, y: result.y },
            label: result.label
        };
    }

    private async handleCookieBanner() {
        if (!this.page) return;
        try {
            const surfaceVisible = await this.isCookieSurfaceVisible();
            if (!surfaceVisible) return;

            const strictSelectors = [
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '.cc-btn.cc-allow',
                '[data-testid*="accept-all"]',
                '[data-action="accept-all"]'
            ];
            for (const selector of strictSelectors) {
                const clicked = await this.clickCookieCandidate(this.page.locator(selector).first(), `strict selector ${selector}`);
                if (clicked) return;
            }

            const containerSelectors = [
                '[id*="cookie"]',
                '[class*="cookie"]',
                '[id*="consent"]',
                '[class*="consent"]',
                '[role="dialog"]',
                'footer',
                'aside'
            ];
            const acceptPatterns = [
                /^alle\s+akzeptieren$/i,
                /^alles\s+akzeptieren$/i,
                /^accept\s+all(?:\s+cookies)?$/i,
                /^allow\s+all$/i,
                /^zustimmen$/i,
                /^einverstanden$/i
            ];

            for (const containerSelector of containerSelectors) {
                const container = this.page.locator(containerSelector);
                const containerVisible = await container.first().isVisible({ timeout: 120 }).catch(() => false);
                if (!containerVisible) continue;

                const buttons = container.locator('button, [role="button"], a, input[type="button"], input[type="submit"]');
                for (const pattern of acceptPatterns) {
                    const clicked = await this.clickCookieCandidate(
                        buttons.filter({ hasText: pattern }).first(),
                        `container ${containerSelector} (${pattern.source})`
                    );
                    if (clicked) return;
                }
            }

            for (const frame of this.page.frames()) {
                if (frame === this.page.mainFrame()) continue;
                for (const selector of strictSelectors) {
                    const button = frame.locator(selector).first();
                    if (await button.isVisible({ timeout: 120 }).catch(() => false)) {
                        await button.click({ timeout: 2000 }).catch(() => { });
                        await this.page.waitForTimeout(850);
                        if (!(await this.isCookieSurfaceVisible())) {
                            this.emit('thought', "🍪 Cookie-Banner im iFrame akzeptiert.");
                            return;
                        }
                    }
                }
            }

            // Vision fallback: click by on-screen coordinates if DOM click did not dismiss the banner.
            const visionTarget = await this.findCookieAcceptPoint();
            if (visionTarget) {
                this.emit('thought', `🍪 DOM-Klick hat nicht gereicht. Vision-Fallback auf "${visionTarget.label}".`);
                await this.clickAtPoint(visionTarget.point);
                await this.page.waitForTimeout(850);
                if (!(await this.isCookieSurfaceVisible())) {
                    this.createTraceStep({
                        action: 'click',
                        x: Math.round(visionTarget.point.x),
                        y: Math.round(visionTarget.point.y),
                        note: `cookie banner vision fallback (${visionTarget.label})`
                    });
                    this.emit('thought', "🍪 Cookie-Banner per Koordinaten-Klick akzeptiert.");
                }
            }
        } catch (e) {
            // Ignore errors in cookie handling, don't crash the agent
        }
    }

    private getViewportSize() {
        return this.page?.viewportSize() || { width: 1280, height: 720 };
    }

    private clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
    }

    private randomBetween(min: number, max: number) {
        return min + Math.random() * (max - min);
    }

    private emitCursor() {
        const viewport = this.getViewportSize();
        this.emit('cursor', {
            x: this.cursorPosition.x,
            y: this.cursorPosition.y,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height
        });
    }

    private async initializeCursor() {
        if (!this.page) return;
        const viewport = this.getViewportSize();
        this.cursorPosition = {
            x: Math.round(viewport.width * 0.5),
            y: Math.round(viewport.height * 0.35)
        };
        await ensureVisualCursor(this.page, this.cursorPosition);
        await this.page.mouse.move(this.cursorPosition.x, this.cursorPosition.y);
        this.emitCursor();
    }

    private async ensureCursorReady() {
        if (!this.page) return;
        await ensureVisualCursor(this.page, this.cursorPosition);
    }

    private async moveCursorHumanLike(target: CursorPoint, speedFactor = 1) {
        if (!this.page || this.page.isClosed()) return;

        const viewport = this.getViewportSize();
        const clampedTarget = {
            x: this.clamp(target.x, 2, viewport.width - 2),
            y: this.clamp(target.y, 2, viewport.height - 2)
        };

        await this.ensureCursorReady();
        const path = generateHumanCursorPath(this.cursorPosition, clampedTarget);
        const stepDelay = Math.max(6, Math.floor((path.durationMs * speedFactor) / Math.max(1, path.points.length)));

        let emitThrottle = 0;
        for (const point of path.points) {
            if (!this.page || this.page.isClosed()) return;
            await this.page.mouse.move(point.x, point.y);
            await moveVisualCursor(this.page, point);
            this.cursorPosition = point;
            emitThrottle++;
            if (emitThrottle % 2 === 0) this.emitCursor();
            await this.page.waitForTimeout(stepDelay);
        }

        this.cursorPosition = clampedTarget;
        await moveVisualCursor(this.page, clampedTarget);
        this.emitCursor();
    }

    private pickTargetPoint(box: { x: number; y: number; width: number; height: number }): CursorPoint {
        const safePadding = Math.max(2, Math.min(10, Math.min(box.width, box.height) * 0.2));
        const minX = box.x + safePadding;
        const maxX = box.x + box.width - safePadding;
        const minY = box.y + safePadding;
        const maxY = box.y + box.height - safePadding;

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        return {
            x: maxX > minX ? this.randomBetween(minX, maxX) : centerX,
            y: maxY > minY ? this.randomBetween(minY, maxY) : centerY
        };
    }

    private randomMonkeyText() {
        const candidates = [
            'test',
            'bmw',
            'zubehoer',
            'r1250',
            'adventure',
            'shop',
            'hello'
        ];
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    private isLikelyInput(meta: SoMElementMeta) {
        const tag = meta.tag.toLowerCase();
        const role = (meta.role || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || role === 'textbox' || role === 'searchbox';
    }

    private generateMonkeyDecision(somResult: SoMResult | null): LLMResponse {
        const elements = (somResult?.elements || []).filter(el => typeof el.id === 'number');
        const inputElements = elements.filter(el => this.isLikelyInput(el));
        const randomRoll = Math.random();

        if (elements.length === 0) {
            return {
                thought: 'Monkey Mode: Keine Targets sichtbar, ich scrolle weiter.',
                action: 'scroll'
            };
        }

        if (randomRoll < 0.16) {
            return {
                thought: 'Monkey Mode: Kurz warten.',
                action: 'wait'
            };
        }

        if (randomRoll < 0.36) {
            return {
                thought: 'Monkey Mode: Scrollen für neue Elemente.',
                action: 'scroll'
            };
        }

        if (inputElements.length > 0 && randomRoll < 0.56) {
            const pickedInput = inputElements[Math.floor(Math.random() * inputElements.length)];
            return {
                thought: `Monkey Mode: Tippe zufaellig in #${pickedInput.id}.`,
                action: 'type',
                targetId: String(pickedInput.id),
                value: this.randomMonkeyText()
            };
        }

        const picked = elements[Math.floor(Math.random() * elements.length)];
        return {
            thought: `Monkey Mode: Klicke zufaellig #${picked.id}.`,
            action: 'click',
            targetId: String(picked.id)
        };
    }

    private normalizeLabel(value?: string): string {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    private extractObjectiveKeywords(objective?: string): string[] {
        if (!objective) return [];
        const raw = objective
            .toLowerCase()
            .replace(/[^a-zA-Z0-9äöüß\s-]/g, ' ')
            .split(/\s+/)
            .map(t => t.trim())
            .filter(t => t.length >= 3);

        return Array.from(new Set(raw)).slice(0, 12);
    }

    private describeElement(meta: SoMElementMeta): string {
        const label = this.normalizeLabel(meta.text || meta.ariaLabel || meta.title || meta.href || '');
        const shortLabel = label.length > 72 ? `${label.slice(0, 69)}...` : label;
        const rolePart = meta.role ? ` role=${meta.role}` : '';
        return `#${meta.id} <${meta.tag}${rolePart}> "${shortLabel || '(ohne text)'}"`;
    }

    private buildLoopGuardHint(): string {
        const recent = this.history.slice(-8);
        if (recent.length < 6) return '';

        const pairCounts = new Map<string, number>();
        for (const step of recent) {
            const key = `${step.action}:${step.targetId || '-'}`;
            pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }

        const repeated = Array.from(pairCounts.entries())
            .filter(([, count]) => count >= 2)
            .map(([key]) => key);

        if (repeated.length === 0) return '';

        return `
ANTI-LOOP WARNUNG:
- Du wiederholst bereits Aktionen (${repeated.join(', ')}).
- Klicke NICHT erneut dieselben IDs.
- Wenn ein Menü/Overlay offen ist, bearbeite zuerst dessen Optionen statt den Hintergrund.
- Wähle im nächsten Schritt eine NEUE ID mit anderem Inhalt (z. B. "Zubehör", "Accessoires", "Modelle", "Menü").
- Falls 3 neue Versuche keinen Fortschritt bringen, nutze action "done" und sage klar warum.
`;
    }

    private detectStagnation(): boolean {
        const recent = this.history.slice(-10);
        if (recent.length < 10) {
            this.stagnationCounter = Math.max(0, this.stagnationCounter - 1);
            return false;
        }

        const actionable = recent.filter(s => s.action === 'click' || s.action === 'type' || s.action === 'scroll');
        const uniqueTargets = new Set(actionable.map(s => `${s.action}:${s.targetId || '-'}`));
        const loopLike = actionable.length >= 8 && uniqueTargets.size <= 3;

        if (loopLike) {
            this.stagnationCounter += 1;
        } else {
            this.stagnationCounter = Math.max(0, this.stagnationCounter - 1);
        }

        return this.stagnationCounter >= 3;
    }

    private async buildStepHints(somResult: SoMResult | null, objective?: string): Promise<string> {
        if (!this.page) return '';

        const url = this.page.url();
        const title = await this.page.title().catch(() => '');
        const objectiveKeywords = this.extractObjectiveKeywords(objective);
        const baseKeywords = ['zubehör', 'accessoires', 'menü', 'menu', 'shop', 'suche', 'search', 'filter', 'modell'];
        const allKeywords = Array.from(new Set([...objectiveKeywords, ...baseKeywords]));

        let visibleMenuLabels: string[] = [];
        try {
            visibleMenuLabels = await this.page.evaluate((keywords) => {
                const isVisible = (el: Element): boolean => {
                    if (!(el instanceof HTMLElement)) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0' &&
                        rect.width > 0 &&
                        rect.height > 0;
                };

                const candidates = Array.from(document.querySelectorAll('a, button, [role="menuitem"], [role="button"]'));
                const labels = candidates
                    .filter(isVisible)
                    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(text => text.length >= 3 && text.length <= 60);

                const hits = labels.filter(text =>
                    keywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))
                );

                return Array.from(new Set(hits)).slice(0, 10);
            }, allKeywords);
        } catch {
            visibleMenuLabels = [];
        }

        const elements = somResult?.elements || [];
        const scored = elements
            .map((meta) => {
                const label = this.normalizeLabel(meta.text || meta.ariaLabel || meta.title || meta.href || '').toLowerCase();
                let score = 0;
                if (label) score += 1;
                if (meta.tag === 'a' || meta.tag === 'button') score += 2;
                if (meta.role === 'menuitem' || meta.role === 'button' || meta.role === 'link') score += 2;
                if (allKeywords.some(k => label.includes(k))) score += 5;
                return { meta, score };
            })
            .sort((a, b) => b.score - a.score || a.meta.id - b.meta.id)
            .slice(0, 20)
            .map(entry => this.describeElement(entry.meta));

        const failedTargets = Array.from(this.failedTargetIds.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([id, count]) => `#${id} (${count}x fehlgeschlagen)`);

        const loopGuard = this.buildLoopGuardHint();

        return `
=== AKTUELLE SEITENKONTEXT-DATEN ===
URL: ${url}
Titel: ${title || '(unbekannt)'}
SoM-Elemente: ${somResult?.count ?? 0}
${visibleMenuLabels.length > 0 ? `Sichtbare relevante Labels: ${visibleMenuLabels.join(' | ')}` : ''}
${scored.length > 0 ? `Relevante SoM-IDs:\n${scored.join('\n')}` : ''}
${failedTargets.length > 0 ? `Fehlgeschlagene IDs (vermeiden): ${failedTargets.join(', ')}` : ''}
${loopGuard}
`;
    }

    private async isFillableLocator(locator: Locator): Promise<boolean> {
        try {
            return await locator.evaluate((el) => {
                const tag = el.tagName.toLowerCase();
                if (tag === 'textarea') return true;
                if (tag === 'input') {
                    const input = el as HTMLInputElement;
                    const type = (input.type || 'text').toLowerCase();
                    return type !== 'hidden' && type !== 'button' && type !== 'submit' && type !== 'reset';
                }

                const isContentEditable = (el as HTMLElement).isContentEditable;
                const role = (el.getAttribute('role') || '').toLowerCase();
                return isContentEditable || role === 'textbox' || role === 'searchbox';
            });
        } catch {
            return false;
        }
    }

    private async findNearestFillableLocator(target: CursorPoint): Promise<Locator | null> {
        if (!this.page) return null;

        const candidates = this.page.locator(
            'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"], [role="textbox"], [role="searchbox"]'
        );
        const count = await candidates.count();
        if (count === 0) return null;

        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let i = 0; i < Math.min(count, 120); i++) {
            const candidate = candidates.nth(i);
            const box = await candidate.boundingBox();
            if (!box) continue;

            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;
            const distance = Math.hypot(centerX - target.x, centerY - target.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        return bestIndex >= 0 ? candidates.nth(bestIndex) : null;
    }

    private markTargetFailure(targetId?: string) {
        if (!targetId) return;
        this.failedTargetIds.set(targetId, (this.failedTargetIds.get(targetId) || 0) + 1);
    }

    private async executeAction(decision: LLMResponse) {
        if (!this.page) return;

        if (decision.action === 'click' && decision.targetId) {
            const selector = `[data-som-id="${decision.targetId}"]`;
            const locator = this.page.locator(selector).first();
            if (await locator.count() > 0) {
                await locator.scrollIntoViewIfNeeded();
                const traceSelector = await this.captureSelectorForLocator(locator);
                const box = await locator.boundingBox();
                if (!box) {
                    this.markTargetFailure(decision.targetId);
                    throw new Error(`Element ${decision.targetId} has no bounding box`);
                }

                const targetPoint = this.pickTargetPoint(box);
                await this.moveCursorHumanLike(targetPoint);
                await showCursorClickEffect(this.page, targetPoint, 'down');
                await this.page.mouse.down();
                await this.page.waitForTimeout(this.randomBetween(35, 95));
                await showCursorClickEffect(this.page, targetPoint, 'up');
                await this.page.mouse.up();
                this.createTraceStep({
                    action: 'click',
                    selector: traceSelector || undefined,
                    x: Math.round(targetPoint.x),
                    y: Math.round(targetPoint.y),
                    note: decision.targetId ? `som-id ${decision.targetId}` : undefined
                });
            } else {
                this.markTargetFailure(decision.targetId);
                throw new Error(`Element ${decision.targetId} not found`);
            }
        } else if (decision.action === 'scroll') {
            const viewport = this.getViewportSize();
            const roamPoint = {
                x: this.clamp(this.cursorPosition.x + this.randomBetween(-120, 120), 4, viewport.width - 4),
                y: this.clamp(this.cursorPosition.y + this.randomBetween(-80, 80), 4, viewport.height - 4)
            };
            await this.moveCursorHumanLike(roamPoint, 0.7);
            const deltaY = this.randomBetween(320, 680);
            await this.page.mouse.wheel(0, deltaY);
            this.createTraceStep({
                action: 'scroll',
                deltaY: Math.round(deltaY)
            });
        } else if (decision.action === 'type' && decision.targetId && decision.value) {
            const selector = `[data-som-id="${decision.targetId}"]`;
            const locator = this.page.locator(selector).first();
            if (await locator.count() === 0) {
                this.markTargetFailure(decision.targetId);
                throw new Error(`Input ${decision.targetId} not found`);
            }

            await locator.scrollIntoViewIfNeeded();
            let traceSelector = await this.captureSelectorForLocator(locator);
            const box = await locator.boundingBox();
            if (!box) {
                this.markTargetFailure(decision.targetId);
                throw new Error(`Input ${decision.targetId} has no bounding box`);
            }

            const targetPoint = this.pickTargetPoint(box);
            await this.moveCursorHumanLike(targetPoint);
            await showCursorClickEffect(this.page, targetPoint, 'down');
            await this.page.mouse.down();
            await this.page.waitForTimeout(this.randomBetween(40, 100));
            await showCursorClickEffect(this.page, targetPoint, 'up');
            await this.page.mouse.up();

            let inputLocator: Locator = locator;
            const directFillable = await this.isFillableLocator(locator);
            if (!directFillable) {
                const fallback = await this.findNearestFillableLocator(targetPoint);
                if (!fallback) {
                    this.markTargetFailure(decision.targetId);
                    throw new Error(`Target ${decision.targetId} is not a fillable field and no nearby input was found`);
                }
                inputLocator = fallback;
                traceSelector = await this.captureSelectorForLocator(inputLocator);
                await inputLocator.scrollIntoViewIfNeeded();
                const fallbackBox = await inputLocator.boundingBox();
                if (fallbackBox) {
                    const fallbackPoint = this.pickTargetPoint(fallbackBox);
                    await this.moveCursorHumanLike(fallbackPoint, 0.9);
                    await showCursorClickEffect(this.page, fallbackPoint, 'down');
                    await this.page.mouse.down();
                    await this.page.waitForTimeout(this.randomBetween(30, 80));
                    await showCursorClickEffect(this.page, fallbackPoint, 'up');
                    await this.page.mouse.up();
                }
                this.emit('thought', `⚠️ #${decision.targetId} war kein Eingabefeld. Ich nutze ein naheliegendes Suchfeld.`);
            }

            await inputLocator.fill('');
            await this.page.keyboard.type(decision.value, { delay: Math.floor(this.randomBetween(35, 85)) });
            this.createTraceStep({
                action: 'type',
                selector: traceSelector || undefined,
                value: decision.value,
                note: decision.targetId ? `som-id ${decision.targetId}` : undefined
            });
        } else if (decision.action === 'wait') {
            const waitMs = 2000;
            await this.page.waitForTimeout(waitMs);
            this.createTraceStep({
                action: 'wait',
                waitMs
            });
        }
    }
}
