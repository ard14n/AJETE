import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { DriveAgent } from './agent';
import { getMonkeyContextPersona, getPersona } from './config/personas';

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

const PORT = 3001;
const API_KEY = process.env.GEMINI_API_KEY;

const agent = new DriveAgent(API_KEY);

const DEFAULT_MODELS = [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
];

// WebSocket Broadcasting
const broadcast = (type: string, payload: any): number => {
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
            }
        } catch {
            // Ignore malformed WS messages from clients
        }
    });
});

// API Routes
app.post('/start', async (req, res) => {
    const { url, personaName, objective, debugMode, modelName, ttsEnabled, headlessMode } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const monkeyMode = String(personaName || '').toLowerCase() === 'monkey';
    const bareLlmMode = String(personaName || '').toLowerCase() === 'bare';
    const persona = monkeyMode ? getMonkeyContextPersona() : getPersona(personaName);

    const streamDebugMode = typeof debugMode === 'boolean' ? debugMode : true;
    const speechEnabled = typeof ttsEnabled === 'boolean' ? ttsEnabled : false;
    const runHeadless = typeof headlessMode === 'boolean' ? headlessMode : false;
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
        headlessMode: runHeadless
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
        headlessMode: runHeadless
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

        const payload = await response.json() as { models?: Array<any> };
        const models = (payload.models || [])
            .filter((model: any) => {
                const methods = model?.supportedGenerationMethods || [];
                return Array.isArray(methods) && methods.includes('generateContent');
            })
            .map((model: any) => {
                const id = String(model?.name || '').replace(/^models\//, '');
                const name = model?.displayName || id;
                return { id, name };
            })
            .filter((model: any) => model.id.toLowerCase().includes('gemini'))
            .sort((a: any, b: any) => a.id.localeCompare(b.id));

        if (models.length === 0) {
            return res.json({ models: DEFAULT_MODELS, source: 'fallback-empty' });
        }

        res.json({ models, source: 'api' });
    } catch (error) {
        console.error('Failed to load Gemini models:', error);
        res.json({ models: DEFAULT_MODELS, source: 'fallback-error' });
    }
});

app.post('/stop', async (req, res) => {
    await agent.stop();
    res.json({ status: 'stopped' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`DRIVE Backend running on port ${PORT}`);
});
