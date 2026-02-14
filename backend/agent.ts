import { EventEmitter } from 'events';
import { chromium, Browser, BrowserContext, Locator, Page } from 'playwright';
import { PersonaConfig, PersonaTTSConfig } from './config/personas';
import { injectSoM, setSoMOverlayVisibility, SoMElementMeta, SoMResult } from './utils/som';
import { CursorPoint, ensureVisualCursor, generateHumanCursorPath, moveVisualCursor, showCursorClickEffect } from './utils/cursor';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
}

interface TTSAudioPayload {
    audioBase64: string;
    mimeType: string;
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
    }

    async start(url: string, persona: PersonaConfig, objective?: string, options?: AgentStartOptions) {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isMonkeyMode = Boolean(options?.monkeyMode);
        this.isBareLlmMode = Boolean(options?.bareLlmMode);
        this.isDebugMode = options?.debugMode !== false;
        this.isTtsEnabled = Boolean(options?.ttsEnabled);
        this.isHeadlessMode = Boolean(options?.headlessMode);
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
        this.clearPendingTtsAck();
        this.emit('status', 'starting');

        try {
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
            if (this.isTtsEnabled) {
                this.emit('thought', `TTS Voice: ${this.ttsConfig.voiceName} (${this.ttsConfig.languageCode})`);
            }

            // Use domcontentloaded to avoid waiting for heavy SPAs to fully load
            try {
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (navError: any) {
                this.emit('thought', `⚠️ Navigation warning: ${navError.message}. Continuing anyway...`);
            }

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
        this.selectedModelName = 'gemini-2.0-flash';
        this.ttsConfig = {
            voiceName: DEFAULT_TTS_VOICE,
            languageCode: DEFAULT_TTS_LANGUAGE,
            systemInstruction: ''
        };
        this.trackedPages = new WeakSet<Page>();
        this.autoFollowedPages = new WeakSet<Page>();
        this.clearPendingTtsAck();
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

        await locator.scrollIntoViewIfNeeded().catch(() => { });
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
            const point = this.pickTargetPoint(box);
            await this.clickAtPoint(point);
        } else {
            await locator.click({ timeout: 2000 }).catch(() => { });
        }

        await this.page.waitForTimeout(850);
        const stillVisible = await this.isCookieSurfaceVisible();
        if (!stillVisible) {
            console.log(`🍪 Cookie dismissed via ${source}`);
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
            await this.page.mouse.wheel(0, this.randomBetween(320, 680));
        } else if (decision.action === 'type' && decision.targetId && decision.value) {
            const selector = `[data-som-id="${decision.targetId}"]`;
            const locator = this.page.locator(selector).first();
            if (await locator.count() === 0) {
                this.markTargetFailure(decision.targetId);
                throw new Error(`Input ${decision.targetId} not found`);
            }

            await locator.scrollIntoViewIfNeeded();
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
        } else if (decision.action === 'wait') {
            await this.page.waitForTimeout(2000);
        }
    }
}
