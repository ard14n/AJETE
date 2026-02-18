'use client';

import React, { useMemo, useState } from 'react';
import { ClipboardList, ListChecks, Sparkles, Target } from 'lucide-react';

interface StoryCheckItem {
  id: string;
  text: string;
}

const normalizeChecklist = (raw: string): StoryCheckItem[] => {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => ({
    id: `check-${index + 1}`,
    text: line
  }));
};

export default function StoryValidationSuitePage() {
  const [targetUrl, setTargetUrl] = useState('https://www.example.com');
  const [persona, setPersona] = useState('helmut');
  const [storyAsA, setStoryAsA] = useState('As a buyer');
  const [storyIWant, setStoryIWant] = useState('I want to compare products before checkout');
  const [storySoThat, setStorySoThat] = useState('so that I can decide quickly with confidence');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    '- User can find compare entry point in under 3 interactions\n- At least 2 products can be added to compare\n- Key specs and pricing are visible in compare view\n- User can continue to checkout flow from compare view'
  );
  const [includeExploration, setIncludeExploration] = useState(true);
  const [requireLegalSignals, setRequireLegalSignals] = useState(false);
  const [useSOM, setUseSOM] = useState(true);

  const checks = useMemo(() => normalizeChecklist(acceptanceCriteria), [acceptanceCriteria]);
  const generatedObjective = useMemo(() => {
    const storyLine = `${storyAsA}, ${storyIWant}, ${storySoThat}.`;
    if (checks.length === 0) return storyLine;
    const checksLine = checks.map((check, index) => `${index + 1}) ${check.text}`).join(' ');
    return `${storyLine} Validate acceptance criteria: ${checksLine}`;
  }, [storyAsA, storyIWant, storySoThat, checks]);

  return (
    <div className="legal-suite min-h-full px-5 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl leading-none text-white">Story Validation Suite</h1>
          <p className="mt-1 text-sm text-[#9cb6d3]">
            Convert user stories into checkable criteria and generate a reusable validation objective.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section className="drive-panel p-4">
          <div className="mb-3 flex items-center gap-2">
            <ClipboardList size={16} className="text-[#80d0ff]" />
            <p className="drive-label !mb-0">Story Definition</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="drive-label mb-1 block">Target URL</label>
              <input
                type="text"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                className="drive-input"
                placeholder="https://www.example.com"
              />
            </div>

            <div>
              <label className="drive-label mb-1 block">Persona</label>
              <select
                value={persona}
                onChange={(event) => setPersona(event.target.value)}
                className="drive-select"
              >
                <option value="helmut">Helmut (Power User)</option>
                <option value="dieter">Dieter (Impatient User)</option>
                <option value="a11y">Miriam (A11y)</option>
                <option value="bare">Bare LLM</option>
              </select>
            </div>

            <div className="rounded-lg border border-[#2a4866] bg-[#081d31] px-3 py-2">
              <p className="drive-label !mb-2">Execution Toggles</p>
              <div className="space-y-2 text-xs text-[#c0d8ef]">
                <label className="flex items-center justify-between gap-2">
                  <span>Explorative Journey</span>
                  <input type="checkbox" checked={includeExploration} onChange={(e) => setIncludeExploration(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>Use SoM Marks</span>
                  <input type="checkbox" checked={useSOM} onChange={(e) => setUseSOM(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>Include Legal Signals</span>
                  <input type="checkbox" checked={requireLegalSignals} onChange={(e) => setRequireLegalSignals(e.target.checked)} />
                </label>
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="drive-label mb-1 block">As a...</label>
              <input
                type="text"
                value={storyAsA}
                onChange={(event) => setStoryAsA(event.target.value)}
                className="drive-input"
              />
            </div>
            <div className="md:col-span-2">
              <label className="drive-label mb-1 block">I want...</label>
              <input
                type="text"
                value={storyIWant}
                onChange={(event) => setStoryIWant(event.target.value)}
                className="drive-input"
              />
            </div>
            <div className="md:col-span-2">
              <label className="drive-label mb-1 block">So that...</label>
              <input
                type="text"
                value={storySoThat}
                onChange={(event) => setStorySoThat(event.target.value)}
                className="drive-input"
              />
            </div>
            <div className="md:col-span-2">
              <label className="drive-label mb-1 block">Acceptance Criteria (one per line)</label>
              <textarea
                value={acceptanceCriteria}
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                className="drive-textarea h-36 resize-y"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div className="drive-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <ListChecks size={16} className="text-[#77c8ff]" />
              <p className="drive-label !mb-0">Validation Checklist</p>
            </div>
            {checks.length === 0 ? (
              <p className="text-sm text-[#93b2cf]">Add acceptance criteria to generate executable checks.</p>
            ) : (
              <div className="space-y-2">
                {checks.map((check, index) => (
                  <div key={check.id} className="rounded-md border border-[#25435f] bg-[#08192a] px-3 py-2">
                    <p className="text-xs text-[#8eb0d1]">Check {index + 1}</p>
                    <p className="text-sm text-[#d8eaff]">{check.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="drive-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles size={16} className="text-[#8fd8ff]" />
              <p className="drive-label !mb-0">Generated Objective</p>
            </div>
            <p className="rounded-lg border border-[#284864] bg-[#071a2d] px-3 py-3 text-sm text-[#cde1f4]">
              {generatedObjective}
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#274767] bg-[#0a2035] px-3 py-2 text-xs text-[#a8c5e0]">
              <Target size={14} className="text-[#71c7ff]" />
              Use this objective directly in Exploration Suite or as input for a future automated Story Runner endpoint.
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
