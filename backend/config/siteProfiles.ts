export interface SiteProfile {
    id: string;
    label: string;
    description: string;
    hostPatterns: RegExp[];
    navigationPriorities: string[];
    antiPatterns: string[];
    researchSignals: string[];
    riskKeywords: string[];
}

const GLOBAL_RESEARCH_KEYWORDS = [
    'best', 'top', 'vergleich', 'compare', 'research', 'review', 'rating',
    'produkt', 'produkte', 'product', 'preis', 'price', 'angebot', 'deal',
    'amazon', 'kaufen', 'kauf', 'buy'
];

const GLOBAL_HIGH_RISK_KEYWORDS = [
    'buy now', 'jetzt kaufen', 'zahlung', 'payment', 'pay now', 'checkout',
    'bestellung', 'order now', 'submit', 'confirm order', 'buchung',
    'book now', 'jetzt buchen', 'vertrag', 'apply now'
];

const AMAZON_PROFILE: SiteProfile = {
    id: 'amazon',
    label: 'Amazon Commerce',
    description: 'Produktrecherche in einem Marketplace mit vielen gesponserten und duplizierten Elementen.',
    hostPatterns: [/^(.+\.)?amazon\./i, /^(.+\.)?amzn\./i],
    navigationPriorities: [
        'Nutze Suchfeld + Filter + Sortierung, bevor du zufaellig klickst.',
        'Bevorzuge Produktkarten mit Preis + Bewertung + Titel.',
        'Nutze Produktdetailseiten fuer harte Fakten (Specs, Lieferzeit, Rueckgabe).',
        'Sammle mindestens 3-5 Kandidaten vor finaler Empfehlung.'
    ],
    antiPatterns: [
        'Nicht nur gesponserte Treffer bewerten.',
        'Nicht auf Warenkorb/Buy-Buttons klicken ohne explizite Freigabe.',
        'Nicht in Endlosschleifen zwischen Suchergebnis und Startseite springen.'
    ],
    researchSignals: [
        'preis', 'bewertung', 'sterne', 'rezensionen', 'lieferung', 'rueckgabe',
        'review', 'rating', 'price', 'delivery', 'warranty', 'spec'
    ],
    riskKeywords: [
        'buy now', 'jetzt kaufen', 'in den einkaufswagen', 'add to cart',
        'zur kasse', 'checkout', 'zahlung', 'payment', 'place your order'
    ]
};

const GENERIC_PROFILE: SiteProfile = {
    id: 'generic',
    label: 'Generic Web',
    description: 'Allgemeine Webnavigation mit Fokus auf robuste Orientierung, Menue-Handling und Overlay-Sicherheit.',
    hostPatterns: [],
    navigationPriorities: [
        'Bei offenem Overlay zuerst Overlay-Optionen auswerten, nicht den Hintergrund.',
        'Nach Sackgassen einen neuen Navigationspfad waehlen (Menue, Breadcrumb, Footer, Suche).',
        'Nutze sichtbare Labels und semantische Elemente mit klarer Bedeutung.',
        'Wenn ein Flow scheitert, begruende den Wechsel transparent in den Gedanken.'
    ],
    antiPatterns: [
        'Keine wiederholten Klicks auf dieselbe ID ohne neue Evidenz.',
        'Keine riskanten Submit/Buy-Aktionen ohne explizite Freigabe.'
    ],
    researchSignals: [
        'preis', 'kosten', 'vergleich', 'bewertung', 'rating', 'review', 'spec',
        'leistung', 'garantie', 'lieferung', 'return'
    ],
    riskKeywords: [
        'submit', 'confirm', 'zahlung', 'payment', 'order', 'book', 'buy', 'checkout'
    ]
};

export const SITE_PROFILES: SiteProfile[] = [
    AMAZON_PROFILE,
    GENERIC_PROFILE
];

const safeParseHost = (url?: string): string => {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        return parsed.hostname.toLowerCase();
    } catch {
        return '';
    }
};

export const detectSiteProfile = (url?: string): SiteProfile => {
    const host = safeParseHost(url);
    if (!host) return GENERIC_PROFILE;

    for (const profile of SITE_PROFILES) {
        if (profile.hostPatterns.length === 0) continue;
        if (profile.hostPatterns.some((pattern) => pattern.test(host))) {
            return profile;
        }
    }

    return GENERIC_PROFILE;
};

export const isResearchObjective = (objective?: string): boolean => {
    const normalized = String(objective || '').toLowerCase();
    if (!normalized) return false;
    return GLOBAL_RESEARCH_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

export const isHighRiskObjective = (objective?: string): boolean => {
    const normalized = String(objective || '').toLowerCase();
    if (!normalized) return false;
    return GLOBAL_HIGH_RISK_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

export const shouldEnableResearchScoring = (objective?: string, profile?: SiteProfile): boolean => {
    if (isResearchObjective(objective)) return true;
    if (!profile) return false;
    return profile.id === 'amazon';
};

