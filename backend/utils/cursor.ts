import { Page } from 'playwright';

export interface CursorPoint {
    x: number;
    y: number;
}

type ClickPhase = 'down' | 'up';

interface CursorPath {
    points: CursorPoint[];
    durationMs: number;
}

const CURSOR_ID = 'drive-ghost-cursor';
const CURSOR_STYLE_ID = 'drive-ghost-cursor-style';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

const easeInOutCubic = (t: number) => (
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
);

const cubicBezierPoint = (
    p0: CursorPoint,
    p1: CursorPoint,
    p2: CursorPoint,
    p3: CursorPoint,
    t: number
): CursorPoint => {
    const oneMinusT = 1 - t;
    const oneMinusT2 = oneMinusT * oneMinusT;
    const t2 = t * t;
    return {
        x: oneMinusT2 * oneMinusT * p0.x + 3 * oneMinusT2 * t * p1.x + 3 * oneMinusT * t2 * p2.x + t2 * t * p3.x,
        y: oneMinusT2 * oneMinusT * p0.y + 3 * oneMinusT2 * t * p1.y + 3 * oneMinusT * t2 * p2.y + t2 * t * p3.y
    };
};

const generateSegment = (from: CursorPoint, to: CursorPoint, stepCount: number): CursorPoint[] => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const unitX = dx / distance;
    const unitY = dy / distance;
    const perpX = -unitY;
    const perpY = unitX;
    const bend = clamp(distance * randomBetween(0.18, 0.3), 16, 130) * (Math.random() < 0.5 ? -1 : 1);

    const p1: CursorPoint = {
        x: from.x + dx * randomBetween(0.22, 0.34) + perpX * bend,
        y: from.y + dy * randomBetween(0.22, 0.34) + perpY * bend
    };
    const p2: CursorPoint = {
        x: from.x + dx * randomBetween(0.64, 0.82) - perpX * bend * randomBetween(0.35, 0.65),
        y: from.y + dy * randomBetween(0.64, 0.82) - perpY * bend * randomBetween(0.35, 0.65)
    };

    const points: CursorPoint[] = [];
    for (let i = 1; i <= stepCount; i++) {
        const rawT = i / stepCount;
        const t = easeInOutCubic(rawT);
        points.push(cubicBezierPoint(from, p1, p2, to, t));
    }
    return points;
};

export const generateHumanCursorPath = (from: CursorPoint, to: CursorPoint): CursorPath => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const baseSteps = clamp(Math.round(distance / 14), 12, 64);
    let durationMs = clamp(Math.round(170 + distance * 0.95), 220, 960);

    const shouldOvershoot = distance > 140 && Math.random() < 0.32;
    if (!shouldOvershoot) {
        return {
            points: generateSegment(from, to, baseSteps),
            durationMs
        };
    }

    const unitX = dx / distance;
    const unitY = dy / distance;
    const perpX = -unitY;
    const perpY = unitX;
    const overshootDistance = randomBetween(8, 26);
    const overshootPoint: CursorPoint = {
        x: to.x + unitX * overshootDistance + perpX * randomBetween(-8, 8),
        y: to.y + unitY * overshootDistance + perpY * randomBetween(-8, 8)
    };

    const first = generateSegment(from, overshootPoint, baseSteps);
    const second = generateSegment(overshootPoint, to, clamp(Math.round(baseSteps * 0.45), 6, 24));
    durationMs += 120;
    return {
        points: [...first, ...second],
        durationMs
    };
};

export const ensureVisualCursor = async (page: Page, initial: CursorPoint) => {
    await page.evaluate(({ cursorId, styleId, initialPoint }) => {
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #${cursorId} {
                    position: fixed;
                    width: 14px;
                    height: 14px;
                    border-radius: 999px;
                    background: #22d3ee;
                    border: 1px solid rgba(255, 255, 255, 0.9);
                    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.28), 0 8px 18px rgba(2, 6, 23, 0.42);
                    pointer-events: none;
                    transform: translate(-120px, -120px);
                    z-index: 2147483647;
                    transition: transform 0s linear;
                }
                .drive-ghost-ripple {
                    position: fixed;
                    pointer-events: none;
                    border-radius: 999px;
                    border: 2px solid rgba(34, 211, 238, 0.88);
                    background: rgba(34, 211, 238, 0.22);
                    transform-origin: center;
                    z-index: 2147483647;
                    animation-name: drive-ghost-ripple;
                    animation-timing-function: ease-out;
                    animation-fill-mode: forwards;
                }
                @keyframes drive-ghost-ripple {
                    0% {
                        transform: scale(0.2);
                        opacity: 0.95;
                    }
                    100% {
                        transform: scale(1.2);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        let cursor = document.getElementById(cursorId);
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.id = cursorId;
            document.body.appendChild(cursor);
        }

        cursor.style.transform = `translate(${initialPoint.x}px, ${initialPoint.y}px)`;
        document.body.appendChild(cursor);
    }, {
        cursorId: CURSOR_ID,
        styleId: CURSOR_STYLE_ID,
        initialPoint: initial
    });
};

export const moveVisualCursor = async (page: Page, point: CursorPoint) => {
    await page.evaluate(({ cursorId, next }) => {
        const cursor = document.getElementById(cursorId);
        if (!cursor) return;
        cursor.style.transform = `translate(${next.x}px, ${next.y}px)`;
        document.body.appendChild(cursor);
    }, {
        cursorId: CURSOR_ID,
        next: point
    });
};

export const showCursorClickEffect = async (page: Page, point: CursorPoint, phase: ClickPhase = 'down') => {
    await page.evaluate(({ next, clickPhase }) => {
        const ripple = document.createElement('div');
        ripple.className = 'drive-ghost-ripple';

        const size = clickPhase === 'down' ? 18 : 26;
        const duration = clickPhase === 'down' ? 180 : 260;
        const offset = Math.round(size / 2);

        ripple.style.left = `${Math.round(next.x) - offset}px`;
        ripple.style.top = `${Math.round(next.y) - offset}px`;
        ripple.style.width = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.animationDuration = `${duration}ms`;

        if (clickPhase === 'up') {
            ripple.style.background = 'rgba(34, 211, 238, 0.1)';
            ripple.style.borderColor = 'rgba(34, 211, 238, 0.72)';
        }

        document.body.appendChild(ripple);
        setTimeout(() => ripple.remove(), duration + 60);
    }, {
        next: point,
        clickPhase: phase
    });
};
