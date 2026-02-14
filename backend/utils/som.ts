import { Page } from 'playwright';

export const SOM_OVERLAY_ID = 'drive-overlay';

export interface SoMElementMeta {
    id: number;
    tag: string;
    role?: string;
    text?: string;
    ariaLabel?: string;
    title?: string;
    href?: string;
}

export interface SoMResult {
    status: 'success';
    count: number;
    elements: SoMElementMeta[];
}

export const injectSoM = async (page: Page) => {
    return await page.evaluate(async ({ overlayId }) => {
        // Config
        const POPCORN_WAIT_MS = 500;
        const OVERLAY_ID = overlayId;
        const MAX_MARKS = 220;
        const MIN_SIDE_PX = 18;
        const MIN_AREA_PX = 320;
        const MAX_ANCESTOR_DEPTH = 8;

        // Cleanup previous overlay
        const existingOverlay = document.getElementById(OVERLAY_ID);
        if (existingOverlay) existingOverlay.remove();

        // Remove old data attributes
        document.querySelectorAll('[data-som-id]').forEach(el => el.removeAttribute('data-som-id'));

        // 1. Popcorn Principle: Wait for DOM stability (with hard cap)
        await new Promise<void>((resolve) => {
            const MAX_WAIT_MS = 3000; // Absolute maximum wait — never hang longer
            let timer: any = null;
            let resolved = false;

            const done = () => {
                if (resolved) return;
                resolved = true;
                observer.disconnect();
                clearTimeout(hardCap);
                if (timer) clearTimeout(timer);
                resolve();
            };

            const observer = new MutationObserver(() => {
                if (resolved) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(done, POPCORN_WAIT_MS);
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });

            // Initial fallback if no mutations happen immediately
            timer = setTimeout(done, POPCORN_WAIT_MS);

            // Hard cap: resolve no matter what after MAX_WAIT_MS
            const hardCap = setTimeout(done, MAX_WAIT_MS);
        });

        // 2. Traversal & Marking
        let idCounter = 0;
        interface RectData {
            left: number;
            top: number;
            right: number;
            bottom: number;
            width: number;
            height: number;
            area: number;
        }

        interface Candidate {
            el: Element;
            rect: RectData;
            score: number;
        }
        const candidates: Candidate[] = [];

        const INTERACTIVE_ROLES = new Set([
            'button', 'link', 'checkbox', 'menuitem', 'option', 'tab', 'switch', 'radio'
        ]);
        const NATIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'details', 'summary']);

        function getRect(el: Element): RectData {
            const r = el.getBoundingClientRect();
            return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
                area: r.width * r.height
            };
        }

        function isInViewport(rect: RectData): boolean {
            return rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < window.innerHeight &&
                rect.left < window.innerWidth;
        }

        function getInteractiveScore(el: Element): number {
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            const tabindexRaw = el.getAttribute('tabindex');
            const tabindex = tabindexRaw === null ? null : Number(tabindexRaw);
            const style = window.getComputedStyle(el);
            const className = (el.className || '').toString().toLowerCase();
            const attrs = Array.from(el.attributes).map(a => `${a.name}=${a.value}`.toLowerCase()).join(' ');
            const text = (el.textContent || '').trim();
            const ariaLabel = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();

            if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return 0;
            if ((el as HTMLElement).hasAttribute?.('disabled')) return 0;
            if (el.getAttribute('aria-disabled') === 'true') return 0;
            if (el.getAttribute('aria-hidden') === 'true') return 0;

            const isNativeInteractive = NATIVE_TAGS.has(tag);
            const isRoleInteractive = INTERACTIVE_ROLES.has(role);
            const hasClickBehavior =
                el.hasAttribute('onclick') ||
                (tabindex !== null && Number.isFinite(tabindex) && tabindex >= 0);
            const hasPointerCursor = style.cursor === 'pointer';
            const hasInteractiveClass = /(^|[\s_-])(btn|button|cta|link|nav|menu|tab)([\s_-]|$)/.test(className);
            const hasInteractiveData =
                attrs.includes('data-action=') ||
                attrs.includes('data-click') ||
                attrs.includes('data-testid=') ||
                attrs.includes('cookie') ||
                attrs.includes('consent');
            const hasSemanticLabel = text.length > 0 || ariaLabel.length > 0 || title.length > 0;

            // Strong semantic interactions
            if (isNativeInteractive) return 4;
            if (isRoleInteractive) return 3;
            if (hasClickBehavior) return 2;

            // Weaker visual heuristic: require pointer + semantic hint
            if (hasPointerCursor && (hasInteractiveClass || hasInteractiveData || hasSemanticLabel)) {
                return 1;
            }

            return 0;
        }

        function hasStrongInteractiveAncestor(el: Element): boolean {
            let current = el.parentElement;
            let depth = 0;
            while (current && depth < MAX_ANCESTOR_DEPTH) {
                if (current.id === OVERLAY_ID) return false;
                const score = getInteractiveScore(current);
                if (score >= 2) return true;
                depth++;
                current = current.parentElement;
            }
            return false;
        }

        function isVisible(el: Element): boolean {
            if (!el.getBoundingClientRect || !el.checkVisibility) return false;
            const style = window.getComputedStyle(el);
            const rect = getRect(el);
            return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.pointerEvents !== 'none' &&
                rect.width > 0 &&
                rect.height > 0 &&
                isInViewport(rect);
        }

        function isInteractable(el: Element): boolean {
            if (!isVisible(el)) return false;

            const score = getInteractiveScore(el);
            if (score <= 0) return false;

            const rect = getRect(el);
            const tag = el.tagName.toLowerCase();
            const isNative = NATIVE_TAGS.has(tag);

            // Remove tiny visual fragments unless they are genuine form controls.
            if (!isNative && (rect.width < MIN_SIDE_PX || rect.height < MIN_SIDE_PX || rect.area < MIN_AREA_PX)) {
                return false;
            }

            // Skip likely duplicate children when a strong ancestor already represents this region.
            if (score <= 2 && hasStrongInteractiveAncestor(el)) {
                return false;
            }

            return true;
        }

        function traverse(root: Element | ShadowRoot) {
            const queue: (Element | ShadowRoot)[] = [root];

            while (queue.length > 0) {
                const node = queue.shift();
                if (!node) continue;

                // 1. If it's an Element and has a Shadow Root, add the Shadow Root to queue
                if (node instanceof Element && node.shadowRoot) {
                    queue.push(node.shadowRoot);
                }

                // 2. Iterate over children (both Element and ShadowRoot have .children)
                // ShadowRoot and Element both have 'children' property (HTMLCollection)
                const children = (node as any).children;
                if (children) {
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        if (child.id === OVERLAY_ID) continue; // Skip our overlay

                        // Recursively add child to queue for traversal
                        queue.push(child);

                        // Check interactivity
                        if (isInteractable(child)) {
                            candidates.push({
                                el: child,
                                rect: getRect(child),
                                score: getInteractiveScore(child)
                            });
                        }
                    }
                }
            }
        }

        traverse(document.body);

        function overlapRatio(a: RectData, b: RectData): number {
            const left = Math.max(a.left, b.left);
            const right = Math.min(a.right, b.right);
            const top = Math.max(a.top, b.top);
            const bottom = Math.min(a.bottom, b.bottom);
            const w = Math.max(0, right - left);
            const h = Math.max(0, bottom - top);
            const overlapArea = w * h;
            const minArea = Math.max(1, Math.min(a.area, b.area));
            return overlapArea / minArea;
        }

        // Keep strongest unique candidates first and cap total mark count.
        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.rect.area - a.rect.area;
        });

        const interactables: Candidate[] = [];
        for (const candidate of candidates) {
            if (interactables.length >= MAX_MARKS) break;

            const isDuplicate = interactables.some(existing =>
                overlapRatio(candidate.rect, existing.rect) > 0.92
            );

            if (!isDuplicate) {
                interactables.push(candidate);
            }
        }

        interactables.forEach(({ el }) => {
            el.setAttribute('data-som-id', idCounter.toString());
            idCounter++;
        });

        // 3. Visualization (Overlay)
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: '2147483646', // Keep below ghost cursor
            overflow: 'hidden'
        });

        function buildRect(left: number, top: number, width: number, height: number): RectData {
            return {
                left,
                top,
                right: left + width,
                bottom: top + height,
                width,
                height,
                area: width * height
            };
        }

        function intersectionArea(a: RectData, b: RectData): number {
            const left = Math.max(a.left, b.left);
            const right = Math.min(a.right, b.right);
            const top = Math.max(a.top, b.top);
            const bottom = Math.min(a.bottom, b.bottom);
            const w = Math.max(0, right - left);
            const h = Math.max(0, bottom - top);
            return w * h;
        }

        const targetRects = interactables.map(item => item.rect);
        const occupiedLabelRects: RectData[] = [];

        interactables.forEach(({ el, rect }) => {
            const id = Number(el.getAttribute('data-som-id'));

            const box = document.createElement('div');
            Object.assign(box.style, {
                position: 'absolute',
                left: rect.left + 'px',
                top: rect.top + 'px',
                width: rect.width + 'px',
                height: rect.height + 'px',
                border: '2px solid rgba(255, 0, 0, 0.95)',
                boxSizing: 'border-box',
                pointerEvents: 'none'
            });
            overlay.appendChild(box);

            const label = document.createElement('div');
            label.textContent = id.toString();
            Object.assign(label.style, {
                position: 'absolute',
                backgroundColor: 'rgba(220, 38, 38, 0.98)',
                color: 'white',
                fontSize: '11px',
                fontWeight: '700',
                lineHeight: '1',
                padding: '2px 4px',
                borderRadius: '3px',
                border: '1px solid rgba(255, 255, 255, 0.92)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                visibility: 'hidden',
                zIndex: '2'
            });
            overlay.appendChild(label);

            const measured = label.getBoundingClientRect();
            const labelWidth = Math.max(18, Math.ceil(measured.width));
            const labelHeight = Math.max(14, Math.ceil(measured.height));
            const gap = 2;

            const candidates = [
                { left: rect.left + 1, top: rect.top - labelHeight - gap, preference: 0 },               // top-left outside
                { left: rect.right - labelWidth - 1, top: rect.top - labelHeight - gap, preference: 0.2 }, // top-right outside
                { left: rect.left + 1, top: rect.bottom + gap, preference: 0.3 },                         // bottom-left outside
                { left: rect.right - labelWidth - 1, top: rect.bottom + gap, preference: 0.35 },          // bottom-right outside
                { left: rect.left - labelWidth - gap, top: rect.top + 1, preference: 0.5 },               // left outside
                { left: rect.right + gap, top: rect.top + 1, preference: 0.5 },                           // right outside
                { left: rect.left + 1, top: rect.top + 1, preference: 1.8 }                               // inside fallback
            ];

            let bestRect: RectData | null = null;
            let bestScore = Number.POSITIVE_INFINITY;

            for (const option of candidates) {
                const testRect = buildRect(option.left, option.top, labelWidth, labelHeight);

                const overflowX = Math.max(0, -testRect.left) + Math.max(0, testRect.right - window.innerWidth);
                const overflowY = Math.max(0, -testRect.top) + Math.max(0, testRect.bottom - window.innerHeight);
                const overflowPenalty = (overflowX + overflowY) * 220;

                let overlapWithElements = 0;
                for (const target of targetRects) {
                    overlapWithElements += intersectionArea(testRect, target);
                }

                let overlapWithLabels = 0;
                for (const used of occupiedLabelRects) {
                    overlapWithLabels += intersectionArea(testRect, used);
                }

                const overlapOwn = intersectionArea(testRect, rect);
                const ownPenalty = overlapOwn > 0 ? overlapOwn * 4.5 : 0;

                const score =
                    overflowPenalty +
                    overlapWithElements * 1.25 +
                    overlapWithLabels * 2.8 +
                    ownPenalty +
                    option.preference;

                if (score < bestScore) {
                    bestScore = score;
                    bestRect = testRect;
                }
            }

            const selected = bestRect || buildRect(rect.left + 1, rect.top + 1, labelWidth, labelHeight);
            const clampedLeft = Math.max(0, Math.min(selected.left, window.innerWidth - labelWidth));
            const clampedTop = Math.max(0, Math.min(selected.top, window.innerHeight - labelHeight));
            const finalRect = buildRect(clampedLeft, clampedTop, labelWidth, labelHeight);

            label.style.left = `${Math.round(finalRect.left)}px`;
            label.style.top = `${Math.round(finalRect.top)}px`;
            label.style.visibility = 'visible';
            occupiedLabelRects.push(finalRect);
        });

        document.body.appendChild(overlay);

        const elements = interactables.map(({ el }) => {
            const text = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const ariaLabel = (el.getAttribute('aria-label') || '').trim().slice(0, 80);
            const title = (el.getAttribute('title') || '').trim().slice(0, 80);
            const href = (el instanceof HTMLAnchorElement ? el.getAttribute('href') : null) || '';

            return {
                id: Number(el.getAttribute('data-som-id')),
                tag: el.tagName.toLowerCase(),
                role: (el.getAttribute('role') || '').toLowerCase() || undefined,
                text: text || undefined,
                ariaLabel: ariaLabel || undefined,
                title: title || undefined,
                href: href || undefined
            };
        });

        return { status: 'success', count: interactables.length, elements };
    }, { overlayId: SOM_OVERLAY_ID });
};

export const setSoMOverlayVisibility = async (page: Page, visible: boolean) => {
    await page.evaluate(({ overlayId, shouldShow }) => {
        const overlay = document.getElementById(overlayId);
        if (!overlay) return;
        (overlay as HTMLElement).style.display = shouldShow ? 'block' : 'none';
    }, {
        overlayId: SOM_OVERLAY_ID,
        shouldShow: visible
    });
};
