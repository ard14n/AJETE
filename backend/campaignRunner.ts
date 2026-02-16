import { promises as fs } from 'fs';
import { DriveAgent } from './agent';
import { PersonaConfig } from './config/personas';

export interface CampaignSiteInput {
    name?: string;
    url: string;
    objective?: string;
}

export interface CampaignSiteMetrics {
    goalReached: boolean;
    durationMs: number;
    totalSteps: number;
    clickCount: number;
    typeCount: number;
    scrollCount: number;
    waitCount: number;
    uniquePages: number;
    uniqueTargets: number;
    repeatedActionCount: number;
    backtrackCount: number;
    failedTargetCount: number;
    deadEndRate: number;
    frustrationSignals: number;
    positiveSignals: number;
    imageSurfaceScore: number;
    avgScreenshotWidth: number;
    avgScreenshotHeight: number;
    avgScreenshotBytes: number;
    journeyScore: number;
}

export interface CampaignSiteArtifacts {
    reportJsonUrl?: string;
    reportCsvUrl?: string;
    reportPdfUrl?: string;
    traceJsonUrl?: string;
    traceSpecUrl?: string;
}

export interface CampaignSiteResult {
    siteName: string;
    siteUrl: string;
    status: 'completed' | 'failed' | 'timeout';
    startedAt: string;
    endedAt: string;
    durationMs: number;
    objective: string;
    metrics?: CampaignSiteMetrics;
    artifacts?: CampaignSiteArtifacts;
    error?: string;
}

export interface CampaignComparison {
    fastestSite?: string;
    mostEfficientSite?: string;
    bestJourneySite?: string;
    bestVisualSite?: string;
    highestFrictionSite?: string;
    highlights: string[];
}

export interface CampaignResult {
    campaignId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    persona: string;
    modelName: string;
    objective: string;
    sites: CampaignSiteResult[];
    comparison: CampaignComparison;
}

export interface CampaignExecutionOptions {
    persona: PersonaConfig;
    monkeyMode: boolean;
    bareLlmMode: boolean;
    objective: string;
    debugMode: boolean;
    modelName: string;
    ttsEnabled: boolean;
    headlessMode: boolean;
    saveTrace: boolean;
    saveThoughts: boolean;
    saveScreenshots: boolean;
    timeoutMsPerSite?: number;
}

type ReportReadyPayload = {
    runId?: string;
    jsonPath?: string;
    csvPath?: string;
    pdfPath?: string;
    jsonUrl?: string;
    csvUrl?: string;
    pdfUrl?: string;
};

type TraceSavedPayload = {
    jsonPath?: string;
    specPath?: string;
    jsonUrl?: string;
    specUrl?: string;
};

type ReportStep = {
    id?: number;
    action?: string;
    targetId?: string;
    thought?: string;
    url?: string;
};

type ReportThought = {
    message?: string;
};

type ReportScreenshot = {
    filePath?: string;
};

type ReportSummary = {
    durationMs?: number;
    totalSteps?: number;
    uniqueTargets?: number;
    failedTargetCount?: number;
    actionBreakdown?: Record<string, number>;
};

type ReportFile = {
    summary?: ReportSummary;
    steps?: ReportStep[];
    thoughts?: ReportThought[];
    screenshots?: ReportScreenshot[];
};

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

const clamp = (value: number, min: number, max: number) => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
};

const slugify = (value: string) =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

const waitForAgentStop = async (agent: DriveAgent, timeoutMs: number): Promise<void> => {
    if (!agent.isRunning) return;

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Agent run exceeded timeout (${timeoutMs}ms)`));
        }, timeoutMs);

        const onStatus = (status: string) => {
            if (status === 'stopped' || !agent.isRunning) {
                cleanup();
                resolve();
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            agent.off('status', onStatus);
        };

        agent.on('status', onStatus);
    });
};

const readReportJson = async (jsonPath?: string): Promise<ReportFile | null> => {
    if (!jsonPath) return null;
    try {
        const raw = await fs.readFile(jsonPath, 'utf8');
        return JSON.parse(raw) as ReportFile;
    } catch {
        return null;
    }
};

const parsePngDimensions = async (filePath: string): Promise<{ width: number; height: number } | null> => {
    try {
        const png = await fs.readFile(filePath);
        if (png.length < 24) return null;

        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        const isPng = signature.every((v, i) => png[i] === v);
        if (!isPng) return null;

        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }

        return { width, height };
    } catch {
        return null;
    }
};

const computeImageSurfaceMetrics = async (screenshots: ReportScreenshot[]) => {
    const sample = screenshots.slice(0, 6);
    if (sample.length === 0) {
        return {
            avgScreenshotWidth: 0,
            avgScreenshotHeight: 0,
            avgScreenshotBytes: 0,
            imageSurfaceScore: 0
        };
    }

    let totalWidth = 0;
    let totalHeight = 0;
    let totalBytes = 0;
    let counted = 0;

    for (const shot of sample) {
        if (!shot.filePath) continue;

        const [dims, stat] = await Promise.all([
            parsePngDimensions(shot.filePath),
            fs.stat(shot.filePath).catch(() => null)
        ]);

        if (!dims) continue;

        totalWidth += dims.width;
        totalHeight += dims.height;
        totalBytes += stat?.size || 0;
        counted += 1;
    }

    if (counted === 0) {
        return {
            avgScreenshotWidth: 0,
            avgScreenshotHeight: 0,
            avgScreenshotBytes: 0,
            imageSurfaceScore: 0
        };
    }

    const avgScreenshotWidth = Math.round(totalWidth / counted);
    const avgScreenshotHeight = Math.round(totalHeight / counted);
    const avgScreenshotBytes = Math.round(totalBytes / counted);

    const pixelRatio = (avgScreenshotWidth * avgScreenshotHeight) / (1920 * 1080);
    const byteRatio = avgScreenshotBytes / 450000;
    const imageSurfaceScore = Math.round(clamp(pixelRatio * 70 + byteRatio * 30, 0, 100));

    return {
        avgScreenshotWidth,
        avgScreenshotHeight,
        avgScreenshotBytes,
        imageSurfaceScore
    };
};

const countKeywordHits = (messages: string[], regex: RegExp) => {
    let count = 0;
    for (const message of messages) {
        if (regex.test(message)) count += 1;
    }
    return count;
};

const computeCampaignMetrics = async (report: ReportFile): Promise<CampaignSiteMetrics> => {
    const summary = report.summary || {};
    const steps = Array.isArray(report.steps) ? report.steps : [];
    const thoughts = Array.isArray(report.thoughts) ? report.thoughts : [];
    const screenshots = Array.isArray(report.screenshots) ? report.screenshots : [];

    const actionBreakdown = summary.actionBreakdown || {};
    const clickCount = Number(actionBreakdown.click || 0);
    const typeCount = Number(actionBreakdown.type || 0);
    const scrollCount = Number(actionBreakdown.scroll || 0);
    const waitCount = Number(actionBreakdown.wait || 0);

    const totalSteps = Number(summary.totalSteps || steps.length || 0);
    const failedTargetCount = Number(summary.failedTargetCount || 0);
    const uniqueTargets = Number(summary.uniqueTargets || 0);
    const durationMs = Number(summary.durationMs || 0);

    const normalizedUrls = steps
        .map((step) => (typeof step.url === 'string' ? step.url.trim() : ''))
        .filter((url) => url.length > 0);

    const uniquePages = new Set(normalizedUrls).size;

    let repeatedActionCount = 0;
    const seenActions = new Map<string, number>();
    for (const step of steps) {
        const action = typeof step.action === 'string' ? step.action : '';
        const targetId = typeof step.targetId === 'string' ? step.targetId : '';
        const page = typeof step.url === 'string' ? step.url : '';
        const key = `${action}::${targetId}::${page}`;
        const current = seenActions.get(key) || 0;
        if (current > 0) repeatedActionCount += 1;
        seenActions.set(key, current + 1);
    }

    let backtrackCount = 0;
    for (let i = 2; i < normalizedUrls.length; i++) {
        if (normalizedUrls[i] === normalizedUrls[i - 2] && normalizedUrls[i] !== normalizedUrls[i - 1]) {
            backtrackCount += 1;
        }
    }

    const thoughtMessages = thoughts
        .map((thought) => (typeof thought.message === 'string' ? thought.message : ''))
        .filter((message) => message.length > 0)
        .concat(
            steps
                .map((step) => (typeof step.thought === 'string' ? step.thought : ''))
                .filter((message) => message.length > 0)
        );

    const frustrationSignals = countKeywordHits(
        thoughtMessages,
        /(frust|nerv|mist|doof|krampf|verzweifel|schlecht|confus|stuck|problem|fail|error)/i
    );
    const positiveSignals = countKeywordHits(
        thoughtMessages,
        /(gut|super|prima|gefunden|erfolgreich|perfekt|klar|einfach|cool|done)/i
    );

    const deadEndRate = totalSteps > 0 ? failedTargetCount / totalSteps : 0;
    const goalReached = (steps[steps.length - 1]?.action || '').toLowerCase() === 'done';

    const imageMetrics = await computeImageSurfaceMetrics(screenshots);

    const completionScore = goalReached ? 35 : 10;
    const efficiencyScore = clamp(35 - totalSteps * 0.7 - repeatedActionCount * 1.8 - backtrackCount * 2.4, 0, 35);
    const frictionScore = clamp(20 - frustrationSignals * 1.8 - deadEndRate * 30, 0, 20);
    const visualScore = clamp(imageMetrics.imageSurfaceScore / 10, 0, 10);
    const positiveBonus = clamp(positiveSignals * 0.4, 0, 5);
    const journeyScore = Math.round(clamp(completionScore + efficiencyScore + frictionScore + visualScore + positiveBonus, 0, 100));

    return {
        goalReached,
        durationMs,
        totalSteps,
        clickCount,
        typeCount,
        scrollCount,
        waitCount,
        uniquePages,
        uniqueTargets,
        repeatedActionCount,
        backtrackCount,
        failedTargetCount,
        deadEndRate,
        frustrationSignals,
        positiveSignals,
        imageSurfaceScore: imageMetrics.imageSurfaceScore,
        avgScreenshotWidth: imageMetrics.avgScreenshotWidth,
        avgScreenshotHeight: imageMetrics.avgScreenshotHeight,
        avgScreenshotBytes: imageMetrics.avgScreenshotBytes,
        journeyScore
    };
};

const buildComparison = (sites: CampaignSiteResult[]): CampaignComparison => {
    const completed = sites.filter((site) => site.status === 'completed' && site.metrics);

    if (completed.length === 0) {
        return {
            highlights: ['No completed site runs. Please review errors and retry.']
        };
    }

    const fastest = [...completed].sort((a, b) => (a.metrics!.durationMs - b.metrics!.durationMs))[0];
    const efficient = [...completed].sort((a, b) => (a.metrics!.totalSteps - b.metrics!.totalSteps))[0];
    const bestJourney = [...completed].sort((a, b) => (b.metrics!.journeyScore - a.metrics!.journeyScore))[0];
    const visual = [...completed].sort((a, b) => (b.metrics!.imageSurfaceScore - a.metrics!.imageSurfaceScore))[0];
    const friction = [...completed].sort((a, b) => (b.metrics!.frustrationSignals - a.metrics!.frustrationSignals))[0];

    const highlights = [
        `Fastest journey: ${fastest.siteName} (${(fastest.metrics!.durationMs / 1000).toFixed(1)}s).`,
        `Fewest interaction steps: ${efficient.siteName} (${efficient.metrics!.totalSteps} steps).`,
        `Best overall journey score: ${bestJourney.siteName} (${bestJourney.metrics!.journeyScore}/100).`,
        `Strongest visual surface score: ${visual.siteName} (${visual.metrics!.imageSurfaceScore}/100).`
    ];

    if (friction.metrics!.frustrationSignals > 0) {
        highlights.push(`Highest friction signals: ${friction.siteName} (${friction.metrics!.frustrationSignals} frustration markers).`);
    }

    const highDeadEnd = completed
        .filter((site) => site.metrics!.deadEndRate >= 0.15)
        .sort((a, b) => b.metrics!.deadEndRate - a.metrics!.deadEndRate)[0];

    if (highDeadEnd) {
        highlights.push(
            `Dead-end risk on ${highDeadEnd.siteName}: ${(highDeadEnd.metrics!.deadEndRate * 100).toFixed(1)}% of steps hit failed targets.`
        );
    }

    return {
        fastestSite: fastest.siteName,
        mostEfficientSite: efficient.siteName,
        bestJourneySite: bestJourney.siteName,
        bestVisualSite: visual.siteName,
        highestFrictionSite: friction.siteName,
        highlights
    };
};

const fallbackSiteName = (url: string, index: number): string => {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '') || `site-${index + 1}`;
    } catch {
        return `site-${index + 1}`;
    }
};

export const runCampaign = async (
    agent: DriveAgent,
    inputSites: CampaignSiteInput[],
    options: CampaignExecutionOptions
): Promise<CampaignResult> => {
    const timeoutMs = Number(options.timeoutMsPerSite) > 0 ? Number(options.timeoutMsPerSite) : DEFAULT_TIMEOUT_MS;
    const campaignStart = new Date();
    const campaignId = `${campaignStart.toISOString().replace(/[:.]/g, '-')}-${slugify(options.persona.name || 'campaign')}`;

    const siteResults: CampaignSiteResult[] = [];

    for (let i = 0; i < inputSites.length; i++) {
        const site = inputSites[i];
        const siteName = (site.name || '').trim() || fallbackSiteName(site.url, i);
        const objective = (site.objective || options.objective || '').trim();
        const startedAt = new Date().toISOString();

        let reportPayload: ReportReadyPayload | null = null;
        let tracePayload: TraceSavedPayload | null = null;

        const onReportReady = (payload: ReportReadyPayload) => {
            reportPayload = payload;
        };
        const onTraceSaved = (payload: TraceSavedPayload) => {
            tracePayload = payload;
        };

        agent.on('report_ready', onReportReady);
        agent.on('trace_saved', onTraceSaved);

        try {
            if (agent.isRunning) {
                await agent.stop();
            }

            agent.emit('thought', `\n=== CAMPAIGN ${i + 1}/${inputSites.length}: ${siteName} ===`);
            await agent.start(site.url, options.persona, objective, {
                monkeyMode: options.monkeyMode,
                bareLlmMode: options.bareLlmMode,
                debugMode: options.debugMode,
                modelName: options.modelName,
                ttsEnabled: options.ttsEnabled,
                headlessMode: options.headlessMode,
                saveTrace: options.saveTrace,
                saveThoughts: options.saveThoughts,
                saveScreenshots: options.saveScreenshots
            });

            await waitForAgentStop(agent, timeoutMs);

            const endedAt = new Date().toISOString();
            const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

            const reportPayloadValue = reportPayload as ReportReadyPayload | null;
            const tracePayloadValue = tracePayload as TraceSavedPayload | null;
            const reportData = await readReportJson(reportPayloadValue ? reportPayloadValue.jsonPath : undefined);
            const metrics = reportData ? await computeCampaignMetrics(reportData) : undefined;

            siteResults.push({
                siteName,
                siteUrl: site.url,
                status: 'completed',
                startedAt,
                endedAt,
                durationMs,
                objective,
                metrics,
                artifacts: {
                    reportJsonUrl: reportPayloadValue ? reportPayloadValue.jsonUrl : undefined,
                    reportCsvUrl: reportPayloadValue ? reportPayloadValue.csvUrl : undefined,
                    reportPdfUrl: reportPayloadValue ? reportPayloadValue.pdfUrl : undefined,
                    traceJsonUrl: tracePayloadValue ? tracePayloadValue.jsonUrl : undefined,
                    traceSpecUrl: tracePayloadValue ? tracePayloadValue.specUrl : undefined
                }
            });
        } catch (error) {
            const endedAt = new Date().toISOString();
            const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
            const message = error instanceof Error ? error.message : 'Campaign run failed';
            const isTimeout = /timeout/i.test(message);

            if (agent.isRunning) {
                await agent.stop().catch(() => { });
            }

            siteResults.push({
                siteName,
                siteUrl: site.url,
                status: isTimeout ? 'timeout' : 'failed',
                startedAt,
                endedAt,
                durationMs,
                objective,
                error: message
            });
        } finally {
            agent.off('report_ready', onReportReady);
            agent.off('trace_saved', onTraceSaved);
        }
    }

    const endedAt = new Date();
    return {
        campaignId,
        startedAt: campaignStart.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - campaignStart.getTime()),
        persona: options.persona.name,
        modelName: options.modelName,
        objective: options.objective,
        sites: siteResults,
        comparison: buildComparison(siteResults)
    };
};
