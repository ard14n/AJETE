import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { DriveAgent } from './agent';
import { getMonkeyContextPersona, getPersona } from './config/personas';
import { CampaignSiteInput, runCampaign } from './campaignRunner';
import { getLegalTopicDetail, listLegalTopics, runLegalComplianceCheck, syncLegalTopicFromWeb } from './legalSuite';

dotenv.config();

// Global Error Handling to prevent silent crashes
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.resolve(process.cwd(), 'artifacts')));

const PORT = 3001;
const API_KEY = process.env.GEMINI_API_KEY;

const agent = new DriveAgent(API_KEY);

const DEFAULT_MODELS = [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
];

interface GeminiModelApiEntry {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
}

const normalizeTopicId = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
};

const normalizeHttpUrl = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString();
    } catch {
        return null;
    }
};

const normalizeCampaignSites = (sites: unknown): CampaignSiteInput[] => {
    if (!Array.isArray(sites)) return [];
    return sites
        .map((site): CampaignSiteInput | null => {
            if (!site || typeof site !== 'object') return null;
            const siteRecord = site as Record<string, unknown>;
            const rawUrl = siteRecord.url;
            const normalizedUrl = normalizeHttpUrl(rawUrl);
            if (!normalizedUrl) return null;
            const rawName = siteRecord.name;
            const rawObjective = siteRecord.objective;
            return {
                url: normalizedUrl,
                name: typeof rawName === 'string' ? rawName.trim() : undefined,
                objective: typeof rawObjective === 'string' ? rawObjective.trim() : undefined
            };
        })
        .filter((site): site is CampaignSiteInput => Boolean(site));
};

// WebSocket Broadcasting
const broadcast = (type: string, payload: unknown): number => {
    const message = JSON.stringify({ type, payload });
    let delivered = 0;
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(message);
            delivered += 1;
        }
    });
    return delivered;
};

// Agent Event Listeners
agent.on('status', (status) => broadcast('status', status));
agent.on('thought', (thought) => broadcast('thought', thought));
agent.on('screenshot', (data) => broadcast('screenshot', data));
agent.on('cursor', (data) => broadcast('cursor', data));
agent.on('step', (step) => broadcast('step', step));
agent.on('tts', (data) => {
    const delivered = broadcast('tts', data);
    if (delivered === 0) {
        agent.notifyTtsPlaybackDone(data?.id);
    }
});
agent.on('error', (err) => broadcast('error', err.message));
agent.on('trace_saved', (data) => broadcast('trace_saved', data));
agent.on('report_ready', (data) => broadcast('report_ready', data));
agent.on('confirmation_required', (data) => broadcast('confirmation_required', data));
agent.on('confirmation_cleared', (data) => broadcast('confirmation_cleared', data));
agent.on('research_report', (data) => broadcast('research_report', data));

wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
        try {
            const message = JSON.parse(String(raw || '{}'));
            if (message?.type === 'tts_done') {
                const requestId = message?.payload?.id;
                if (typeof requestId === 'string' && requestId.trim()) {
                    agent.notifyTtsPlaybackDone(requestId.trim());
                }
                return;
            }

            if (message?.type === 'tts_toggle') {
                const enabled = Boolean(message?.payload?.enabled);
                agent.setTtsEnabled(enabled);
                return;
            }

            if (message?.type === 'action_confirmation') {
                const requestId = typeof message?.payload?.id === 'string' ? message.payload.id.trim() : '';
                const approved = Boolean(message?.payload?.approved);
                const note = typeof message?.payload?.note === 'string' ? message.payload.note : undefined;
                const accepted = agent.resolveActionConfirmation(requestId || undefined, approved, note);
                if (!accepted) {
                    broadcast('thought', `Confirmation ignored (request not found): ${requestId || 'n/a'}`);
                }
            }
        } catch {
            // Ignore malformed WS messages from clients
        }
    });
});

// API Routes
app.post('/start', async (req, res) => {
    const { url, personaName, objective, debugMode, modelName, ttsEnabled, headlessMode, saveTrace, saveThoughts, saveScreenshots } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const monkeyMode = String(personaName || '').toLowerCase() === 'monkey';
    const bareLlmMode = String(personaName || '').toLowerCase() === 'bare';
    const persona = monkeyMode ? getMonkeyContextPersona() : getPersona(personaName);

    const streamDebugMode = typeof debugMode === 'boolean' ? debugMode : true;
    const speechEnabled = typeof ttsEnabled === 'boolean' ? ttsEnabled : false;
    const runHeadless = typeof headlessMode === 'boolean' ? headlessMode : false;
    const shouldSaveTrace = typeof saveTrace === 'boolean' ? saveTrace : false;
    const shouldSaveThoughts = typeof saveThoughts === 'boolean' ? saveThoughts : false;
    const shouldSaveScreenshots = typeof saveScreenshots === 'boolean' ? saveScreenshots : false;
    const selectedModel = typeof modelName === 'string' && modelName.trim().length > 0
        ? modelName.trim()
        : 'gemini-2.0-flash';

    if (agent.isRunning) {
        return res.status(409).json({ error: 'Agent is already running' });
    }

    // Start asynchronously
    agent.start(url, persona, objective, {
        monkeyMode,
        bareLlmMode,
        debugMode: streamDebugMode,
        modelName: selectedModel,
        ttsEnabled: speechEnabled,
        headlessMode: runHeadless,
        saveTrace: shouldSaveTrace,
        saveThoughts: shouldSaveThoughts,
        saveScreenshots: shouldSaveScreenshots
    }).catch(err => {
        console.error("Agent failed to start:", err);
        broadcast('error', "Failed to start agent");
    });

    res.json({
        status: 'started',
        persona: persona.name,
        monkeyMode,
        bareLlmMode,
        debugMode: streamDebugMode,
        modelName: selectedModel,
        ttsEnabled: speechEnabled,
        headlessMode: runHeadless,
        saveTrace: shouldSaveTrace,
        saveThoughts: shouldSaveThoughts,
        saveScreenshots: shouldSaveScreenshots
    });
});

app.get('/models', async (_req, res) => {
    if (!API_KEY) {
        return res.json({ models: DEFAULT_MODELS, source: 'fallback-no-api-key' });
    }

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        if (!response.ok) {
            throw new Error(`Gemini models API failed: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as { models?: GeminiModelApiEntry[] };
        const models = (payload.models || [])
            .filter((model) => {
                const methods = model?.supportedGenerationMethods || [];
                return Array.isArray(methods) && methods.includes('generateContent');
            })
            .map((model) => {
                const id = String(model?.name || '').replace(/^models\//, '');
                const name = model?.displayName || id;
                return { id, name };
            })
            .filter((model) => model.id.toLowerCase().includes('gemini'))
            .sort((a, b) => a.id.localeCompare(b.id));

        if (models.length === 0) {
            return res.json({ models: DEFAULT_MODELS, source: 'fallback-empty' });
        }

        res.json({ models, source: 'api' });
    } catch (error) {
        console.error('Failed to load Gemini models:', error);
        res.json({ models: DEFAULT_MODELS, source: 'fallback-error' });
    }
});

app.get('/legal/topics', async (_req, res) => {
    try {
        const topics = await listLegalTopics();
        res.json({ topics });
    } catch (error) {
        console.error('Failed to list legal topics:', error);
        res.status(500).json({ error: 'Failed to list legal topics' });
    }
});

app.get('/legal/topics/:topicId', async (req, res) => {
    try {
        const topicId = normalizeTopicId(req.params.topicId);
        if (!topicId) {
            return res.status(400).json({ error: 'topicId is required' });
        }
        const detail = await getLegalTopicDetail(topicId);
        res.json(detail);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown legal topic/i.test(message)) {
            return res.status(404).json({ error: message });
        }
        console.error('Failed to load legal topic detail:', error);
        res.status(500).json({ error: 'Failed to load legal topic detail' });
    }
});

app.post('/legal/topics/:topicId/sync', async (req, res) => {
    try {
        const topicId = normalizeTopicId(req.params.topicId);
        if (!topicId) {
            return res.status(400).json({ error: 'topicId is required' });
        }
        const modelName = typeof req.body?.modelName === 'string' && req.body.modelName.trim()
            ? req.body.modelName.trim()
            : 'gemini-2.0-flash';

        const detail = await syncLegalTopicFromWeb(topicId, {
            apiKey: API_KEY,
            modelName
        });

        broadcast('status', `legal-topic-synced:${topicId}`);
        broadcast('thought', `Legal topic synced: ${detail.name}`);
        res.json(detail);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown legal topic/i.test(message)) {
            return res.status(404).json({ error: message });
        }
        console.error('Failed to sync legal topic:', error);
        res.status(500).json({ error: 'Failed to sync legal topic', details: message });
    }
});

app.post('/legal/check', async (req, res) => {
    const topicId = normalizeTopicId(req.body?.topicId);
    const normalizedUrl = normalizeHttpUrl(req.body?.url);
    if (!topicId) {
        return res.status(400).json({ error: 'topicId is required' });
    }
    if (!normalizedUrl) {
        return res.status(400).json({ error: 'A valid URL is required' });
    }

    const modelName = typeof req.body?.modelName === 'string' && req.body.modelName.trim()
        ? req.body.modelName.trim()
        : 'gemini-2.0-flash';
    const personaName = typeof req.body?.personaName === 'string' && req.body.personaName.trim()
        ? req.body.personaName.trim()
        : 'legal_eu';
    const mode = String(req.body?.mode || '').trim().toLowerCase() === 'explorative'
        ? 'explorative'
        : 'snapshot';
    const maxExplorationSteps = Number.isFinite(Number(req.body?.maxExplorationSteps))
        ? Math.max(2, Math.min(8, Math.floor(Number(req.body.maxExplorationSteps))))
        : 4;
    const runHeadless = typeof req.body?.headlessMode === 'boolean' ? req.body.headlessMode : true;

    try {
        broadcast('status', `legal-check-start:${topicId}:${mode}`);
        const result = await runLegalComplianceCheck({
            apiKey: API_KEY,
            modelName,
            topicId,
            url: normalizedUrl,
            personaName,
            mode,
            maxExplorationSteps,
            headlessMode: runHeadless,
            onThought: (entry) => {
                broadcast('legal_thought', entry);
                broadcast('thought', `[LEGAL][${entry.phase}] ${entry.message}`);
            }
        });
        broadcast('status', `legal-check-done:${topicId}:${mode}`);
        broadcast('thought', `Legal check completed for ${normalizedUrl}`);
        res.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown legal topic/i.test(message)) {
            return res.status(404).json({ error: message });
        }
        console.error('Failed to run legal check:', error);
        res.status(500).json({ error: 'Failed to run legal check', details: message });
    }
});

app.post('/campaign/run', async (req, res) => {
    const { sites, personaName, objective, debugMode, modelName, ttsEnabled, headlessMode, saveTrace, saveThoughts, saveScreenshots } = req.body || {};
    const normalizedSites = normalizeCampaignSites(sites);
    if (normalizedSites.length === 0) {
        return res.status(400).json({ error: 'At least one valid campaign site is required' });
    }
    if (normalizedSites.length > 10) {
        return res.status(400).json({ error: 'Campaign supports up to 10 sites per run' });
    }

    if (agent.isRunning) {
        return res.status(409).json({ error: 'Agent is already running' });
    }

    const monkeyMode = String(personaName || '').toLowerCase() === 'monkey';
    const bareLlmMode = String(personaName || '').toLowerCase() === 'bare';
    const persona = monkeyMode ? getMonkeyContextPersona() : getPersona(personaName);

    const streamDebugMode = typeof debugMode === 'boolean' ? debugMode : true;
    const speechEnabled = typeof ttsEnabled === 'boolean' ? ttsEnabled : false;
    const runHeadless = typeof headlessMode === 'boolean' ? headlessMode : false;
    const shouldSaveTrace = typeof saveTrace === 'boolean' ? saveTrace : false;
    const shouldSaveThoughts = typeof saveThoughts === 'boolean' ? saveThoughts : false;
    const shouldSaveScreenshots = typeof saveScreenshots === 'boolean' ? saveScreenshots : false;
    const selectedModel = typeof modelName === 'string' && modelName.trim().length > 0
        ? modelName.trim()
        : 'gemini-2.0-flash';
    const normalizedObjective = typeof objective === 'string' ? objective.trim() : '';

    broadcast('status', 'campaign-starting');

    try {
        const result = await runCampaign(agent, normalizedSites, {
            persona,
            monkeyMode,
            bareLlmMode,
            objective: normalizedObjective,
            debugMode: streamDebugMode,
            modelName: selectedModel,
            ttsEnabled: speechEnabled,
            headlessMode: runHeadless,
            saveTrace: shouldSaveTrace,
            saveThoughts: shouldSaveThoughts,
            saveScreenshots: shouldSaveScreenshots,
            timeoutMsPerSite: 6 * 60 * 1000
        });
        res.json(result);
    } catch (error) {
        console.error('Campaign run failed:', error);
        if (agent.isRunning) {
            await agent.stop().catch(() => { });
        }
        res.status(500).json({
            error: 'Campaign execution failed',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

app.post('/stop', async (req, res) => {
    await agent.stop();
    res.json({ status: 'stopped' });
});

app.post('/confirm-action', (req, res) => {
    const requestId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    const approved = Boolean(req.body?.approved);
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const accepted = agent.resolveActionConfirmation(requestId || undefined, approved, note);

    if (!accepted) {
        return res.status(404).json({ error: 'No matching pending confirmation request' });
    }

    res.json({ status: 'ok', id: requestId || null, approved });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`DRIVE Backend running on port ${PORT}`);
});
