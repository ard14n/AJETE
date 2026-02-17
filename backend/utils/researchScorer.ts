import { SiteProfile } from '../config/siteProfiles';
import { SoMElementMeta } from './som';

export interface ResearchCandidate {
    rank: number;
    title: string;
    score: number;
    price?: number;
    rating?: number;
    reviewCount?: number;
    signals: string[];
    somIds: number[];
    evidence: string[];
}

export interface ResearchReport {
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
    topCandidates: ResearchCandidate[];
}

interface CandidateAccumulator {
    key: string;
    title: string;
    somIds: Set<number>;
    evidence: Set<string>;
    mentionCount: number;
    prices: number[];
    ratings: number[];
    reviewCounts: number[];
    objectiveHits: number;
    profileHits: number;
}

const STOP_TITLES = new Set([
    'menu', 'menue', 'shop', 'suche', 'search', 'filter', 'sortieren', 'sort',
    'warenkorb', 'cart', 'buy now', 'jetzt kaufen', 'checkout', 'continue',
    'weiter', 'mehr', 'details', 'home', 'konto', 'account'
]);

const PRICE_PATTERNS = [
    /(?:€|\$|£)\s*([0-9][0-9.,\s]{0,18})/i,
    /([0-9][0-9.,\s]{0,18})\s*(?:€|eur|usd|gbp)/i
];

const RATING_PATTERNS = [
    /([0-5](?:[.,][0-9])?)\s*(?:\/\s*5|von\s*5|out of 5|stars?|sterne)/i,
    /([0-5](?:[.,][0-9])?)\s*[★⭐]/i
];

const REVIEW_COUNT_PATTERNS = [
    /([0-9][0-9.,\s]{0,12})\s*(?:bewertungen|reviews?|ratings?)/i
];

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const tokenize = (value: string): string[] =>
    value
        .toLowerCase()
        .split(/[^a-z0-9äöüß]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);

const parseLocaleNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/\s/g, '');
    if (!cleaned) return null;

    const hasComma = cleaned.includes(',');
    const hasDot = cleaned.includes('.');
    let normalized = cleaned;

    if (hasComma && hasDot) {
        // "1.299,99" -> "1299.99"
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
        const lastComma = cleaned.lastIndexOf(',');
        const decimalDigits = cleaned.length - lastComma - 1;
        normalized = decimalDigits === 2
            ? cleaned.replace(/\./g, '').replace(',', '.')
            : cleaned.replace(/,/g, '');
    } else if (hasDot) {
        const lastDot = cleaned.lastIndexOf('.');
        const decimalDigits = cleaned.length - lastDot - 1;
        normalized = decimalDigits === 2
            ? cleaned.replace(/,/g, '')
            : cleaned.replace(/\./g, '');
    }

    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
};

const extractPrice = (text: string): number | null => {
    for (const pattern of PRICE_PATTERNS) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const parsed = parseLocaleNumber(match[1]);
        if (parsed !== null && parsed > 0) return parsed;
    }
    return null;
};

const extractRating = (text: string): number | null => {
    for (const pattern of RATING_PATTERNS) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const normalized = match[1].replace(',', '.');
        const rating = Number(normalized);
        if (Number.isFinite(rating) && rating >= 0 && rating <= 5) return rating;
    }
    return null;
};

const extractReviewCount = (text: string): number | null => {
    for (const pattern of REVIEW_COUNT_PATTERNS) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const parsed = parseLocaleNumber(match[1]);
        if (parsed !== null && parsed >= 0) return Math.round(parsed);
    }
    return null;
};

const inferTitle = (raw: string): string => {
    let title = normalizeWhitespace(raw);
    title = title.replace(/(?:€|\$|£)\s*[0-9][0-9.,\s]{0,18}/gi, '');
    title = title.replace(/[0-9][0-9.,\s]{0,18}\s*(?:€|eur|usd|gbp)/gi, '');
    title = title.replace(/[0-5](?:[.,][0-9])?\s*(?:\/\s*5|von\s*5|out of 5|stars?|sterne)/gi, '');
    title = title.replace(/[0-9][0-9.,\s]{0,12}\s*(?:bewertungen|reviews?|ratings?)/gi, '');
    title = title.replace(/\b(?:add to cart|in den einkaufswagen|buy now|jetzt kaufen|zur kasse|checkout)\b/gi, '');
    title = title.replace(/[|•·]/g, ' ');
    title = normalizeWhitespace(title);
    if (title.length > 120) {
        title = normalizeWhitespace(title.slice(0, 120));
    }
    return title;
};

const titleKey = (title: string): string => {
    const words = tokenize(title);
    return words.slice(0, 8).join(' ');
};

const collectObjectiveKeywords = (objective: string): string[] => {
    return Array.from(
        new Set(
            tokenize(objective)
                .filter((token) => token.length >= 3)
                .slice(0, 16)
        )
    );
};

const containsSignals = (text: string, signals: string[]): number => {
    if (!text) return 0;
    const normalized = text.toLowerCase();
    let hitCount = 0;
    for (const signal of signals) {
        if (normalized.includes(signal.toLowerCase())) {
            hitCount += 1;
        }
    }
    return hitCount;
};

const createAccumulator = (key: string, title: string): CandidateAccumulator => ({
    key,
    title,
    somIds: new Set<number>(),
    evidence: new Set<string>(),
    mentionCount: 0,
    prices: [],
    ratings: [],
    reviewCounts: [],
    objectiveHits: 0,
    profileHits: 0
});

const scoreAccumulator = (item: CandidateAccumulator, objectiveKeywords: string[]): number => {
    let score = 20;
    if (item.prices.length > 0) score += 24;
    if (item.ratings.length > 0) score += 18;
    if (item.reviewCounts.length > 0) score += 12;
    score += Math.min(12, item.mentionCount * 2);

    if (objectiveKeywords.length > 0) {
        const coverage = item.objectiveHits / objectiveKeywords.length;
        score += Math.min(18, Math.round(coverage * 18));
    }

    score += Math.min(10, item.profileHits * 2);

    const tokenCount = tokenize(item.title).length;
    if (tokenCount >= 3) score += 6;
    if (tokenCount <= 1) score -= 8;
    if (item.title.length < 6) score -= 10;

    return Math.max(0, Math.min(100, score));
};

export const buildResearchReport = (params: {
    url: string;
    objective?: string;
    siteProfile: SiteProfile;
    somElements: SoMElementMeta[];
    pageSnippets?: string[];
    maxCandidates?: number;
}): ResearchReport | null => {
    const objective = String(params.objective || '').trim();
    const objectiveKeywords = collectObjectiveKeywords(objective);
    const profileSignals = params.siteProfile.researchSignals || [];
    const sources: { text: string; somId?: number }[] = [];

    for (const meta of params.somElements || []) {
        const labels = [meta.text, meta.ariaLabel, meta.title, meta.href]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => normalizeWhitespace(value));
        for (const label of labels) {
            sources.push({ text: label, somId: meta.id });
        }
    }

    for (const snippet of params.pageSnippets || []) {
        const normalized = normalizeWhitespace(String(snippet || ''));
        if (!normalized) continue;
        sources.push({ text: normalized });
    }

    if (sources.length === 0) return null;

    const accumulators = new Map<string, CandidateAccumulator>();

    for (const source of sources) {
        const normalizedText = normalizeWhitespace(source.text);
        if (normalizedText.length < 6) continue;

        const title = inferTitle(normalizedText);
        if (!title) continue;
        const loweredTitle = title.toLowerCase();
        if (STOP_TITLES.has(loweredTitle)) continue;

        const key = titleKey(title);
        if (!key || STOP_TITLES.has(key)) continue;

        const tokenizedTitle = tokenize(title);
        if (tokenizedTitle.length === 0) continue;

        const item = accumulators.get(key) || createAccumulator(key, title);
        item.mentionCount += 1;
        item.evidence.add(normalizedText.slice(0, 220));
        if (source.somId !== undefined) item.somIds.add(source.somId);

        const price = extractPrice(normalizedText);
        if (price !== null) item.prices.push(price);
        const rating = extractRating(normalizedText);
        if (rating !== null) item.ratings.push(rating);
        const reviewCount = extractReviewCount(normalizedText);
        if (reviewCount !== null) item.reviewCounts.push(reviewCount);

        if (objectiveKeywords.length > 0) {
            const objectiveHits = containsSignals(normalizedText, objectiveKeywords);
            item.objectiveHits += objectiveHits;
        }

        const profileHits = containsSignals(normalizedText, profileSignals);
        item.profileHits += profileHits;
        accumulators.set(key, item);
    }

    const ranked = Array.from(accumulators.values())
        .map((item) => {
            const score = scoreAccumulator(item, objectiveKeywords);
            const minPrice = item.prices.length > 0 ? Math.min(...item.prices) : undefined;
            const bestRating = item.ratings.length > 0 ? Math.max(...item.ratings) : undefined;
            const maxReviews = item.reviewCounts.length > 0 ? Math.max(...item.reviewCounts) : undefined;
            const signals: string[] = [];
            if (minPrice !== undefined) signals.push('price');
            if (bestRating !== undefined) signals.push('rating');
            if (maxReviews !== undefined) signals.push('reviews');
            if (item.objectiveHits > 0) signals.push('objective-match');
            if (item.profileHits > 0) signals.push('profile-signal');

            return {
                item,
                candidate: {
                    rank: 0,
                    title: item.title,
                    score,
                    price: minPrice,
                    rating: bestRating,
                    reviewCount: maxReviews,
                    signals,
                    somIds: Array.from(item.somIds).sort((a, b) => a - b),
                    evidence: Array.from(item.evidence).slice(0, 4)
                } as ResearchCandidate
            };
        })
        .filter(({ candidate }) => candidate.score >= 24)
        .sort((a, b) => {
            if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
            return b.item.mentionCount - a.item.mentionCount;
        });

    if (ranked.length === 0) return null;

    const maxCandidates = Math.max(1, Math.min(10, params.maxCandidates || 6));
    const topCandidates = ranked.slice(0, maxCandidates).map(({ candidate }, index) => ({
        ...candidate,
        rank: index + 1
    }));

    const metrics = {
        candidateCount: ranked.length,
        withPrice: ranked.filter(({ candidate }) => candidate.price !== undefined).length,
        withRating: ranked.filter(({ candidate }) => candidate.rating !== undefined).length,
        withReviewCount: ranked.filter(({ candidate }) => candidate.reviewCount !== undefined).length,
        averageScore: Math.round(topCandidates.reduce((acc, item) => acc + item.score, 0) / topCandidates.length)
    };

    return {
        generatedAt: new Date().toISOString(),
        url: params.url,
        objective,
        siteProfileId: params.siteProfile.id,
        siteProfileLabel: params.siteProfile.label,
        metrics,
        topCandidates
    };
};

