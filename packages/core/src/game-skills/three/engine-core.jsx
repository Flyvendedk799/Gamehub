// when_to_use: The engine core for any Three.js game that needs a real game
// loop — deterministic fixed-timestep simulation, frame-rate-independent
// movement, pause/slow-mo, leak-proof disposal, and the window.__game platform
// contract (rebindable controls, live tweak params, debug snapshot, score)
// wired correctly. Prefer this over hand-rolling requestAnimationFrame; use
// three/game-loop.jsx only for a trivial single-mesh scene.
//
// GENERATED from engine3d — do not edit by hand.
// Source: packages/engine3d/src/*.ts (unit-tested), packages/engine3d/runtime/three-adapter.js
// Regenerate: pnpm emit

// ── now ──────────────────────────────────────────────────────

/**
 * The engine's clock source, defined exactly once.
 *
 * Three modules need "what time is it" and each used to carry its own copy.
 * That reads fine as TypeScript — but the modules are concatenated into a
 * single-scope ES module when emitted as the `three/engine-core.jsx` game-skill,
 * where duplicate top-level declarations are a hard `SyntaxError`. One shared
 * definition is both better design and the shippable one.
 */
/** `performance.now()` where available, falling back to `Date.now()`. */
export function defaultNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

// ── frame-clock ──────────────────────────────────────────────

/**
 * Frame clock — the engine's single source of time.
 *
 * Generated games are written by an agent and run unattended in a sandboxed
 * iframe, so the loop has to survive conditions the author never tested:
 * a background tab, a GC hitch, a breakpoint, a slow phone. This clock makes
 * those cases boring instead of catastrophic:
 *
 *  - **spike clamping** — one long frame advances the sim by at most
 *    `maxFrameSeconds`, so a stall never teleports the player through a wall.
 *  - **pause / time scale** — one knob for tab-hidden, hit-stop and slow-mo,
 *    instead of `dt = 0` special cases sprinkled through gameplay code.
 *  - **fixed timestep + interpolation alpha** — simulation stays deterministic
 *    and framerate-independent; rendering blends between the last two steps.
 *  - **catch-up clamping** — after a stall, run at most `maxCatchUpSteps` and
 *    drop the rest. Without this, each slow frame owes more steps than the last
 *    and the page locks up (the "spiral of death").
 *
 * Pure: no DOM, no THREE, no globals — unit testable in plain node.
 */
export const FRAME_CLOCK_VERSION = 'frame-clock.v1';
const DEFAULT_MAX_FRAME_SECONDS = 0.05;
const DEFAULT_FIXED_STEP_SECONDS = 1 / 60;
const DEFAULT_MAX_CATCH_UP_STEPS = 5;
function finite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function createFrameClock(options = {}) {
    const maxFrameSeconds = Math.max(1e-4, finite(options.maxFrameSeconds, DEFAULT_MAX_FRAME_SECONDS));
    const fixedStepSeconds = Math.max(1e-4, finite(options.fixedStepSeconds, DEFAULT_FIXED_STEP_SECONDS));
    const maxCatchUpSteps = Math.max(1, Math.floor(finite(options.maxCatchUpSteps, DEFAULT_MAX_CATCH_UP_STEPS)));
    let timeScale = Math.max(0, finite(options.timeScale, 1));
    let frame = 0;
    let wallElapsed = 0;
    let elapsed = 0;
    let rawDelta = 0;
    let delta = 0;
    let accumulator = 0;
    let alpha = 0;
    let steps = 0;
    let droppedSteps = 0;
    let paused = false;
    let lastNowMs = null;
    function currentTick() {
        return { frame, delta, rawDelta, elapsed, steps, alpha, droppedSteps };
    }
    return {
        tick(nowMs) {
            const now = finite(nowMs, lastNowMs ?? 0);
            if (lastNowMs === null)
                lastNowMs = now;
            // Never negative: clock adjustments or a bogus timestamp must not rewind.
            rawDelta = Math.max(0, (now - lastNowMs) / 1000);
            lastNowMs = now;
            wallElapsed += rawDelta;
            const clamped = Math.min(rawDelta, maxFrameSeconds);
            delta = paused ? 0 : clamped * timeScale;
            elapsed += delta;
            frame += 1;
            accumulator += delta;
            let pending = Math.floor(accumulator / fixedStepSeconds);
            droppedSteps = 0;
            if (pending > maxCatchUpSteps) {
                droppedSteps = pending - maxCatchUpSteps;
                pending = maxCatchUpSteps;
                // Discard the unpayable debt instead of trying (and failing) to repay it.
                accumulator = 0;
            }
            else if (pending > 0) {
                accumulator -= pending * fixedStepSeconds;
            }
            steps = pending;
            alpha = Math.min(1, Math.max(0, accumulator / fixedStepSeconds));
            return currentTick();
        },
        forEachFixedStep(fn) {
            for (let i = 0; i < steps; i++)
                fn(fixedStepSeconds, i);
            return steps;
        },
        setPaused(next) {
            paused = !!next;
            return paused;
        },
        isPaused: () => paused,
        setTimeScale(scale) {
            timeScale = Math.max(0, finite(scale, timeScale));
            return timeScale;
        },
        getTimeScale: () => timeScale,
        resetDelta() {
            lastNowMs = null;
            accumulator = 0;
            alpha = 0;
            steps = 0;
        },
        reset() {
            frame = 0;
            wallElapsed = 0;
            elapsed = 0;
            rawDelta = 0;
            delta = 0;
            accumulator = 0;
            alpha = 0;
            steps = 0;
            droppedSteps = 0;
            lastNowMs = null;
        },
        snapshot() {
            return {
                version: FRAME_CLOCK_VERSION,
                ...currentTick(),
                wallElapsed,
                paused,
                timeScale,
                fixedStepSeconds,
                maxFrameSeconds,
                maxCatchUpSteps,
            };
        },
    };
}

// ── system-scheduler ─────────────────────────────────────────

/**
 * System scheduler — declarative, measured, fault-isolated update order.
 *
 * An agent-written game grows by appending update calls to a loop; nothing keeps
 * ordering explicit, nothing reports cost, and one bad line kills every frame
 * after it. This turns the loop into named systems with:
 *
 *  - explicit `phase` + `order` instead of implicit source-line order
 *  - per-system timing, so "what costs the frame" is data, not a guess
 *  - **fault isolation** — a throwing system cannot kill the frame, and one that
 *    keeps throwing is quarantined instead of spamming the console forever.
 *    This matters more here than in a hand-written game: generated code fails in
 *    ways the author never saw, and a published game must degrade, not die.
 *  - runtime enable/disable for A/B and profiling
 *
 * Pure: no DOM, no THREE, no globals — unit testable in plain node.
 */

export const SYSTEM_SCHEDULER_VERSION = 'system-scheduler.v1';
/** Default execution order. `render` runs last so it sees the settled state. */
export const DEFAULT_PHASES = ['input', 'simulate', 'animate', 'viewmodel', 'render'];
const DEFAULT_FAULT_LIMIT = 3;
export function createSystemScheduler(options = {}) {
    const phases = options.phases?.length
        ? [...options.phases]
        : DEFAULT_PHASES;
    const faultLimit = Math.max(1, Math.floor(options.faultLimit ?? DEFAULT_FAULT_LIMIT));
    const now = options.now ?? defaultNow;
    const byPhase = new Map(phases.map((p) => [p, []]));
    const byName = new Map();
    return {
        phases,
        add(spec) {
            if (typeof spec?.fn !== 'function')
                throw new Error(`system "${spec?.name ?? '?'}" needs a fn`);
            if (!spec.name)
                throw new Error('system needs a name');
            const list = byPhase.get(spec.phase);
            if (!list)
                throw new Error(`unknown phase "${spec.phase}" (have: ${phases.join(', ')})`);
            if (byName.has(spec.name))
                throw new Error(`duplicate system "${spec.name}"`);
            const state = {
                name: spec.name,
                phase: spec.phase,
                fn: spec.fn,
                order: typeof spec.order === 'number' && Number.isFinite(spec.order) ? spec.order : 0,
                enabled: spec.enabled !== false,
                lastMs: 0,
                emaMs: 0,
                calls: 0,
                faults: 0,
                consecutiveFaults: 0,
                quarantined: false,
                lastError: null,
            };
            byName.set(spec.name, state);
            list.push(state);
            list.sort((a, b) => a.order - b.order);
        },
        run(phase, ctx) {
            const list = byPhase.get(phase);
            if (!list)
                return { phase, ran: 0, ms: 0, faults: 0 };
            const phaseStart = now();
            let ran = 0;
            let faults = 0;
            for (const system of list) {
                if (!system.enabled || system.quarantined)
                    continue;
                const started = now();
                try {
                    system.fn(ctx);
                    system.consecutiveFaults = 0;
                }
                catch (error) {
                    faults++;
                    system.faults++;
                    system.consecutiveFaults++;
                    system.lastError = error instanceof Error ? error.message : String(error);
                    if (system.consecutiveFaults >= faultLimit) {
                        system.quarantined = true;
                        options.onQuarantine?.(system.name, system.lastError);
                    }
                }
                const ms = now() - started;
                system.lastMs = ms;
                system.emaMs = system.emaMs * 0.9 + ms * 0.1;
                system.calls++;
                ran++;
            }
            return { phase, ran, ms: now() - phaseStart, faults };
        },
        setEnabled(name, enabled) {
            const system = byName.get(name);
            if (!system)
                return false;
            system.enabled = !!enabled;
            if (enabled) {
                system.quarantined = false;
                system.consecutiveFaults = 0;
            }
            return true;
        },
        has: (name) => byName.has(name),
        snapshot() {
            const systems = [...byName.values()]
                .map((s) => ({
                name: s.name,
                phase: s.phase,
                order: s.order,
                enabled: s.enabled,
                quarantined: s.quarantined,
                lastMs: Number(s.lastMs.toFixed(3)),
                emaMs: Number(s.emaMs.toFixed(3)),
                calls: s.calls,
                faults: s.faults,
                lastError: s.lastError,
            }))
                .sort((a, b) => b.emaMs - a.emaMs);
            return {
                version: SYSTEM_SCHEDULER_VERSION,
                phases: [...phases],
                count: systems.length,
                systems,
            };
        },
    };
}

// ── resource-scope ───────────────────────────────────────────

/**
 * Resource scope — one owner for everything that must be released.
 *
 * WebGL resources are not garbage collected: geometries, materials, textures and
 * render targets leak until `.dispose()` is called, and event listeners keep
 * whole scenes alive. In a hub where a player opens game after game in the same
 * tab — and where the code was written by an agent that never profiled it — that
 * is the single most damaging bug class available.
 *
 * So the engine owns lifetime instead of trusting the author to remember:
 *
 *   const scope = createResourceScope();
 *   scope.track(geometry); scope.track(material);
 *   scope.own(scene);                       // traverses + collects children
 *   scope.addEventListener(window, 'resize', onResize);
 *   scope.setInterval(spawnWave, 2000);
 *   scope.disposeAll();                     // one call releases all of it
 *
 * Everything is structurally typed: no `three` import, so this unit tests
 * headless and works against any object exposing `dispose()`.
 */
export const RESOURCE_SCOPE_VERSION = 'resource-scope.v1';
function isDisposable(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.dispose === 'function');
}
export function createResourceScope(options = {}) {
    const timers = options.timers ?? globalThis;
    const disposables = new Set();
    const listeners = [];
    const intervalIds = [];
    const timeoutIds = [];
    const customs = [];
    let disposed = false;
    let disposeErrors = 0;
    function report(error, kind) {
        disposeErrors++;
        options.onError?.(error, kind);
    }
    function collectMaterial(material) {
        if (!material)
            return;
        const list = Array.isArray(material) ? material : [material];
        for (const entry of list) {
            if (!isDisposable(entry))
                continue;
            disposables.add(entry);
            // Texture maps hang off materials; collect any disposable-valued property.
            for (const value of Object.values(entry)) {
                if (isDisposable(value))
                    disposables.add(value);
            }
        }
    }
    const scope = {
        get disposed() {
            return disposed;
        },
        track(resource) {
            if (isDisposable(resource))
                disposables.add(resource);
            return resource;
        },
        own(root) {
            const visit = (node) => {
                if (isDisposable(node.geometry))
                    disposables.add(node.geometry);
                collectMaterial(node.material);
            };
            if (typeof root.traverse === 'function')
                root.traverse(visit);
            else
                visit(root);
            return root;
        },
        addEventListener(target, type, listener, opts) {
            target.addEventListener(type, listener, opts);
            const entry = { target, type, listener, ...(opts === undefined ? {} : { options: opts }) };
            listeners.push(entry);
            return () => {
                const index = listeners.indexOf(entry);
                if (index >= 0)
                    listeners.splice(index, 1);
                try {
                    target.removeEventListener(type, listener, opts);
                }
                catch (error) {
                    report(error, 'listener');
                }
            };
        },
        setInterval(handler, ms) {
            const id = timers.setInterval(handler, ms);
            intervalIds.push(id);
            return id;
        },
        setTimeout(handler, ms) {
            const id = timers.setTimeout(handler, ms);
            timeoutIds.push(id);
            return id;
        },
        onDispose(cleanup) {
            if (typeof cleanup === 'function')
                customs.push(cleanup);
        },
        disposeAll() {
            if (disposed)
                return scope.stats();
            disposed = true;
            for (const entry of listeners) {
                try {
                    entry.target.removeEventListener(entry.type, entry.listener, entry.options);
                }
                catch (error) {
                    report(error, 'listener');
                }
            }
            listeners.length = 0;
            for (const id of intervalIds) {
                try {
                    timers.clearInterval(id);
                }
                catch (error) {
                    report(error, 'interval');
                }
            }
            intervalIds.length = 0;
            for (const id of timeoutIds) {
                try {
                    timers.clearTimeout(id);
                }
                catch (error) {
                    report(error, 'timeout');
                }
            }
            timeoutIds.length = 0;
            for (const resource of disposables) {
                try {
                    resource.dispose();
                }
                catch (error) {
                    report(error, 'dispose');
                }
            }
            disposables.clear();
            // Custom cleanups run last: they may depend on the above being gone.
            for (const cleanup of customs) {
                try {
                    cleanup();
                }
                catch (error) {
                    report(error, 'custom');
                }
            }
            customs.length = 0;
            return scope.stats();
        },
        stats() {
            return {
                version: RESOURCE_SCOPE_VERSION,
                disposables: disposables.size,
                listeners: listeners.length,
                timers: intervalIds.length + timeoutIds.length,
                customs: customs.length,
                disposed,
                disposeErrors,
            };
        },
    };
    return scope;
}

// ── playerzero-bridge ────────────────────────────────────────

/**
 * PlayerZero bridge — the platform contract, wired once, correctly.
 *
 * A generated game lives inside the sandboxed iframe and talks to the host only
 * through `window.__game` (see `gameGlobalSetupSnippet` in
 * `@playforge/runtime/engines/types`). Three of those surfaces are load-bearing
 * and all three were being missed by hand-authored games:
 *
 *  - **`debug.track()`** — the deterministic verdict layer reads
 *    `__game.debug.snapshot()`. When nothing is wired it returns `null`, every
 *    predicate reports "field missing", and a game can never earn a play
 *    verdict (`debugSnapshot=0` in 8/8 of the runs in docs/ENGINE_EVOLUTION_V2).
 *    A game built on this engine wires it as a side effect of declaring state,
 *    so the verdict layer has something real to read.
 *  - **`controls.define()`** — input read through the platform layer is
 *    rebindable from the host's Controls tab for free. Games that attach their
 *    own `keydown` handlers silently opt out of that.
 *  - **`world.triggers` + `world.colliders`** — the Three validator warns when
 *    triggers are exposed without colliders, because the reachability check
 *    goes dormant. `setWorld()` takes both together, so the shape that produces
 *    the warning is not expressible.
 *
 * Everything is structurally typed and injectable: no DOM and no THREE import,
 * so this unit tests headless against a fake `__game`.
 */
export const PLAYERZERO_BRIDGE_VERSION = 'playerzero-bridge.v1';
function resolveGame(explicit) {
    if (explicit)
        return explicit;
    const found = globalThis.__game;
    return typeof found === 'object' && found !== null ? found : undefined;
}
export function createPlayerZeroBridge(options = {}) {
    const game = resolveGame(options.game);
    const host = options.host ??
        (typeof globalThis.addEventListener === 'function'
            ? globalThis
            : undefined);
    // Action handlers are held here rather than only in the shim so an
    // unsubscribe works even though `controls.on` offers no `off`.
    const handlers = new Map();
    const boundActions = new Set();
    let disposed = false;
    function ensureBound(actionId) {
        if (boundActions.has(actionId) || !game?.controls)
            return;
        boundActions.add(actionId);
        game.controls.on(actionId, () => {
            if (disposed)
                return;
            for (const fn of handlers.get(actionId) ?? []) {
                // One bad listener must not stop the others, or block input entirely.
                try {
                    fn();
                }
                catch {
                    /* a throwing handler is not fatal */
                }
            }
        });
    }
    let paramsListener = null;
    if (options.onParamsChanged && host) {
        paramsListener = () => {
            if (disposed)
                return;
            options.onParamsChanged?.(game?.params ?? {});
        };
        host.addEventListener('game:params-changed', paramsListener);
    }
    const bridge = {
        get connected() {
            return game !== undefined;
        },
        get params() {
            return game?.params ?? {};
        },
        get startMuted() {
            return game?.config?.['startMuted'] === true;
        },
        param(key, fallback) {
            const value = game?.params?.[key];
            if (typeof value !== typeof fallback)
                return fallback;
            // A NaN/Infinity slider value would silently poison the simulation.
            if (typeof value === 'number' && !Number.isFinite(value))
                return fallback;
            return value;
        },
        defineControls(actions) {
            if (!game?.controls)
                return;
            game.controls.define({ actions: actions.map((action) => ({ ...action })) });
            // A `define` resets the shim's handler tables, so rebind ours after it.
            boundActions.clear();
            for (const actionId of handlers.keys())
                ensureBound(actionId);
        },
        isDown(actionId) {
            try {
                return game?.controls?.isDown(actionId) === true;
            }
            catch {
                return false;
            }
        },
        onAction(actionId, fn) {
            let set = handlers.get(actionId);
            if (!set) {
                set = new Set();
                handlers.set(actionId, set);
            }
            set.add(fn);
            ensureBound(actionId);
            return () => {
                set?.delete(fn);
            };
        },
        trackDebug(spec) {
            if (!game?.debug || typeof game.debug.track !== 'function')
                return;
            game.debug.track(spec);
        },
        setState(patch) {
            if (!game)
                return;
            game.state = { ...(game.state ?? {}), ...patch };
        },
        setWorld(world) {
            if (!game)
                return;
            game.world = { triggers: world.triggers, colliders: world.colliders };
        },
        reportScore(score) {
            const value = Number(score);
            if (!Number.isFinite(value))
                return;
            try {
                game?.reportScore?.(value);
            }
            catch {
                /* cross-origin parent may throw */
            }
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            if (paramsListener && host)
                host.removeEventListener('game:params-changed', paramsListener);
            paramsListener = null;
            handlers.clear();
            boundActions.clear();
        },
    };
    if (options.actions?.length)
        bridge.defineControls(options.actions);
    if (options.debug)
        bridge.trackDebug(options.debug);
    return bridge;
}

// ── game-loop ────────────────────────────────────────────────

/**
 * Game loop — the one object an agent-authored game talks to.
 *
 * Wraps the clock, scheduler and resource scope so a generated game gets the
 * safe behaviour by default instead of by remembering:
 *
 *   const game = createGameLoop({ render: (alpha) => renderer.render(scene, camera) });
 *   game.addSystem({ name: 'player', phase: 'simulate', fn: ({ step }) => movePlayer(step) });
 *   game.resources.own(scene);
 *   game.start();
 *   // later, or on hot-reload / navigation:
 *   game.dispose();
 *
 * Deliberate choices for this platform:
 *  - **`simulate` runs on the fixed step, everything else per frame.** Physics
 *    stays deterministic; animation and render stay smooth via `alpha`.
 *  - **auto-pause when the tab is hidden** — a backgrounded game must not burn
 *    the player's battery or bank up a huge catch-up debt.
 *  - **one `dispose()`** tears down the loop, listeners, timers and GPU
 *    resources, so the hub can swap games in a single tab without leaking.
 *  - **errors never kill the page** — a throwing system is quarantined and the
 *    loop keeps running, so a published game degrades instead of white-screening.
 *
 * No THREE import: `render` is a callback, so this unit tests headless.
 */

export const GAME_LOOP_VERSION = 'game-loop.v1';
export function createGameLoop(options = {}) {
    const now = options.now ?? defaultNow;
    const requestFrame = options.requestFrame ??
        ((cb) => {
            const raf = globalThis
                .requestAnimationFrame;
            return raf ? raf(cb) : setTimeout(() => cb(now()), 16);
        });
    const cancelFrame = options.cancelFrame ??
        ((handle) => {
            const caf = globalThis
                .cancelAnimationFrame;
            if (caf)
                caf(handle);
            else
                clearTimeout(handle);
        });
    const clock = createFrameClock(options);
    const resources = createResourceScope();
    const systems = createSystemScheduler({
        ...(options.onSystemFault ? { onQuarantine: options.onSystemFault } : {}),
    });
    let running = false;
    let disposed = false;
    let frameHandle = null;
    /** Paused by the author, tracked separately from visibility auto-pause. */
    let manualPaused = false;
    const visibility = options.visibility ??
        (typeof document !== 'undefined'
            ? document
            : undefined);
    const pauseWhenHidden = options.pauseWhenHidden !== false;
    function applyPaused() {
        const hidden = pauseWhenHidden && visibility ? visibility.hidden === true : false;
        clock.setPaused(manualPaused || hidden);
    }
    if (pauseWhenHidden && visibility) {
        const onVisibility = () => {
            // Coming back from hidden: drop the accumulated wall time so the game does
            // not try to simulate the entire time the tab was in the background.
            if (visibility.hidden !== true)
                clock.resetDelta();
            applyPaused();
        };
        visibility.addEventListener('visibilitychange', onVisibility);
        resources.onDispose(() => visibility.removeEventListener('visibilitychange', onVisibility));
    }
    function runFrame(nowMs) {
        if (disposed)
            return;
        const tick = clock.tick(nowMs);
        const base = {
            step: tick.delta,
            delta: tick.delta,
            alpha: tick.alpha,
            elapsed: tick.elapsed,
            frame: tick.frame,
        };
        systems.run('input', base);
        // Fixed-step simulation: deterministic regardless of display rate.
        clock.forEachFixedStep((stepSeconds) => {
            systems.run('simulate', { ...base, step: stepSeconds });
        });
        systems.run('animate', base);
        systems.run('viewmodel', base);
        systems.run('render', base);
        if (options.render) {
            try {
                options.render(tick.alpha, base);
            }
            catch (error) {
                // A render throw must not kill the RAF chain.
                options.onSystemFault?.('render', error instanceof Error ? error.message : String(error));
            }
        }
    }
    function scheduleNext() {
        if (!running || disposed)
            return;
        frameHandle = requestFrame((nowMs) => {
            if (!running || disposed)
                return;
            runFrame(nowMs);
            scheduleNext();
        });
    }
    const loop = {
        clock,
        systems,
        resources,
        addSystem(spec) {
            systems.add(spec);
        },
        setSystemEnabled: (name, enabled) => systems.setEnabled(name, enabled),
        start() {
            if (running || disposed)
                return;
            running = true;
            // Fresh delta so a long gap before start() is not simulated.
            clock.resetDelta();
            applyPaused();
            scheduleNext();
        },
        stop() {
            running = false;
            if (frameHandle !== null) {
                cancelFrame(frameHandle);
                frameHandle = null;
            }
        },
        tick(nowMs) {
            runFrame(nowMs);
        },
        setPaused(paused) {
            manualPaused = !!paused;
            applyPaused();
            return clock.isPaused();
        },
        setTimeScale: (scale) => clock.setTimeScale(scale),
        dispose() {
            if (disposed)
                return;
            loop.stop();
            disposed = true;
            resources.disposeAll();
        },
        snapshot() {
            return {
                version: GAME_LOOP_VERSION,
                running,
                disposed,
                clock: clock.snapshot(),
                systems: systems.snapshot(),
                resources: resources.stats(),
            };
        },
    };
    return loop;
}

// ── Three.js binding ────────────────────────────────────────────────────────
// The parts above are engine-agnostic and unit-tested in this repo.
// This section is the thin layer that binds them to a real renderer and to the
// platform's `window.__game` contract.

import * as THREE from 'three';

/**
 * Boot a complete, correctly-wired Three.js game.
 *
 *   const game = createGame({
 *     actions: [{ id: 'jump', label: 'Jump', keys: ['Space'] }],
 *     debug:   { player: () => player, score: () => score },
 *   });
 *   game.onSimulate((step) => { ... });   // fixed timestep — physics
 *   game.onAnimate((dt, alpha) => { ... }); // per frame — visuals
 *   game.start();
 *
 * Returns `{ scene, camera, renderer, loop, bridge, resources, dispose }`.
 */
export function createGame(options = {}) {
  const canvas =
    options.canvas ?? (typeof document !== 'undefined' ? document.getElementById('game') : null);
  if (!canvas)
    throw new Error(
      'createGame: no <canvas> found (pass options.canvas or add <canvas id="game">)',
    );

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: options.antialias !== false,
    // Required by the platform: a WebGL canvas reads as blank to the thumbnail
    // screenshot and the juice motion meter without a preserved drawing buffer.
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Uncapped DPR is a phone-killer: a 3x display quadruples the fragment cost
  // for no visible gain at these art densities.
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, options.maxPixelRatio ?? 2));

  const scene = options.scene ?? new THREE.Scene();
  const camera =
    options.camera ??
    new THREE.PerspectiveCamera(options.fov ?? 60, 1, options.near ?? 0.1, options.far ?? 200);

  const bridge = createPlayerZeroBridge({
    actions: options.actions,
    debug: options.debug,
    onParamsChanged: options.onParamsChanged,
  });

  const loop = createGameLoop({
    fixedStepSeconds: options.fixedStepSeconds,
    maxFrameSeconds: options.maxFrameSeconds,
    maxCatchUpSteps: options.maxCatchUpSteps,
    pauseWhenHidden: options.pauseWhenHidden,
    onSystemFault:
      options.onSystemFault ??
      ((name, error) => {
        // Visible in the iframe error overlay without killing the frame.
        console.warn('[engine3d] system quarantined:', name, error);
      }),
    render: () => renderer.render(scene, camera),
  });

  // Deliberately the loop's scope, not a second one: `loop.dispose()` releases
  // exactly what this scope owns, so there is a single owner and a single
  // teardown. Two scopes would silently leak whichever one nobody disposed.
  const resources = loop.resources;
  resources.track(renderer);

  function resize() {
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    // `false` — never let three write CSS size back onto the canvas; the host
    // controls layout and the aspect box.
    renderer.setSize(width, height, false);
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  resize();
  // Registered in the direct form on purpose: the Three adapter's validator
  // scans for a literal `addEventListener('resize'` to prove the game reacts to
  // its container. Ownership is kept by handing the removal to the scope.
  // Guarded because headless harnesses (validation, playtest tooling) may load
  // this module without a DOM-bearing global.
  const listenerHost = typeof globalThis.addEventListener === 'function' ? globalThis : null;
  if (listenerHost) {
    listenerHost.addEventListener('resize', resize);
    resources.onDispose(() => listenerHost.removeEventListener('resize', resize));
  }

  let userSystems = 0;

  const game = {
    scene,
    camera,
    renderer,
    loop,
    bridge,
    resources,

    /** Fixed-timestep update. Put movement, physics and collisions here. */
    onSimulate(fn, opts) {
      loop.addSystem({
        name: opts?.name || `simulate:${++userSystems}`,
        phase: 'simulate',
        order: opts?.order || 0,
        fn: (ctx) => fn(ctx.step, ctx),
      });
      return game;
    },

    /** Per-frame update. Put tweens, particles and camera work here. */
    onAnimate(fn, opts) {
      loop.addSystem({
        name: opts?.name || `animate:${++userSystems}`,
        phase: 'animate',
        order: opts?.order || 0,
        fn: (ctx) => fn(ctx.delta, ctx.alpha, ctx),
      });
      return game;
    },

    /** Take ownership of a subtree so dispose() releases its GPU memory. */
    add(object3d) {
      scene.add(object3d);
      resources.own(object3d);
      return object3d;
    },

    isDown: (actionId) => bridge.isDown(actionId),
    onAction: (actionId, fn) => bridge.onAction(actionId, fn),
    param: (key, fallback) => bridge.param(key, fallback),
    setState: (patch) => bridge.setState(patch),
    setWorld: (world) => bridge.setWorld(world),
    reportScore: (score) => bridge.reportScore(score),

    start() {
      loop.start();
      return game;
    },
    stop() {
      loop.stop();
      return game;
    },
    setPaused: (paused) => loop.setPaused(paused),
    setTimeScale: (scale) => loop.setTimeScale(scale),
    snapshot: () => loop.snapshot(),

    /** Release the loop, listeners, timers and every GPU resource. */
    dispose() {
      bridge.dispose();
      loop.dispose(); // stops RAF, then disposes the shared resource scope
    },
  };

  // A preview iframe is torn down by navigation, not by an unload handler the
  // game remembered to write — so wire it here, once.
  if (listenerHost) resources.addEventListener(listenerHost, 'pagehide', () => game.dispose());

  return game;
}

// Usage:
//   import { createGame } from './engine-core.js';
//   import * as THREE from 'three';
//
//   const game = createGame({
//     actions: [
//       { id: 'left',  label: 'Move left',  keys: ['ArrowLeft', 'KeyA'] },
//       { id: 'right', label: 'Move right', keys: ['ArrowRight', 'KeyD'] },
//       { id: 'fire',  label: 'Fire',       keys: ['Space', 'Mouse0'] },
//     ],
//     debug: { player: () => player, score: () => score },
//   });
//
//   const player = game.add(new THREE.Mesh(
//     new THREE.BoxGeometry(1, 1, 1),
//     new THREE.MeshStandardMaterial({ color: 0x44aa88 }),
//   ));
//   game.add(new THREE.DirectionalLight(0xffffff, 2));
//   game.camera.position.set(0, 2, 6);
//
//   let score = 0;
//   game.onAction('fire', () => { score += 1; game.setState({ score }); });
//   game.onSimulate((step) => {
//     const speed = game.param('move_speed', 6);
//     if (game.isDown('left'))  player.position.x -= speed * step;
//     if (game.isDown('right')) player.position.x += speed * step;
//   });
//   game.start();

