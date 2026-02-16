'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpenText, RefreshCw, ShieldCheck, Scale, Globe, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface ModelOption {
  id: string;
  name: string;
}

type LegalPersonaKey = 'legal_eu' | 'bare';
type LegalCheckMode = 'snapshot' | 'explorative';

interface LegalTopicSummary {
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

interface LegalSource {
  id: string;
  title: string;
  url: string;
  authority: string;
  note?: string;
}

interface LegalRequirement {
  id: string;
  title: string;
  plainLanguage: string;
  practicalExpectation: string;
  whyImportant: string;
  evidenceHints: string[];
  sourceRefs: Array<{
    url: string;
    title: string;
    note: string;
  }>;
}

interface LegalTopicDetail {
  id: string;
  name: string;
  region: string;
  legalArea: string;
  description: string;
  focusChecks: string[];
  sources: LegalSource[];
  requirements: LegalRequirement[];
  requirementsFileUrl?: string;
  lastSyncedAt: string | null;
  generatedBy: string | null;
}

interface LegalCheckFinding {
  requirementId: string;
  title: string;
  status: 'pass' | 'fail' | 'needs-review' | 'not-applicable';
  confidence: number;
  reasoning: string;
  evidence: string[];
  recommendation: string;
  sourceRefs: Array<{
    url: string;
    title: string;
    note: string;
  }>;
}

interface LegalThoughtEntry {
  timestamp: string;
  phase: 'setup' | 'navigation' | 'analysis' | 'scoring' | 'report';
  message: string;
}

interface LegalCheckResult {
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
  journey: Array<{
    step: number;
    url: string;
    title: string;
    action: string;
    candidateLabel?: string;
    candidateHref?: string;
    somCount?: number;
    segmentHint?: string;
  }>;
  som?: {
    marks: number;
    segments: string[];
  };
  artifacts: {
    resultJsonUrl: string;
    reportMdUrl: string;
    screenshotUrl: string;
  };
}

export default function LegalSuitePage() {
  const [topics, setTopics] = useState<LegalTopicSummary[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string>('');
  const [topicDetail, setTopicDetail] = useState<LegalTopicDetail | null>(null);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [loadingTopicDetail, setLoadingTopicDetail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  const [checkUrl, setCheckUrl] = useState('https://www.bmw.de');
  const [checkResult, setCheckResult] = useState<LegalCheckResult | null>(null);

  const [modelName, setModelName] = useState('gemini-2.0-flash');
  const [models, setModels] = useState<ModelOption[]>([{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }]);
  const [legalPersona, setLegalPersona] = useState<LegalPersonaKey>('legal_eu');
  const [checkMode, setCheckMode] = useState<LegalCheckMode>('explorative');
  const [explorationSteps, setExplorationSteps] = useState(4);
  const [visibleBrowser, setVisibleBrowser] = useState(false);
  const [liveThoughts, setLiveThoughts] = useState<LegalThoughtEntry[]>([]);

  const selectedTopicSummary = useMemo(
    () => topics.find((topic) => topic.id === selectedTopicId) || null,
    [topics, selectedTopicId]
  );

  const loadTopics = useCallback(async (preserveSelection = true) => {
    setLoadingTopics(true);
    try {
      const res = await fetch('http://localhost:3001/legal/topics');
      const data = await res.json();
      const nextTopics: LegalTopicSummary[] = Array.isArray(data?.topics) ? data.topics : [];
      setTopics(nextTopics);

      if (nextTopics.length === 0) {
        setSelectedTopicId('');
        setTopicDetail(null);
        return;
      }

      setSelectedTopicId((previousTopicId) => {
        const hasPrevious = nextTopics.some((topic) => topic.id === previousTopicId);
        if (preserveSelection && hasPrevious) {
          return previousTopicId;
        }
        return nextTopics[0].id;
      });
    } catch {
      setMessage('Failed to load legal topics. Is backend running on :3001?');
    } finally {
      setLoadingTopics(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:3001/models');
      const data = await res.json();
      const nextModels: ModelOption[] = Array.isArray(data?.models) ? data.models : [];
      if (nextModels.length === 0) return;
      setModels(nextModels);
      setModelName((prev) => nextModels.some((model) => model.id === prev) ? prev : nextModels[0].id);
    } catch {
      // keep fallback
    }
  }, []);

  const loadTopicDetail = useCallback(async (topicId: string) => {
    if (!topicId) {
      setTopicDetail(null);
      return;
    }
    setLoadingTopicDetail(true);
    try {
      const res = await fetch(`http://localhost:3001/legal/topics/${topicId}`);
      const data = await res.json();
      if (!res.ok) {
        setMessage(data?.error || 'Failed to load topic details.');
        setTopicDetail(null);
        return;
      }
      setTopicDetail(data as LegalTopicDetail);
    } catch {
      setMessage('Failed to load topic detail.');
    } finally {
      setLoadingTopicDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadTopics(false);
    void loadModels();
  }, [loadTopics, loadModels]);

  useEffect(() => {
    void loadTopicDetail(selectedTopicId);
  }, [loadTopicDetail, selectedTopicId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTopics(true);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [loadTopics]);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3001');

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data || '{}')) as { type?: string; payload?: unknown };
        if (message.type !== 'legal_thought') return;
        const payload = message.payload as Partial<LegalThoughtEntry> | undefined;
        const payloadMessage = payload?.message;
        if (!payload || typeof payloadMessage !== 'string') return;

        const phaseValue = typeof payload.phase === 'string' ? payload.phase : '';
        const phase: LegalThoughtEntry['phase'] = (
          phaseValue === 'setup' ||
          phaseValue === 'navigation' ||
          phaseValue === 'analysis' ||
          phaseValue === 'scoring' ||
          phaseValue === 'report'
        ) ? phaseValue : 'analysis';

        setLiveThoughts((prev) => [
          ...prev,
          {
            timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
            phase,
            message: payloadMessage
          }
        ]);
      } catch {
        // Ignore malformed WS messages.
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const handleSyncTopic = async () => {
    if (!selectedTopicId || syncing) return;
    setSyncing(true);
    setMessage(`Syncing legal sources for ${selectedTopicId}...`);
    try {
      const res = await fetch(`http://localhost:3001/legal/topics/${selectedTopicId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName })
      });
      const data = await res.json();
      if (!res.ok) {
        const details = typeof data?.details === 'string' && data.details.trim().length > 0 ? ` (${data.details})` : '';
        setMessage(`${data?.error || 'Topic sync failed.'}${details}`);
        return;
      }
      setTopicDetail(data as LegalTopicDetail);
      setMessage(`Topic synced: ${(data as LegalTopicDetail).name}`);
      await loadTopics(true);
    } catch {
      setMessage('Topic sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const handleRunCheck = async () => {
    if (!selectedTopicId || checking) return;
    setChecking(true);
    setCheckResult(null);
    setLiveThoughts([]);
    setMessage(
      `Running ${checkMode} legal check (${visibleBrowser ? 'visible browser' : 'headless'}) with ${legalPersona === 'bare' ? 'Bare LLM' : 'Legal Expert'}...`
    );

    try {
      const res = await fetch('http://localhost:3001/legal/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicId: selectedTopicId,
          url: checkUrl,
          modelName,
          personaName: legalPersona,
          mode: checkMode,
          maxExplorationSteps: explorationSteps,
          headlessMode: !visibleBrowser
        })
      });
      const data = await res.json();
      if (!res.ok) {
        const details = typeof data?.details === 'string' && data.details.trim().length > 0 ? ` (${data.details})` : '';
        setMessage(`${data?.error || 'Legal check failed.'}${details}`);
        if (typeof data?.error === 'string' && data.error.toLowerCase().includes('unknown legal topic')) {
          void loadTopics(false);
        }
        return;
      }
      setCheckResult(data as LegalCheckResult);
      setLiveThoughts((data as LegalCheckResult).thoughts || []);
      setMessage(`Compliance check completed: score ${(data as LegalCheckResult).overallScore}/100`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(`Legal check failed. (${reason})`);
    } finally {
      setChecking(false);
    }
  };

  const statusClass = (status: LegalCheckFinding['status']) => {
    if (status === 'pass') return 'text-emerald-300';
    if (status === 'fail') return 'text-rose-300';
    if (status === 'not-applicable') return 'text-sky-300';
    return 'text-amber-300';
  };

  const thoughtTimeline = useMemo(() => {
    if (checking) return liveThoughts;
    if (checkResult?.thoughts?.length) return checkResult.thoughts;
    return liveThoughts;
  }, [checking, checkResult, liveThoughts]);

  return (
    <div className="legal-suite min-h-full px-5 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl leading-none text-white">Legal Suite</h1>
          <p className="mt-1 text-sm text-[#9cb6d3]">
            Internet-synced legal topics, requirement explorer, and website compliance checks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="drive-label !mb-0">Model</label>
          <select
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            className="drive-select w-[280px] text-sm"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name} ({model.id})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="drive-panel p-3">
          <div className="mb-3 flex items-center justify-between">
            <p className="drive-label !mb-0">Legal Topics</p>
            <button
              type="button"
              onClick={() => void loadTopics(true)}
              className="drive-download-link !px-2 !py-1"
              disabled={loadingTopics}
            >
              <RefreshCw size={12} className={loadingTopics ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>

          <div className="space-y-2">
            {topics.map((topic) => (
              <button
                key={topic.id}
                type="button"
                onClick={() => setSelectedTopicId(topic.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${selectedTopicId === topic.id
                  ? 'border-[#66c7ff] bg-[#0f2740]'
                  : 'border-[#2a4362] bg-[#0a1b2f] hover:border-[#4f7ca8]'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[#e7f3ff]">{topic.name}</p>
                  <span className="rounded-full border border-[#355a80] px-1.5 py-0.5 text-[10px] text-[#9cc4e6]">
                    {topic.region}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[#9bb5d2]">{topic.legalArea}</p>
                <p className="mt-1 max-h-10 overflow-hidden text-xs text-[#7f9bbc]">{topic.description}</p>
                <div className="mt-2 flex items-center justify-between text-[11px] text-[#86a3c5]">
                  <span>{topic.requirementsCount} req</span>
                  <span>{topic.lastSyncedAt ? new Date(topic.lastSyncedAt).toLocaleString() : 'not synced'}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="space-y-4">
          <div className="drive-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="drive-label !mb-1">Selected Topic</p>
                <h2 className="font-display text-2xl text-white">{topicDetail?.name || selectedTopicSummary?.name || 'Select a topic'}</h2>
                <p className="mt-1 text-sm text-[#8eadcf]">{topicDetail?.description || selectedTopicSummary?.description || ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSyncTopic}
                  disabled={!selectedTopicId || syncing}
                  className="drive-btn drive-btn--primary"
                >
                  <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
                  {syncing ? 'Syncing...' : 'Sync From Web'}
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-lg border border-[#274560] bg-[#091e33] p-3">
                <p className="drive-label !mb-1">Region</p>
                <p className="text-sm text-[#d7e8fb]">{topicDetail?.region || selectedTopicSummary?.region || '-'}</p>
              </div>
              <div className="rounded-lg border border-[#274560] bg-[#091e33] p-3">
                <p className="drive-label !mb-1">Legal Area</p>
                <p className="text-sm text-[#d7e8fb]">{topicDetail?.legalArea || selectedTopicSummary?.legalArea || '-'}</p>
              </div>
              <div className="rounded-lg border border-[#274560] bg-[#091e33] p-3">
                <p className="drive-label !mb-1">Requirements</p>
                <p className="text-sm text-[#d7e8fb]">{topicDetail?.requirements.length ?? selectedTopicSummary?.requirementsCount ?? 0}</p>
              </div>
            </div>

            <div className="mt-4">
              <p className="drive-label !mb-2">Primary Sources</p>
              <div className="grid gap-2 md:grid-cols-2">
                {(topicDetail?.sources || []).map((source) => (
                  <a
                    key={source.id}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="drive-download-link justify-between"
                  >
                    <span className="truncate text-left">{source.title}</span>
                    <Globe size={12} />
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div className="drive-panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="drive-label !mb-0">Legal Requirements</p>
              {topicDetail?.requirementsFileUrl && (
                <a
                  className="drive-download-link !px-2 !py-1"
                  href={`http://localhost:3001${topicDetail.requirementsFileUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download JSON
                </a>
              )}
            </div>

            {loadingTopicDetail ? (
              <div className="rounded-lg border border-[#2a4766] bg-[#081a2d] p-3 text-sm text-[#a7c2dd]">Loading topic details...</div>
            ) : (topicDetail?.requirements.length || 0) === 0 ? (
              <div className="rounded-lg border border-[#3d5c7f] bg-[#0c2238] p-3 text-sm text-[#b6d0e9]">
                No generated requirements yet. Click <strong>Sync From Web</strong> to fetch legal sources and build requirements.
              </div>
            ) : (
              <div className="space-y-3">
                {(topicDetail?.requirements || []).map((requirement) => (
                  <details key={requirement.id} className="rounded-lg border border-[#2a4665] bg-[#0a1e33] p-3">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center gap-2">
                        <BookOpenText size={14} className="text-[#73c7ff]" />
                        <span className="text-sm font-semibold text-[#e5f2ff]">{requirement.id} - {requirement.title}</span>
                      </div>
                    </summary>

                    <div className="mt-3 grid gap-2 text-sm">
                      <div>
                        <p className="drive-label !mb-1">Plain Language</p>
                        <p className="text-[#c8ddf2]">{requirement.plainLanguage}</p>
                      </div>
                      <div>
                        <p className="drive-label !mb-1">Practical Expectation</p>
                        <p className="text-[#c8ddf2]">{requirement.practicalExpectation}</p>
                      </div>
                      <div>
                        <p className="drive-label !mb-1">Why Important</p>
                        <p className="text-[#c8ddf2]">{requirement.whyImportant}</p>
                      </div>
                      <div>
                        <p className="drive-label !mb-1">Evidence Hints</p>
                        <ul className="space-y-1 text-[#c8ddf2]">
                          {requirement.evidenceHints.map((hint, index) => (
                            <li key={`${requirement.id}-hint-${index}`}>- {hint}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="drive-label !mb-1">Sources</p>
                        <ul className="space-y-1 text-[#c8ddf2]">
                          {requirement.sourceRefs.map((source, index) => (
                            <li key={`${requirement.id}-source-${index}`}>
                              <a href={source.url} target="_blank" rel="noreferrer" className="underline decoration-[#4ca8de] decoration-dotted underline-offset-2">
                                {source.title}
                              </a>{' '}
                              <span className="text-[#8eabca]">({source.note})</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>

          <div className="drive-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <Scale size={16} className="text-[#80d0ff]" />
              <p className="drive-label !mb-0">Run Legal Compliance Check</p>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <div className="space-y-2">
                <label className="drive-label mb-2 block">Website URL</label>
                <input
                  type="text"
                  value={checkUrl}
                  onChange={(event) => setCheckUrl(event.target.value)}
                  className="drive-input"
                  placeholder="https://www.example.com"
                />
                <div className="flex items-center justify-between rounded-lg border border-[#2a4866] bg-[#081d31] px-3 py-2">
                  <span className="drive-label !mb-0">Visible Browser</span>
                  <button
                    type="button"
                    className="drive-toggle"
                    data-on={visibleBrowser ? 'true' : 'false'}
                    onClick={() => setVisibleBrowser((prev) => !prev)}
                    aria-pressed={visibleBrowser}
                  >
                    {visibleBrowser ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="drive-label mb-1 block">Legal Persona</label>
                    <select
                      value={legalPersona}
                      onChange={(event) => setLegalPersona(event.target.value as LegalPersonaKey)}
                      className="drive-select text-sm"
                    >
                      <option value="legal_eu">Legal Expert (EU Auditor)</option>
                      <option value="bare">Bare LLM (No Persona Rules)</option>
                    </select>
                  </div>
                  <div>
                    <label className="drive-label mb-1 block">Check Mode</label>
                    <select
                      value={checkMode}
                      onChange={(event) => setCheckMode(event.target.value as LegalCheckMode)}
                      className="drive-select text-sm"
                    >
                      <option value="explorative">Explorative (Clicks Through Site)</option>
                      <option value="snapshot">Snapshot (Single Page)</option>
                    </select>
                  </div>
                </div>
                {checkMode === 'explorative' && (
                  <div>
                    <label className="drive-label mb-1 block">Exploration Steps</label>
                    <input
                      type="number"
                      min={2}
                      max={8}
                      value={explorationSteps}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (!Number.isFinite(value)) return;
                        setExplorationSteps(Math.max(2, Math.min(8, Math.floor(value))));
                      }}
                      className="drive-input"
                    />
                  </div>
                )}
                <p className="text-xs text-[#88a9c8]">
                  {checkMode === 'explorative'
                    ? `Explorative mode follows likely legal-relevant links for up to ${explorationSteps} steps before scoring. `
                    : 'Snapshot mode evaluates one page state only. '}
                  {visibleBrowser
                    ? 'Browser window opens during capture and closes automatically after the run.'
                    : 'Headless mode runs without a visible browser window.'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleRunCheck}
                disabled={checking || !selectedTopicId}
                className="drive-btn drive-btn--primary h-[42px]"
              >
                <ShieldCheck size={16} /> {checking ? 'Checking...' : 'Start Check'}
              </button>
            </div>

            {message && (
              <div className="mt-3 rounded-lg border border-[#2d4f72] bg-[#091d31] px-3 py-2 text-sm text-[#bed6ee]">
                {message}
              </div>
            )}

            {(checking || thoughtTimeline.length > 0) && (
              <div className="mt-3 rounded-lg border border-[#294968] bg-[#081b2f] p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="drive-label !mb-0">Legal Thought Stream</p>
                  {checking && (
                    <span className="rounded-full border border-[#4a8dc0] bg-[#0b2b47] px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] text-[#9fd2ff]">
                      LIVE
                    </span>
                  )}
                </div>
                {thoughtTimeline.length === 0 ? (
                  <p className="text-sm text-[#8fafcc]">Waiting for thought events...</p>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-auto pr-1">
                    {thoughtTimeline.map((thought, index) => (
                      <div key={`${thought.timestamp}-${thought.phase}-${index}`} className="rounded-md border border-[#1f3a57] bg-[#07182a] px-2 py-1.5">
                        <p className="text-[11px] text-[#89a9c8]">
                          {new Date(thought.timestamp).toLocaleTimeString()} · {thought.phase.toUpperCase()}
                        </p>
                        <p className="text-sm text-[#d3e7fb]">{thought.message}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {checkResult && (
              <div className="mt-4 space-y-3 rounded-lg border border-[#274767] bg-[#081b2f] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-[#99b6d5]">Result for {checkResult.url}</p>
                    <p className="font-display text-2xl text-white">Score {checkResult.overallScore}/100</p>
                    <p className="text-sm text-[#98b3d1]">{checkResult.summary.modelSummary}</p>
                    <p className="mt-1 text-xs text-[#86a8c9]">
                      Persona: {checkResult.personaName} · Mode: {checkResult.mode} · Planned Steps: {checkResult.explorationSteps}
                    </p>
                    {checkResult.som && (
                      <p className="mt-1 text-xs text-[#7fb0d8]">
                        SoM Marks: {checkResult.som.marks}
                        {checkResult.som.segments?.length ? ` · Segments: ${checkResult.som.segments.slice(0, 3).join(', ')}` : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <a href={`http://localhost:3001${checkResult.artifacts.resultJsonUrl}`} target="_blank" rel="noreferrer" className="drive-download-link">Result JSON</a>
                    <a href={`http://localhost:3001${checkResult.artifacts.reportMdUrl}`} target="_blank" rel="noreferrer" className="drive-download-link">Report MD</a>
                    <a href={`http://localhost:3001${checkResult.artifacts.screenshotUrl}`} target="_blank" rel="noreferrer" className="drive-download-link">Screenshot</a>
                  </div>
                </div>

                {checkResult.journey?.length > 0 && (
                  <div className="rounded-lg border border-[#294968] bg-[#071a2d] p-2">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.1em] text-[#88a9c8]">Navigation Journey</p>
                    <div className="max-h-40 space-y-1 overflow-auto pr-1 text-xs text-[#bdd5ec]">
                      {checkResult.journey.map((step) => (
                        <div key={`${checkResult.checkId}-journey-${step.step}`} className="rounded border border-[#1f3650] bg-[#061628] px-2 py-1">
                          <p className="text-[#e1f0ff]">
                            Step {step.step}: {step.action.toUpperCase()}
                            {step.candidateLabel ? ` → ${step.candidateLabel}` : ''}
                          </p>
                          {typeof step.somCount === 'number' && (
                            <p className="text-[#9ec1e2]">SoM marks: {step.somCount}</p>
                          )}
                          {step.segmentHint && (
                            <p className="truncate text-[#7ea5cb]">{step.segmentHint}</p>
                          )}
                          <p className="truncate text-[#8eb0d2]">{step.title || '(no title)'}</p>
                          <p className="truncate text-[#7898b8]">{step.url}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[780px] border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-[#2a4866] text-left text-[#89aacc]">
                        <th className="py-1 pr-2 font-medium">Requirement</th>
                        <th className="py-1 pr-2 font-medium">Status</th>
                        <th className="py-1 pr-2 font-medium">Confidence</th>
                        <th className="py-1 pr-2 font-medium">Reasoning</th>
                        <th className="py-1 pr-2 font-medium">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkResult.findings.map((finding) => (
                        <tr key={finding.requirementId} className="border-b border-[#1d334b] text-[#d5e7f9] align-top">
                          <td className="py-2 pr-2">
                            <div className="font-semibold">{finding.requirementId}</div>
                            <div className="text-[#9fb9d6]">{finding.title}</div>
                          </td>
                          <td className={`py-2 pr-2 font-semibold ${statusClass(finding.status)}`}>
                            <div className="inline-flex items-center gap-1">
                              {finding.status === 'pass' && <CheckCircle2 size={12} />}
                              {finding.status === 'fail' && <AlertTriangle size={12} />}
                              {finding.status.toUpperCase()}
                            </div>
                          </td>
                          <td className="py-2 pr-2">{finding.confidence.toFixed(2)}</td>
                          <td className="py-2 pr-2 text-[#c5dbef]">{finding.reasoning}</td>
                          <td className="py-2 pr-2 text-[#c5dbef]">{finding.recommendation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
