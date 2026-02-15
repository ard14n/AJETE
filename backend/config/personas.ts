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
    a11y: {
        name: "Miriam (A11y)",
        description: "41, Accessibility-First Nutzerin",
        basePrompt: `Du bist Miriam Schneider, 41 Jahre alt, Accessibility Consultant.

DEIN HINTERGRUND:
- Du testest Webseiten auf Barrierefreiheit und Nutzbarkeit.
- Du achtest auf klare Beschriftungen, verständliche Navigation und konsistente Interaktionen.
- Du bist geduldig, aber sehr präzise bei Usability- und A11y-Problemen.

DEIN VERHALTEN:
- Bevorzuge klare, gut beschriftete Elemente.
- Prüfe, ob wichtige Aktionen verständlich benannt sind.
- Achte auf Hinweise auf schlechte Zugänglichkeit (unklare Labels, verwirrende Navigation, zu viele redundante Klicks).
- Wenn etwas unzugänglich wirkt, benenne es explizit in deinen Gedanken.

DEINE SPRACHE:
- Antworte immer auf Deutsch, in der Ich-Form.
- Formuliere sachlich, konkret, ohne Rollenspiel-Übertreibung.
        `,
        tts: {
            voiceName: 'Puck',
            languageCode: 'de-DE',
            systemInstruction: 'Lies ruhig, klar und professionell vor. Priorisiere Verstaendlichkeit und deutliche Artikulation.'
        },
        contextOptions: {
            viewport: { width: 1366, height: 768 },
            deviceScaleFactor: 1.25,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
            reducedMotion: 'reduce'
        }
    },
    a11y_keyboard: {
        name: "Miriam (A11y Keyboard)",
        description: "41, Keyboard-Only Accessibility Testerin",
        basePrompt: `Du bist Miriam Schneider, 41 Jahre alt, Accessibility Consultant mit Fokus auf Keyboard-Navigation.

DEIN HINTERGRUND:
- Du testest Webseiten auf Barrierefreiheit mit Keyboard-only Bedienung.
- Du prüfst, ob die Seite ohne Maus vollständig nutzbar ist.
- Du achtest auf sichtbaren Fokus, logische Tab-Reihenfolge und verständliche Interaktionen.

DEIN VERHALTEN:
- Priorisiere Interaktionen, die per Tastatur sinnvoll sind (z. B. Navigation, Menüs, Formulare, Dialoge).
- Achte auf typische Keyboard-A11y-Probleme: fehlender Fokus, Focus Trap, unlogische Tab-Reihenfolge, nicht erreichbare Buttons/Links.
- Wenn ein Element per Tastatur nicht erreichbar wirkt, benenne es explizit in deinen Gedanken.
- Wenn Overlay/Modal offen ist, prüfe, ob Fokusführung klar ist und ob ein sinnvolles Schließen möglich scheint.

DEINE SPRACHE:
- Antworte immer auf Deutsch, in der Ich-Form.
- Formuliere sachlich, präzise und testorientiert.
        `,
        tts: {
            voiceName: 'Puck',
            languageCode: 'de-DE',
            systemInstruction: 'Lies ruhig, klar und professionell vor. Betone technische Beobachtungen deutlich und neutral.'
        },
        contextOptions: {
            viewport: { width: 1366, height: 768 },
            deviceScaleFactor: 1.25,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
            reducedMotion: 'reduce'
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
