import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chromium, BrowserContext, Page } from 'playwright';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPersona } from './config/personas';
import { LEGAL_TOPICS, LegalSourceDefinition, LegalTopicDefinition, getLegalTopicDefinition } from './config/legalTopics';
import { injectSoM, SoMElementMeta, SoMResult } from './utils/som';

export interface LegalRequirementSourceRef {
    url: string;
    title: string;
    note: string;
}

export interface LegalRequirement {
    id: string;
    title: string;
    plainLanguage: string;
    practicalExpectation: string;
    whyImportant: string;
    evidenceHints: string[];
    sourceRefs: LegalRequirementSourceRef[];
}

interface LegalSourceSnapshot {
    id: string;
    title: string;
    url: string;
    authority: string;
    note?: string;
    retrievedAt: string;
    contentLength: number;
    excerpt: string;
}

interface LegalTopicFile {
    version: 1;
    topicId: string;
    name: string;
    region: string;
    legalArea: string;
    description: string;
    focusChecks: string[];
    generatedAt: string;
    generatedBy: string;
    sources: LegalSourceDefinition[];
    sourceSnapshots: LegalSourceSnapshot[];
    requirements: LegalRequirement[];
}

export interface LegalTopicSummary {
    id: string;
    name: string;
    region: string;
    legalArea: string;
    description: string;
    sourcesCount: number;
    requirementsCount: number;
    lastSyncedAt: string | null;
    generatedBy: string | null;
}

export interface LegalTopicDetail {
    id: string;
    name: string;
    region: string;
    legalArea: string;
    description: string;
    focusChecks: string[];
    sources: LegalSourceDefinition[];
    requirements: LegalRequirement[];
    requirementsFileUrl?: string;
    lastSyncedAt: string | null;
    generatedBy: string | null;
}

export interface LegalCheckFinding {
    requirementId: string;
    title: string;
    status: 'pass' | 'fail' | 'needs-review' | 'not-applicable';
    confidence: number;
    reasoning: string;
    evidence: string[];
    recommendation: string;
    sourceRefs: LegalRequirementSourceRef[];
}

export interface LegalThoughtEntry {
    timestamp: string;
    phase: 'setup' | 'navigation' | 'analysis' | 'scoring' | 'report';
    message: string;
}

export interface LegalJourneyStep {
    step: number;
    url: string;
    title: string;
    action: string;
    candidateLabel?: string;
    candidateHref?: string;
    somCount?: number;
    segmentHint?: string;
}

export type LegalCheckMode = 'snapshot' | 'explorative';

export interface LegalCheckResult {
    checkId: string;
    topicId: string;
    topicName: string;
    url: string;
    personaName: string;
    mode: LegalCheckMode;
    explorationSteps: number;
    startedAt: string;
    endedAt: string;
    overallScore: number;
    summary: {
        pass: number;
        fail: number;
        needsReview: number;
        notApplicable: number;
        total: number;
        modelSummary: string;
    };
    findings: LegalCheckFinding[];
    thoughts: LegalThoughtEntry[];
    journey: LegalJourneyStep[];
    som: {
        marks: number;
        segments: string[];
    };
    artifacts: {
        resultJsonPath: string;
        resultJsonUrl: string;
        reportMdPath: string;
        reportMdUrl: string;
        screenshotPath: string;
        screenshotUrl: string;
    };
}

interface SyncTopicOptions {
    apiKey?: string;
    modelName?: string;
}

interface RunLegalCheckOptions {
    apiKey?: string;
    modelName?: string;
    topicId: string;
    url: string;
    personaName?: string;
    mode?: LegalCheckMode;
    maxExplorationSteps?: number;
    headlessMode?: boolean;
    onThought?: (entry: LegalThoughtEntry) => void;
}

const DEFAULT_LEGAL_MODEL = 'gemini-2.0-flash';
const ARTIFACTS_ROOT = path.resolve(process.cwd(), 'artifacts');
const LEGAL_ROOT = path.join(ARTIFACTS_ROOT, 'legal');
const LEGAL_TOPICS_DIR = path.join(LEGAL_ROOT, 'topics');
const LEGAL_CHECKS_DIR = path.join(LEGAL_ROOT, 'checks');

const nowIso = () => new Date().toISOString();

const LEGAL_NAV_KEYWORDS = [
    'datenschutz', 'privacy', 'policy', 'cookie', 'consent', 'impressum', 'legal', 'terms', 'agb', 'recht',
    'accessibility', 'barriere', 'kontakt', 'contact', 'support', 'hilfe', 'settings', 'einstellungen', 'account',
    'profil', 'data', 'rights', 'compliance', 'notice'
];

const LEGAL_NAV_NOISE = [
    'facebook', 'instagram', 'youtube', 'tiktok', 'linkedin', 'x.com', 'twitter', 'pinterest', 'spotify'
];

interface ExplorationCandidate {
    somId: number;
    label: string;
    href: string;
    x: number;
    y: number;
    score: number;
    segmentHint: string;
}

interface CollectedPageSnapshot {
    url: string;
    title: string;
    visibleText: string;
    interactiveLabels: string[];
    candidates: ExplorationCandidate[];
    somCount: number;
    segmentHints: string[];
    screenshotBase64: string;
    screenshotPath: string;
}

interface CollectedPageSignals {
    title: string;
    visibleText: string;
    interactiveLabels: string[];
    somCount: number;
    segmentHints: string[];
    screenshotBase64: string;
    screenshotPath: string;
    screenshotUrl: string;
    journey: LegalJourneyStep[];
}

interface SoMPositionMeta {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    href: string;
    segmentHint: string;
}

const toDownloadUrl = (absolutePath: string): string => {
    const relative = path.relative(ARTIFACTS_ROOT, absolutePath).split(path.sep).join('/');
    return `/downloads/${relative}`;
};

const ensureLegalDirs = async (): Promise<void> => {
    await fs.mkdir(LEGAL_TOPICS_DIR, { recursive: true });
    await fs.mkdir(LEGAL_CHECKS_DIR, { recursive: true });
};

const topicFilePath = (topicId: string) => path.join(LEGAL_TOPICS_DIR, `${topicId}.json`);

const sanitizeFileNamePart = (value: string): string => {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'item';
};

const normalizeUrl = (raw: string): string => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
        throw new Error('URL is required');
    }
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs are supported');
    }
    return parsed.toString();
};

const clampExplorationSteps = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(2, Math.min(8, Math.floor(parsed)));
};

const resolveLegalMode = (value: unknown): LegalCheckMode => {
    return String(value || '').trim().toLowerCase() === 'explorative' ? 'explorative' : 'snapshot';
};

const resolveLegalPersonaKey = (value: unknown): 'legal_eu' | 'bare' => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'bare' ? 'bare' : 'legal_eu';
};

const extractFirstJsonObject = (text: string): string | null => {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
};

const parseModelJson = (responseText: string): unknown => {
    const cleaned = responseText
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch {
        const jsonBlock = extractFirstJsonObject(cleaned);
        if (!jsonBlock) {
            throw new Error('LLM did not return valid JSON');
        }
        return JSON.parse(jsonBlock);
    }
};

const htmlToText = (html: string): string => {
    const withoutScript = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
        .replace(/<!--([\s\S]*?)-->/g, ' ')
        .replace(/<[^>]+>/g, ' ');

    return withoutScript
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'DRIVE-LegalSuite/1.0 (+compliance research tool)'
            }
        });
    } finally {
        clearTimeout(timeout);
    }
};

const fetchSourceSnapshot = async (source: LegalSourceDefinition): Promise<LegalSourceSnapshot> => {
    const response = await fetchWithTimeout(source.url, 30000);
    if (!response.ok) {
        throw new Error(`Source fetch failed ${source.url} (${response.status} ${response.statusText})`);
    }

    const html = await response.text();
    const text = htmlToText(html);
    const excerpt = text.slice(0, 14000);

    return {
        id: source.id,
        title: source.title,
        url: source.url,
        authority: source.authority,
        note: source.note,
        retrievedAt: nowIso(),
        contentLength: text.length,
        excerpt
    };
};

const fallbackRequirementsFromTopic = (topic: LegalTopicDefinition): LegalRequirement[] => {
    return topic.focusChecks.map((focus, index) => ({
        id: `REQ-${String(index + 1).padStart(3, '0')}`,
        title: focus,
        plainLanguage: `This check maps to: ${focus}.`,
        practicalExpectation: `Verify whether the website contains clear and user-visible implementation for: ${focus}.`,
        whyImportant: 'This requirement is derived from the selected legal topic baseline and should be validated with legal counsel for final interpretation.',
        evidenceHints: [
            'Look for explicit user-facing text and labels.',
            'Look for dedicated legal or policy pages and flows.',
            'Check whether users can act on the information (not only read it).'
        ],
        sourceRefs: topic.sources.map((source) => ({
            url: source.url,
            title: source.title,
            note: source.note || 'Primary legal source.'
        }))
    }));
};

const normalizeSourceRefs = (raw: unknown, topic: LegalTopicDefinition): LegalRequirementSourceRef[] => {
    if (!Array.isArray(raw)) {
        return topic.sources.map((source) => ({
            url: source.url,
            title: source.title,
            note: source.note || 'Primary legal source.'
        }));
    }

    const refs: LegalRequirementSourceRef[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const url = typeof obj.url === 'string' ? obj.url.trim() : '';
        const title = typeof obj.title === 'string' ? obj.title.trim() : '';
        const note = typeof obj.note === 'string' ? obj.note.trim() : '';
        if (!url) continue;
        refs.push({
            url,
            title: title || 'Source',
            note: note || 'No note provided'
        });
    }

    if (refs.length > 0) return refs;
    return topic.sources.map((source) => ({
        url: source.url,
        title: source.title,
        note: source.note || 'Primary legal source.'
    }));
};

const normalizeRequirements = (payload: unknown, topic: LegalTopicDefinition): LegalRequirement[] => {
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const rawRequirements = Array.isArray(root.requirements) ? root.requirements : [];

    const requirements: LegalRequirement[] = [];
    for (let i = 0; i < rawRequirements.length; i++) {
        const item = rawRequirements[i];
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;

        const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : '';
        if (!rawTitle) continue;

        const id = typeof obj.id === 'string' && obj.id.trim()
            ? obj.id.trim()
            : `REQ-${String(i + 1).padStart(3, '0')}`;

        const plainLanguage = typeof obj.plainLanguage === 'string' && obj.plainLanguage.trim()
            ? obj.plainLanguage.trim()
            : (typeof obj.summary === 'string' ? obj.summary.trim() : `Requirement on ${rawTitle}.`);

        const practicalExpectation = typeof obj.practicalExpectation === 'string' && obj.practicalExpectation.trim()
            ? obj.practicalExpectation.trim()
            : (typeof obj.whatToCheck === 'string' ? obj.whatToCheck.trim() : 'Check whether users can see and use this requirement in the website UX.');

        const whyImportant = typeof obj.whyImportant === 'string' && obj.whyImportant.trim()
            ? obj.whyImportant.trim()
            : (typeof obj.risk === 'string' ? obj.risk.trim() : 'Potential compliance and trust risk if this is missing.');

        const evidenceHintsRaw = Array.isArray(obj.evidenceHints) ? obj.evidenceHints : [];
        const evidenceHints = evidenceHintsRaw
            .map((hint) => (typeof hint === 'string' ? hint.trim() : ''))
            .filter((hint) => hint.length > 0)
            .slice(0, 6);

        requirements.push({
            id,
            title: rawTitle,
            plainLanguage,
            practicalExpectation,
            whyImportant,
            evidenceHints: evidenceHints.length > 0 ? evidenceHints : ['Verify user-visible implementation on legal pages, consent surfaces, and account/contact pathways.'],
            sourceRefs: normalizeSourceRefs(obj.sourceRefs, topic)
        });
    }

    if (requirements.length > 0) {
        return requirements.slice(0, 20);
    }

    return fallbackRequirementsFromTopic(topic);
};

const synthesizeRequirementsWithGemini = async (
    apiKey: string,
    modelName: string,
    topic: LegalTopicDefinition,
    snapshots: LegalSourceSnapshot[]
): Promise<LegalRequirement[]> => {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const compactSources = snapshots.map((snapshot) => ({
        id: snapshot.id,
        title: snapshot.title,
        url: snapshot.url,
        authority: snapshot.authority,
        excerpt: snapshot.excerpt
    }));

    const prompt = `
You are a senior EU legal compliance analyst.

Task:
Convert the provided legal source excerpts into practical website compliance requirements.
Focus on user-visible and process-visible obligations that can be audited from a website.
Do NOT invent source URLs. Use only the provided URLs.

Topic:
- id: ${topic.id}
- name: ${topic.name}
- region: ${topic.region}
- legalArea: ${topic.legalArea}
- description: ${topic.description}

Focus Checks:
${topic.focusChecks.map((check, idx) => `${idx + 1}. ${check}`).join('\n')}

Sources JSON:
${JSON.stringify(compactSources, null, 2)}

Return STRICT JSON only:
{
  "requirements": [
    {
      "id": "REQ-001",
      "title": "short requirement title",
      "plainLanguage": "what this means in plain language",
      "practicalExpectation": "how this should appear/behave on a website",
      "whyImportant": "compliance risk if missing",
      "evidenceHints": ["hint 1", "hint 2"],
      "sourceRefs": [
        {
          "url": "exact provided source URL",
          "title": "source title",
          "note": "short article or section note"
        }
      ]
    }
  ]
}

Constraints:
- 6 to 14 requirements.
- Keep each requirement actionable and testable.
- If uncertain, be conservative and set clear "needs legal review" language in whyImportant.
`;

    const result = await model.generateContent([prompt]);
    const text = result.response.text();
    const parsed = parseModelJson(text);
    return normalizeRequirements(parsed, topic);
};

const readTopicFile = async (topicId: string): Promise<LegalTopicFile | null> => {
    try {
        const raw = await fs.readFile(topicFilePath(topicId), 'utf8');
        return JSON.parse(raw) as LegalTopicFile;
    } catch {
        return null;
    }
};

const toTopicSummary = (topic: LegalTopicDefinition, topicFile: LegalTopicFile | null): LegalTopicSummary => {
    return {
        id: topic.id,
        name: topic.name,
        region: topic.region,
        legalArea: topic.legalArea,
        description: topic.description,
        sourcesCount: topic.sources.length,
        requirementsCount: topicFile?.requirements?.length || 0,
        lastSyncedAt: topicFile?.generatedAt || null,
        generatedBy: topicFile?.generatedBy || null
    };
};

export const listLegalTopics = async (): Promise<LegalTopicSummary[]> => {
    await ensureLegalDirs();
    const summaries: LegalTopicSummary[] = [];

    for (const topic of LEGAL_TOPICS) {
        const cached = await readTopicFile(topic.id);
        summaries.push(toTopicSummary(topic, cached));
    }

    return summaries;
};

export const getLegalTopicDetail = async (topicId: string): Promise<LegalTopicDetail> => {
    await ensureLegalDirs();
    const topic = getLegalTopicDefinition(topicId);
    if (!topic) {
        throw new Error(`Unknown legal topic: ${topicId}`);
    }

    const file = await readTopicFile(topic.id);
    return {
        id: topic.id,
        name: topic.name,
        region: topic.region,
        legalArea: topic.legalArea,
        description: topic.description,
        focusChecks: topic.focusChecks,
        sources: topic.sources,
        requirements: file?.requirements || [],
        requirementsFileUrl: file ? toDownloadUrl(topicFilePath(topic.id)) : undefined,
        lastSyncedAt: file?.generatedAt || null,
        generatedBy: file?.generatedBy || null
    };
};

export const syncLegalTopicFromWeb = async (topicId: string, options?: SyncTopicOptions): Promise<LegalTopicDetail> => {
    await ensureLegalDirs();
    const topic = getLegalTopicDefinition(topicId);
    if (!topic) {
        throw new Error(`Unknown legal topic: ${topicId}`);
    }

    const snapshots = await Promise.all(topic.sources.map((source) => fetchSourceSnapshot(source)));

    let requirements: LegalRequirement[];
    const modelName = (options?.modelName || DEFAULT_LEGAL_MODEL).trim() || DEFAULT_LEGAL_MODEL;

    if (options?.apiKey && options.apiKey.trim()) {
        try {
            requirements = await synthesizeRequirementsWithGemini(options.apiKey, modelName, topic, snapshots);
        } catch (error) {
            console.warn(`Gemini legal synthesis failed for ${topicId}:`, error);
            requirements = fallbackRequirementsFromTopic(topic);
        }
    } else {
        requirements = fallbackRequirementsFromTopic(topic);
    }

    const topicFile: LegalTopicFile = {
        version: 1,
        topicId: topic.id,
        name: topic.name,
        region: topic.region,
        legalArea: topic.legalArea,
        description: topic.description,
        focusChecks: topic.focusChecks,
        generatedAt: nowIso(),
        generatedBy: options?.apiKey ? modelName : 'fallback-no-api-key',
        sources: topic.sources,
        sourceSnapshots: snapshots,
        requirements
    };

    await fs.writeFile(topicFilePath(topic.id), JSON.stringify(topicFile, null, 2), 'utf8');
    return getLegalTopicDetail(topic.id);
};

const injectSoMWithTimeout = async (page: Page): Promise<SoMResult | null> => {
    try {
        return await Promise.race([
            injectSoM(page),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('SoM timeout')), 5000))
        ]) as SoMResult;
    } catch {
        return null;
    }
};

const buildCandidateLabel = (meta?: SoMElementMeta): string => {
    const parts = [meta?.text, meta?.ariaLabel, meta?.title]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0);
    if (parts.length > 0) {
        return parts[0].slice(0, 140);
    }
    const tag = meta?.tag || 'element';
    const role = meta?.role ? ` (${meta.role})` : '';
    return `${tag}${role}`;
};

const scoreSoMCandidate = (label: string, href: string, segmentHint: string, origin: string): number => {
    const haystack = `${label} ${href} ${segmentHint}`.toLowerCase();
    let score = 0;
    for (const keyword of LEGAL_NAV_KEYWORDS) {
        if (haystack.includes(keyword)) score += 2;
    }
    for (const keyword of LEGAL_NAV_NOISE) {
        if (haystack.includes(keyword)) score -= 3;
    }
    if (haystack.includes('menu') || haystack.includes('menü') || haystack.includes('navigation')) score += 1;
    if (href && !href.startsWith(origin)) score -= 2;
    if (href.startsWith('mailto:') || href.startsWith('tel:')) score -= 2;
    if (haystack.includes('cookie') || haystack.includes('consent') || haystack.includes('privacy')) score += 1;
    return score;
};

const collectSnapshotFromPage = async (page: Page, screenshotPath: string): Promise<CollectedPageSnapshot> => {
    const somResult = await injectSoMWithTimeout(page);

    const rawSnapshot = await page.evaluate(() => {
        const elementMeta: SoMPositionMeta[] = [];
        const segmentCounts = new Map<string, number>();
        const interactiveLabels: string[] = [];
        const seenLabels = new Set<string>();

        const computeBand = (y: number): string => {
            const ratio = y / Math.max(1, window.innerHeight);
            if (ratio < 0.16) return 'top';
            if (ratio < 0.38) return 'upper';
            if (ratio < 0.66) return 'middle';
            if (ratio < 0.86) return 'lower';
            return 'bottom';
        };

        const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

        const resolveSegmentHint = (element: HTMLElement, y: number): string => {
            const landmark = element.closest('header,nav,main,aside,section,article,footer,form,[role="dialog"],[role="region"]') as HTMLElement | null;
            const landmarkTag = landmark?.tagName?.toLowerCase() || 'container';
            const landmarkLabel = clean(
                landmark?.getAttribute('aria-label') ||
                landmark?.id ||
                landmark?.getAttribute('data-testid') ||
                landmark?.getAttribute('data-component') ||
                landmarkTag
            ).slice(0, 60);
            return `${computeBand(y)}/${landmarkLabel || landmarkTag}`;
        };

        const textFromElement = (element: HTMLElement): string => {
            const values = [
                element.innerText || element.textContent || '',
                element.getAttribute('aria-label') || '',
                element.getAttribute('title') || '',
                (element as HTMLInputElement).value || ''
            ];
            return values.map(clean).find((value) => value.length > 0) || '';
        };

        const pushElement = (element: HTMLElement, id: number): void => {
            if (!Number.isFinite(id)) return;

            const rect = element.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) return;
            const x = Math.max(4, Math.min(window.innerWidth - 4, Math.round(rect.left + (rect.width / 2))));
            const y = Math.max(4, Math.min(window.innerHeight - 4, Math.round(rect.top + (rect.height / 2))));
            const href = element instanceof HTMLAnchorElement ? (element.href || '') : '';
            const segmentHint = resolveSegmentHint(element, y);
            segmentCounts.set(segmentHint, (segmentCounts.get(segmentHint) || 0) + 1);

            const label = textFromElement(element);
            const normalizedLabel = label.toLowerCase();
            if (label && !seenLabels.has(normalizedLabel)) {
                interactiveLabels.push(label);
                seenLabels.add(normalizedLabel);
            }

            elementMeta.push({
                id,
                x,
                y,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                href,
                segmentHint
            });
        };

        const markedElements = Array.from(document.querySelectorAll<HTMLElement>('[data-som-id]'));
        if (markedElements.length > 0) {
            for (const element of markedElements) {
                const idRaw = element.getAttribute('data-som-id') || '';
                const id = Number(idRaw);
                pushElement(element, id);
            }
        } else {
            const fallbackElements = Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"], input[type="submit"], input[type="button"], summary'));
            let fallbackId = -1;
            for (const element of fallbackElements) {
                const rect = element.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 8) continue;
                const style = window.getComputedStyle(element);
                if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') < 0.05) continue;
                pushElement(element, fallbackId);
                fallbackId -= 1;
                if (Math.abs(fallbackId) > 120) break;
            }
        }

        const segmentHints = Array.from(segmentCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 24)
            .map(([segment, count]) => `${segment} (${count})`);

        const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 26000);

        return {
            url: window.location.href,
            title: document.title || '',
            visibleText,
            interactiveLabels: interactiveLabels.slice(0, 180),
            elementMeta,
            segmentHints
        };
    });

    const metaById = new Map<number, SoMElementMeta>();
    for (const element of somResult?.elements || []) {
        if (typeof element.id !== 'number') continue;
        metaById.set(element.id, element);
    }

    const origin = (() => {
        try {
            return new URL(rawSnapshot.url || page.url()).origin;
        } catch {
            return '';
        }
    })();

    const candidates: ExplorationCandidate[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const item of rawSnapshot.elementMeta as SoMPositionMeta[]) {
        const meta = metaById.get(item.id);
        const label = buildCandidateLabel(meta);
        const href = item.href || meta?.href || '';
        const key = `${item.id}|${label.toLowerCase()}|${href}`;
        if (seenCandidateKeys.has(key)) continue;
        seenCandidateKeys.add(key);
        candidates.push({
            somId: item.id,
            label,
            href,
            x: item.x,
            y: item.y,
            score: scoreSoMCandidate(label, href, item.segmentHint, origin),
            segmentHint: item.segmentHint
        });
    }
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    await fs.writeFile(screenshotPath, screenshotBuffer);

    return {
        url: rawSnapshot.url,
        title: rawSnapshot.title,
        visibleText: rawSnapshot.visibleText,
        interactiveLabels: rawSnapshot.interactiveLabels,
        candidates: candidates.slice(0, 120),
        somCount: somResult?.count || candidates.length,
        segmentHints: (rawSnapshot.segmentHints as string[]).slice(0, 24),
        screenshotBase64: screenshotBuffer.toString('base64'),
        screenshotPath
    };
};

const collectPageSignals = async (
    url: string,
    headlessMode: boolean,
    mode: LegalCheckMode,
    maxExplorationSteps: number,
    onNavigationEvent?: (message: string) => void
): Promise<CollectedPageSignals> => {
    await ensureLegalDirs();

    const checkDirName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFileNamePart(new URL(url).hostname)}`;
    const checkDir = path.join(LEGAL_CHECKS_DIR, checkDirName);
    await fs.mkdir(checkDir, { recursive: true });

    const browser = await chromium.launch({
        headless: headlessMode,
        slowMo: headlessMode ? 0 : 120
    });

    const journey: LegalJourneyStep[] = [];
    const snapshots: CollectedPageSnapshot[] = [];
    const clickedKeys = new Set<string>();

    try {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            locale: 'de-DE'
        });
        let page: Page = await context.newPage();

        const captureStep = async (
            action: string,
            candidate?: ExplorationCandidate
        ): Promise<CollectedPageSnapshot> => {
            const stepNo = snapshots.length + 1;
            const screenshotPath = path.join(checkDir, `step-${String(stepNo).padStart(2, '0')}.png`);
            const snapshot = await collectSnapshotFromPage(page, screenshotPath);
            snapshots.push(snapshot);
            journey.push({
                step: stepNo,
                url: snapshot.url,
                title: snapshot.title,
                action,
                candidateLabel: candidate?.label,
                candidateHref: candidate?.href,
                somCount: snapshot.somCount,
                segmentHint: snapshot.segmentHints.slice(0, 3).join(' | ')
            });
            return snapshot;
        };

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!headlessMode) {
            await page.bringToFront().catch(() => { });
        }
        await page.waitForTimeout(headlessMode ? 1500 : 3000);

        const initialSnapshot = await captureStep('initial-load');
        onNavigationEvent?.(`Captured initial page state with ${initialSnapshot.somCount} SoM marks`);
        if (initialSnapshot.segmentHints.length > 0) {
            onNavigationEvent?.(`Initial segments: ${initialSnapshot.segmentHints.slice(0, 4).join(', ')}`);
        }

        if (mode === 'explorative') {
            const targetSteps = clampExplorationSteps(maxExplorationSteps);
            for (let iteration = 2; iteration <= targetSteps; iteration++) {
                const latest = snapshots[snapshots.length - 1];
                const candidate = latest.candidates.find((item) => {
                    const key = `${item.somId}|${item.label.toLowerCase()}|${item.href}`;
                    if (clickedKeys.has(key)) return false;
                    if (item.score >= 1) return true;
                    return snapshots.length === 1 && item.score >= 0;
                });

                if (!candidate) {
                    onNavigationEvent?.('No suitable next interaction found. Exploration stopped.');
                    break;
                }

                const candidateKey = `${candidate.somId}|${candidate.label.toLowerCase()}|${candidate.href}`;
                clickedKeys.add(candidateKey);
                onNavigationEvent?.(`Exploration step ${iteration - 1}: click SoM#${candidate.somId} "${candidate.label}"`);

                let popup: Page | null = null;
                try {
                    const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
                    const target = page.locator(`[data-som-id="${candidate.somId}"]`).first();
                    await target.click({ timeout: 5000, delay: 80 });
                    popup = await popupPromise;
                } catch {
                    try {
                        const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
                        await page.mouse.click(candidate.x, candidate.y, { delay: 80 });
                        popup = await popupPromise;
                    } catch {
                        // click failure is handled by fallback wait and next capture
                    }
                }

                if (popup) {
                    page = popup;
                    if (!headlessMode) {
                        await page.bringToFront().catch(() => { });
                    }
                }

                await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => { });
                await page.waitForTimeout(headlessMode ? 1000 : 1700);
                const stepSnapshot = await captureStep('click', candidate);
                onNavigationEvent?.(`After click: ${stepSnapshot.somCount} SoM marks on page`);
            }
        }

        await context.close();
    } finally {
        await browser.close();
    }

    if (snapshots.length === 0) {
        throw new Error('No page snapshots could be captured for legal check.');
    }

    const finalSnapshot = snapshots[snapshots.length - 1];
    const aggregateText = snapshots
        .map((snapshot, index) => `[STEP ${index + 1}] URL=${snapshot.url} TITLE=${snapshot.title}\n${snapshot.visibleText}`)
        .join('\n\n')
        .slice(0, 64000);
    const aggregateLabels = Array.from(
        new Set(snapshots.flatMap((snapshot) => snapshot.interactiveLabels.map((label) => label.trim()).filter((label) => label.length > 0)))
    ).slice(0, 180);

    return {
        title: finalSnapshot.title,
        visibleText: aggregateText,
        interactiveLabels: aggregateLabels,
        somCount: snapshots.reduce((max, snapshot) => Math.max(max, snapshot.somCount), 0),
        segmentHints: Array.from(
            new Set(
                snapshots.flatMap((snapshot) => snapshot.segmentHints.slice(0, 8))
            )
        ).slice(0, 24),
        screenshotBase64: finalSnapshot.screenshotBase64,
        screenshotPath: finalSnapshot.screenshotPath,
        screenshotUrl: toDownloadUrl(finalSnapshot.screenshotPath),
        journey
    };
};

const normalizeStatus = (value: unknown): LegalCheckFinding['status'] => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'pass') return 'pass';
    if (normalized === 'fail') return 'fail';
    if (normalized === 'not-applicable' || normalized === 'na' || normalized === 'n/a') return 'not-applicable';
    return 'needs-review';
};

const normalizeConfidence = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0.5;
    return Math.max(0, Math.min(1, parsed));
};

const evaluateComplianceWithGemini = async (
    apiKey: string,
    modelName: string,
    topic: LegalTopicDetail,
    url: string,
    pageSignals: { title: string; visibleText: string; interactiveLabels: string[]; screenshotBase64: string; somCount: number; segmentHints: string[]; },
    personaKey: 'legal_eu' | 'bare'
): Promise<{ summary: string; auditThoughts: string[]; findings: Array<Partial<LegalCheckFinding> & { requirementId?: string; }>; }> => {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const persona = getPersona(personaKey);
    const personaGuidance = personaKey === 'bare'
        ? 'No persona style constraints. Use neutral, concise and evidence-driven compliance reasoning.'
        : (persona.basePrompt || 'Be precise, conservative, and evidence-based.');

    const prompt = `
You are an EU legal compliance website auditor.
Persona style guidance:
${personaGuidance}

Scope:
- Topic: ${topic.name}
- Region: ${topic.region}
- Legal Area: ${topic.legalArea}
- Website URL: ${url}
- Page title: ${pageSignals.title}

Requirements JSON:
${JSON.stringify(topic.requirements, null, 2)}

Visible text excerpt:
${pageSignals.visibleText}

Interactive labels excerpt:
${JSON.stringify(pageSignals.interactiveLabels.slice(0, 80), null, 2)}

SoM signals:
- total marks observed: ${pageSignals.somCount}
- segment summary: ${JSON.stringify(pageSignals.segmentHints.slice(0, 16), null, 2)}

Output STRICT JSON only:
{
  "summary": "high-level compliance summary",
  "auditThoughts": ["short analyst thought", "short analyst thought"],
  "findings": [
    {
      "requirementId": "REQ-001",
      "status": "pass|fail|needs-review|not-applicable",
      "confidence": 0.0,
      "reasoning": "short explanation tied to visible evidence",
      "evidence": ["snippet or observed UI element"],
      "recommendation": "next remediation step"
    }
  ]
}

Rules:
- Evaluate every requirement ID once.
- If evidence is insufficient, use needs-review.
- Do not fabricate UI elements that are not present.
- Keep auditThoughts concise and evidence-based.
`;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: pageSignals.screenshotBase64, mimeType: 'image/png' } }
    ]);

    const parsed = parseModelJson(result.response.text());
    const root = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const summary = typeof root.summary === 'string' ? root.summary.trim() : 'No summary provided.';
    const auditThoughts = Array.isArray(root.auditThoughts)
        ? root.auditThoughts
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter((item) => item.length > 0)
            .slice(0, 12)
        : [];
    const findings = Array.isArray(root.findings) ? root.findings as Array<Partial<LegalCheckFinding> & { requirementId?: string; }> : [];

    return { summary, auditThoughts, findings };
};

const buildFallbackFindings = (topic: LegalTopicDetail): { summary: string; auditThoughts: string[]; findings: Array<Partial<LegalCheckFinding> & { requirementId?: string; }>; } => {
    return {
        summary: 'No LLM API key configured. All requirements are marked as needs-review.',
        auditThoughts: [
            'No API key available, using conservative fallback.',
            'All requirements marked as needs-review until model analysis is enabled.'
        ],
        findings: topic.requirements.map((requirement) => ({
            requirementId: requirement.id,
            status: 'needs-review',
            confidence: 0.5,
            reasoning: 'Automated legal interpretation is unavailable without LLM access.',
            evidence: ['Manual review required.'],
            recommendation: 'Enable Gemini API and rerun for assisted evidence mapping.'
        }))
    };
};

const buildScore = (findings: LegalCheckFinding[]): number => {
    if (findings.length === 0) return 0;
    let sum = 0;
    for (const finding of findings) {
        if (finding.status === 'pass') sum += 1;
        else if (finding.status === 'not-applicable') sum += 0.75;
        else if (finding.status === 'needs-review') sum += 0.5;
        else sum += 0;
    }
    return Math.round((sum / findings.length) * 100);
};

const buildMarkdownReport = (result: LegalCheckResult): string => {
    const lines: string[] = [];
    lines.push(`# DRIVE Legal Compliance Report`);
    lines.push('');
    lines.push(`- Check ID: ${result.checkId}`);
    lines.push(`- Topic: ${result.topicName} (${result.topicId})`);
    lines.push(`- URL: ${result.url}`);
    lines.push(`- Persona: ${result.personaName}`);
    lines.push(`- Mode: ${result.mode} (${result.explorationSteps} planned steps)`);
    lines.push(`- Start: ${result.startedAt}`);
    lines.push(`- End: ${result.endedAt}`);
    lines.push(`- Score: ${result.overallScore}/100`);
    lines.push('');
    lines.push(`## SoM & Segmentation`);
    lines.push(`- Marks: ${result.som.marks}`);
    if (result.som.segments.length > 0) {
        lines.push(`- Segments: ${result.som.segments.slice(0, 20).join(', ')}`);
    }
    lines.push('');
    lines.push(`## Summary`);
    lines.push(result.summary.modelSummary || '-');
    lines.push('');
    lines.push(`## Findings`);
    lines.push('');

    for (const finding of result.findings) {
        lines.push(`### ${finding.requirementId} - ${finding.title}`);
        lines.push(`- Status: ${finding.status}`);
        lines.push(`- Confidence: ${finding.confidence.toFixed(2)}`);
        lines.push(`- Reasoning: ${finding.reasoning}`);
        lines.push(`- Recommendation: ${finding.recommendation}`);
        if (finding.evidence.length > 0) {
            lines.push(`- Evidence:`);
            for (const evidence of finding.evidence) {
                lines.push(`  - ${evidence}`);
            }
        }
        if (finding.sourceRefs.length > 0) {
            lines.push(`- Sources:`);
            for (const source of finding.sourceRefs) {
                lines.push(`  - ${source.title}: ${source.url} (${source.note})`);
            }
        }
        lines.push('');
    }

    if (result.journey.length > 0) {
        lines.push(`## Navigation Journey`);
        lines.push('');
        for (const step of result.journey) {
            const candidate = step.candidateLabel ? ` | target=${step.candidateLabel}` : '';
            lines.push(`- Step ${step.step}: ${step.action}${candidate} | ${step.title} | ${step.url}`);
        }
        lines.push('');
    }

    if (result.thoughts.length > 0) {
        lines.push(`## Thought Timeline`);
        lines.push('');
        for (const thought of result.thoughts) {
            lines.push(`- [${thought.timestamp}] (${thought.phase}) ${thought.message}`);
        }
        lines.push('');
    }

    return lines.join('\n');
};

export const runLegalComplianceCheck = async (options: RunLegalCheckOptions): Promise<LegalCheckResult> => {
    await ensureLegalDirs();
    const url = normalizeUrl(options.url);
    const runHeadless = options.headlessMode !== false;
    const runMode = resolveLegalMode(options.mode);
    const maxExplorationSteps = clampExplorationSteps(options.maxExplorationSteps);
    const personaKey = resolveLegalPersonaKey(options.personaName);
    const thoughts: LegalThoughtEntry[] = [];
    const pushThought = (phase: LegalThoughtEntry['phase'], message: string) => {
        const entry: LegalThoughtEntry = {
            timestamp: nowIso(),
            phase,
            message
        };
        thoughts.push(entry);
        if (options.onThought) {
            options.onThought(entry);
        }
    };

    pushThought('setup', `Preparing legal check for ${url}`);
    const existingTopic = await getLegalTopicDetail(options.topicId);
    let topic = existingTopic;
    if (topic.requirements.length === 0) {
        pushThought('setup', `No cached requirements for ${options.topicId}, syncing legal sources first`);
        try {
            topic = await syncLegalTopicFromWeb(options.topicId, {
                apiKey: options.apiKey,
                modelName: options.modelName
            });
        } catch (error) {
            const topicDefinition = getLegalTopicDefinition(options.topicId);
            if (!topicDefinition) {
                throw error;
            }
            const fallbackRequirements = fallbackRequirementsFromTopic(topicDefinition);
            topic = {
                id: topicDefinition.id,
                name: topicDefinition.name,
                region: topicDefinition.region,
                legalArea: topicDefinition.legalArea,
                description: topicDefinition.description,
                focusChecks: topicDefinition.focusChecks,
                sources: topicDefinition.sources,
                requirements: fallbackRequirements,
                requirementsFileUrl: undefined,
                lastSyncedAt: null,
                generatedBy: 'fallback-sync-failed'
            };
            const reason = error instanceof Error ? error.message : String(error);
            pushThought('setup', `Topic sync failed, continuing with fallback requirements (${reason})`);
        }
    }
    pushThought('setup', `Loaded topic ${topic.name} with ${topic.requirements.length} requirements`);

    const modelName = (options.modelName || DEFAULT_LEGAL_MODEL).trim() || DEFAULT_LEGAL_MODEL;
    const personaName = getPersona(personaKey).name;
    pushThought('setup', `Browser mode: ${runHeadless ? 'HEADLESS' : 'VISIBLE'}`);
    pushThought('setup', `Mode: ${runMode.toUpperCase()} (${maxExplorationSteps} max steps)`);
    pushThought('setup', `Persona: ${personaName} | Model: ${modelName}`);

    const startedAt = nowIso();
    pushThought('navigation', 'Opening target website and collecting visual/legal signals');
    const pageSignals = await collectPageSignals(
        url,
        runHeadless,
        runMode,
        maxExplorationSteps,
        (message) => pushThought('navigation', message)
    );
    pushThought('navigation', `Captured ${pageSignals.journey.length} navigation step(s)`);
    pushThought('navigation', `SoM marks observed: ${pageSignals.somCount}`);
    if (pageSignals.segmentHints.length > 0) {
        pushThought('navigation', `Segments: ${pageSignals.segmentHints.slice(0, 5).join(', ')}`);
    }
    pushThought('navigation', `Captured page title: ${pageSignals.title || '(no title)'}`);

    const evaluation = options.apiKey && options.apiKey.trim()
        ? await evaluateComplianceWithGemini(options.apiKey, modelName, topic, url, pageSignals, personaKey)
        : buildFallbackFindings(topic);
    pushThought('analysis', evaluation.summary);
    for (const modelThought of evaluation.auditThoughts) {
        pushThought('analysis', modelThought);
    }

    const findingsById = new Map<string, Partial<LegalCheckFinding> & { requirementId?: string; }>();
    for (const finding of evaluation.findings) {
        if (!finding || typeof finding !== 'object') continue;
        const requirementId = typeof finding.requirementId === 'string' ? finding.requirementId.trim() : '';
        if (!requirementId) continue;
        findingsById.set(requirementId, finding);
    }

    const findings: LegalCheckFinding[] = topic.requirements.map((requirement) => {
        const raw = findingsById.get(requirement.id);
        const evidenceRaw = raw && Array.isArray(raw.evidence) ? raw.evidence : [];
        const evidence = evidenceRaw
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter((item) => item.length > 0)
            .slice(0, 6);

        return {
            requirementId: requirement.id,
            title: requirement.title,
            status: normalizeStatus(raw?.status),
            confidence: normalizeConfidence(raw?.confidence),
            reasoning: typeof raw?.reasoning === 'string' && raw.reasoning.trim()
                ? raw.reasoning.trim()
                : 'No explicit reasoning returned by model.',
            evidence: evidence.length > 0 ? evidence : ['No direct evidence captured.'],
            recommendation: typeof raw?.recommendation === 'string' && raw.recommendation.trim()
                ? raw.recommendation.trim()
                : 'Add explicit user-facing implementation and verify with legal review.',
            sourceRefs: requirement.sourceRefs
        };
    });

    const pass = findings.filter((finding) => finding.status === 'pass').length;
    const fail = findings.filter((finding) => finding.status === 'fail').length;
    const needsReview = findings.filter((finding) => finding.status === 'needs-review').length;
    const notApplicable = findings.filter((finding) => finding.status === 'not-applicable').length;
    pushThought('scoring', `Findings classified: pass=${pass}, fail=${fail}, needs-review=${needsReview}, not-applicable=${notApplicable}`);

    const checkId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFileNamePart(topic.id)}-${sanitizeFileNamePart(new URL(url).hostname)}`;
    const checkDir = path.join(LEGAL_CHECKS_DIR, checkId);
    await fs.mkdir(checkDir, { recursive: true });
    pushThought('report', `Writing result artifacts under ${checkId}`);

    const screenshotPath = path.join(checkDir, 'page.png');
    await fs.copyFile(pageSignals.screenshotPath, screenshotPath);

    const endedAt = nowIso();

    const result: LegalCheckResult = {
        checkId,
        topicId: topic.id,
        topicName: topic.name,
        url,
        personaName,
        mode: runMode,
        explorationSteps: maxExplorationSteps,
        startedAt,
        endedAt,
        overallScore: buildScore(findings),
        summary: {
            pass,
            fail,
            needsReview,
            notApplicable,
            total: findings.length,
            modelSummary: evaluation.summary
        },
        findings,
        thoughts,
        journey: pageSignals.journey,
        som: {
            marks: pageSignals.somCount,
            segments: pageSignals.segmentHints
        },
        artifacts: {
            resultJsonPath: path.join(checkDir, 'result.json'),
            resultJsonUrl: toDownloadUrl(path.join(checkDir, 'result.json')),
            reportMdPath: path.join(checkDir, 'report.md'),
            reportMdUrl: toDownloadUrl(path.join(checkDir, 'report.md')),
            screenshotPath,
            screenshotUrl: toDownloadUrl(screenshotPath)
        }
    };

    await fs.writeFile(result.artifacts.resultJsonPath, JSON.stringify(result, null, 2), 'utf8');
    await fs.writeFile(result.artifacts.reportMdPath, buildMarkdownReport(result), 'utf8');

    const legacyScreenshotPath = pageSignals.screenshotPath;
    if (legacyScreenshotPath !== screenshotPath) {
        await fs.unlink(legacyScreenshotPath).catch(() => { });
    }

    return result;
};

export const computeLegalTopicDigest = async (): Promise<string> => {
    const summaries = await listLegalTopics();
    const hash = crypto.createHash('sha256').update(JSON.stringify(summaries)).digest('hex');
    return hash;
};
