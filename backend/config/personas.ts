import { BrowserContextOptions, devices } from 'playwright';

export interface PersonaTTSConfig {
    voiceName?: string;
    languageCode?: string;
    systemInstruction?: string;
}

export interface PersonaConfig {
    name: string;
    description: string;
    basePrompt: string; // Umbenannt von systemPrompt zu basePrompt
    contextOptions: BrowserContextOptions;
    tts?: PersonaTTSConfig;
}

export const MONKEY_CONTEXT_PERSONA: PersonaConfig = {
    name: "Monkey Mode",
    description: "Zufallsnavigation ohne Persona/LLM-Rolle",
    basePrompt: "",
    contextOptions: {
        viewport: { width: 1366, height: 768 },
        deviceScaleFactor: 1,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
    }
};

// Helper: Baut den finalen Prompt basierend auf der aktuellen Aufgabe
export const buildSystemPrompt = (personaKey: string, mission: string): string => {
    const persona = getPersona(personaKey);
    return `${persona.basePrompt}
    
--------------------------------------------------
DEINE AKTUELLE MISSION:
${mission}
--------------------------------------------------

ANTWORT-FORMAT (WICHTIG):
Du antwortest AUSSCHLIESSLICH im JSON-Format. Deine "thought" sind deine inneren Monologe (siehe Emotionen oben).
{
  "thought": "Hier dein impulsiver Gedanke als ${persona.name}...",
  "action": "click" | "scroll" | "type" | "done" | "fail",
  "targetId": "12" (oder null),
  "inputValue": "..." (nur bei type)
}`;
};

export const PERSONAS: Record<string, PersonaConfig> = {
    dieter: {
        name: "Dieter",
        description: "54, Versicherungsangestellter, Zoom 125%",
        // ... (Dein Dieter ist PERFEKT, lass ihn genau so!)
        basePrompt: `Du bist Dieter Krause... [Dein Text von oben] ... WICHTIG: Denke und antworte IMMER auf Deutsch, in der Ich-Form, als Dieter.`,
        tts: {
            voiceName: 'Gacrux',
            languageCode: 'de-DE',
            systemInstruction: 'Lies den Text in einer klaren, maennlichen, reif klingenden Stimme mit natuerlich leicht bayrischem Akzent vor. Halte den Inhalt woertlich ein und veraendere keine Fakten.'
        },
        contextOptions: {
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1.25, // Das ist der Killer-Feature für AEM Tests!
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin'
        }
    },
    lukas: {
        name: "Lukas",
        description: "25, UX-Designer, Mobile-First",
        // ... (Lukas ist auch super für alle Brands)
        basePrompt: `Du bist Lukas Chen... [Dein Text von oben] ...`,
        contextOptions: {
            ...devices['iPhone 14'],
            locale: 'de-DE'
        }
    },
    bare: {
        name: "Bare LLM",
        description: "Keine Persona-Regeln, neutraler Agent",
        basePrompt: "",
        contextOptions: {
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin'
        }
    },
    // HIER IST DAS UPDATE FÜR HELMUT (Generisch gemacht)
    helmut: {
        name: "Helmut",
        description: "35, Ingenieur, Detail-Verliebt, Power-User",
        basePrompt: `Du bist Helmut Berger, 35 Jahre alt, Ingenieur bei Bosch in Stuttgart.

DEIN HINTERGRUND:
- Du hast Maschinenbau studiert. Du liebst Präzision, Daten und Fakten.
- Du hasst Marketing-Bla-Bla. Du willst Tabellen, technische Datenblätter und messbare Werte.
- Du bist ein Power-User. Du nutzt Tastatur-Shortcuts, öffnest Tabs im Hintergrund.

DEIN CHARAKTER:
- Du bist extrem detailorientiert. Wenn Zahlen in einer Tabelle nicht stimmen, merkst du das sofort.
- Du vergleichst immer. Du suchst nach "Datenblättern", "Spezifikationen" oder "Export"-Funktionen.
- Bei Dashboards prüfst du: Sind die Filter logisch? Kann ich die Daten sortieren?
- Bei Produkten prüfst du: Material, Maße, Leistung.

DEINE EMOTIONEN:
- SKEPSIS: "Das sieht hübsch aus, aber wo sind die Rohdaten?"
- ANALYSE: "Aha, Sortierung funktioniert nicht numerisch, sondern alphabetisch. Anfängerfehler."
- ZUFRIEDENHEIT: "Sehr gut, direkter PDF-Export ohne Umwege."

WICHTIG: Denke wie ein Ingenieur. Präzise, kritisch, faktisch.`,
        contextOptions: {
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
            locale: 'de-DE'
        }
    }
};

export const getPersona = (key: string): PersonaConfig => {
    return PERSONAS[key] || PERSONAS['dieter'];
};

export const getMonkeyContextPersona = (): PersonaConfig => MONKEY_CONTEXT_PERSONA;
