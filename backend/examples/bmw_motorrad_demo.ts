import dotenv from 'dotenv';
import { DriveAgent } from '../agent';
import { getPersona } from '../config/personas';

dotenv.config();

const runTest = async () => {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        console.error("Please set GEMINI_API_KEY in .env");
        process.exit(1);
    }

    const agent = new DriveAgent(API_KEY);
    const persona = getPersona('helmut');
    const url = 'https://www.bmw-motorrad.de';
    const objective = "Navigiere über das Menü zu 'Modelle', finde die 'R 1300 GS' und klicke auf 'Konfigurieren'. Brich ab, wenn du im Konfigurator bist.";

    console.log(`🚀 Starting Test: BMW Motorrad Journey`);
    console.log(`👤 Persona: ${persona.name}`);
    console.log(`🎯 Objective: ${objective}`);

    // Log events to console
    agent.on('thought', (msg) => console.log(`🧠 Thought: ${msg}`));
    agent.on('status', (status) => console.log(`🔄 Status: ${status}`));
    agent.on('step', (step) => console.log(`👉 Action: ${step.action} -> ${step.targetId || 'N/A'}`));
    agent.on('error', (err) => console.error(`❌ Error: ${err}`));

    await agent.start(url, persona, objective);
};

runTest().catch(console.error);
