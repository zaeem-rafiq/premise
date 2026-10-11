// The Floor app: `render(FloorState, ViewState, clock)` (FL1). Live mode, a snapshot and
// Replay draw the same components of the same `FloorState` (FE4). The pool area and the rail are
// regions of the view, imported directly; named views and sheets resolve through the registry's
// tags (the contract of `registry.ts`, the merge of `bindings.tsx`).
//
// The shell owns the layout frame of 2.1-2.10 (header, banners, strip, body, Replay bar),
// the owner session of 3.17 (FR21 expiry included), the theme and size of 6.3 (kept in the
// browser; the size otherwise follows the window width) and the keyboard map of 6.6.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FloorJson } from "../../protocol/floor-json.ts";
import type { FloorState } from "../../protocol/reducer/state.ts";
import type { RegistryEntry, RegistryTable } from "./registry.ts";
import { parseRoute, poolRoute, type Route } from "./route.ts";
import { showStartCard } from "./start-card.ts";
import { needsCards } from "./needs.ts";
import { ShellContext, makeShell } from "./context.ts";
import { pauseNextReplay, useSession } from "./session.ts";
import { useKeys, type KeyEvent } from "../keys/keys.ts";
import { bannerList, capReached, quietPool, stripCells } from "../state/derive.ts";
import type { SheetTarget, Toast } from "../state/view-state.ts";
import { Header } from "./header.tsx";
import { Strip } from "../components/strip/strip.tsx";
import { Banners } from "../components/banners/banners.tsx";
import { RebuildDialog } from "../components/banners/rebuild-dialog.tsx";
import { Toasts } from "../components/toast/toasts.tsx";
import { Announcer } from "../components/toast/announcer.tsx";
import { AboutSheet } from "../components/about/about.tsx";
import { OwnerDialog } from "../components/owner-key/owner-key.tsx";
import { KillDialog, allowAgents } from "../components/kill-switch/kill-switch.tsx";
import { SwarmView } from "../components/swarm/swarm.tsx";
import { PoolArea } from "../components/pool-frame/pool-area.tsx";
import { Rail } from "../components/rail/rail.tsx";
import { Overview } from "../components/overview/overview.tsx";
import { COMPONENTS, type RegistryComponent } from "./bindings.tsx";
import { ViewBoundary } from "./view-boundary.tsx";
import { ReplayBar } from "../replay/replay-bar.tsx";
import { ReplayMenu } from "../replay/replay-menu.tsx";
import { defaultRecordingId, loadRecordingIndex, type RecordingIndex } from "../replay/player.ts";
import { replayError } from "../../copy/replay.ts";
import { errorSentence } from "../../copy/errors.ts";
import { text } from "../../copy/strings.ts";
import { sessionPath } from "../stream/urls.ts";
import { duration } from "../../copy/format.ts";

/** Calls the registered component, or null when the entry is missing or unbound. A `value` may be
 * the component itself or its entry's tag, which the merged records of `bindings.tsx` resolve —
 * the one place tags meet components (see `registry.ts`). */
function call(entry: RegistryEntry | undefined, props: Record<string, unknown>): React.ReactNode {
  if (entry === undefined) return null;
  const Component =
    typeof entry.value === "function"
      ? (entry.value as RegistryComponent)
      : typeof entry.value === "string"
        ? COMPONENTS[entry.value]
        : undefined;
  if (Component === undefined) return null;
  return <Component {...props} />;
}

let toastSeq = 0;

/** The page's own build id for `about.build` (RY12): the content hash of the served bundle's
 * file name (`/assets/index-<hash>.js`); "dev" while the dev server serves `./main.tsx` unhashed. */
function pageBuild(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? "";
  return /index-([A-Za-z0-9_-]+)\.js$/.exec(src)?.[1] ?? "dev";
}

/** `ViewState.theme`/`size` are kept in the browser (6.3, VD19) under these keys. */
const THEME_KEY = "premise.theme";
const SIZE_KEY = "premise.size";

function readTheme(): "dark" | "light" {
  try {
    const kept = window.localStorage.getItem(THEME_KEY);
    if (kept === "dark" || kept === "light") return kept;
  } catch {
    // storage can be off; the system setting is the fallback then
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readSize(): "stage" | "laptop" | null {
  try {
    const kept = window.localStorage.getItem(SIZE_KEY);
    if (kept === "stage" || kept === "laptop") return kept;
  } catch {
    // storage can be off
  }
  return null;
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage can be off
  }
}

export function FloorApp({ settings, table }: { settings: FloorJson; table: RegistryTable }) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  // 2.11: a live page opens on the view `/floor.json` names (the Overview on a deployment);
  // Replay opens on the Floor view, where the recording's beats play.
  const [view, setView] = useState<"floor" | "compare" | "swarm" | "overview">(() =>
    settings.default_view === "overview" && parseRoute(window.location.pathname).kind !== "replay"
      ? "overview"
      : "floor",
  );
  const [sheet, setSheet] = useState<SheetTarget>({ kind: "none" });
  const [owner, setOwner] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  // The type size follows the window width (2.1: stage from 1600); key Z overrides it and
  // the override is kept in the browser (VD19).
  const [sizePick, setSizePick] = useState<"stage" | "laptop" | null>(readSize);
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 1600px)").matches ?? false);
  const size = sizePick ?? (wide ? "stage" : "laptop");
  const [shortcuts, setShortcuts] = useState(true);
  // Reduced motion starts the pool frames paused (6.4, AC11).
  const [framesPaused, setFramesPaused] = useState(reducedMotion);
  const [startDismissed, setStartDismissed] = useState(false);
  const [replayIndex, setReplayIndex] = useState<RecordingIndex | null>(null);
  const [replayMenuOpen, setReplayMenuOpen] = useState(false);

  const replay = route.kind === "replay";
  const session = useSession(route, settings, reducedMotion);
  const swarmRoute = useMemo<Route>(() => ({ kind: "floor", pool: settings.swarm_pool }), [settings.swarm_pool]);
  const swarmSession = useSession(swarmRoute, settings, reducedMotion, !replay && view === "swarm");
  // RY12: while a recording is open, About names the page's own build and the build the
  // recording's header was made by.
  const aboutBuild =
    session.replay.phase === "ready"
      ? { page: pageBuild(), recording: session.replay.recording.header.build }
      : undefined;
  // FR10/CO3: while the connection is lost every owner control is off and the last
  // content keeps, dimmed. Replay never is "offline" - it plays a file, not a socket.
  const activeSession = !replay && view === "swarm" ? swarmSession : session;
  const connectionSession = session.connection === "lost" ? session : activeSession;
  const offline = !replay && connectionSession.connection === "lost";
  const shell = useMemo(() => makeShell(settings, owner, replay), [settings, owner, replay]);

  // ---- routing (client routes of 4.5; the page never reloads) ----
  const navigate = useCallback((path: string) => {
    if (path !== window.location.pathname) window.history.pushState(null, "", path);
    setRoute(parseRoute(path));
    setSheet({ kind: "none" });
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pool =
    route.kind === "replay"
      ? session.replay.phase === "ready"
        ? session.replay.recording.header.pool
        : ""
      : (route.pool ?? settings.default_pool);

  // ---- owner session: GET /api/session, live only (FE5: Replay asks for nothing else) ----
  useEffect(() => {
    if (replay) return;
    let gone = false;
    void (async () => {
      try {
        const response = await fetch(sessionPath());
        if (!gone && response.ok) {
          const body = (await response.json()) as { owner?: boolean };
          setOwner(body.owner === true);
        }
      } catch {
        // no Worker answers in this build: the page is a visitor's
      }
    })();
    return () => {
      gone = true;
    };
  }, [replay, route]);

  // ---- toasts + screen-reader lines the session collected ----
  const toastScope = route.kind === "replay" ? `replay:${route.id}` : `pool:${route.pool ?? settings.default_pool}`;
  useEffect(() => setToasts([]), [toastScope]);
  const fed = useRef({ effects: session.effects, toasts: 0 });
  useEffect(() => {
    if (fed.current.effects !== session.effects) fed.current = { effects: session.effects, toasts: 0 };
    const fresh = session.effects.toasts.slice(fed.current.toasts);
    fed.current.toasts = session.effects.toasts.length;
    if (fresh.length > 0) {
      setToasts((old) => [...old, ...fresh.map((text) => ({ id: ++toastSeq, text }))].slice(-3));
    }
  }, [session.effects, session.floor.n]);
  const dropToast = useCallback((id: number) => setToasts((old) => old.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (line: string) => setToasts((old) => [...old, { id: ++toastSeq, text: line }].slice(-3)),
    [],
  );

  // RY11: an event type the reducer does not know is counted (FE1) and reported once per
  // recording with `replay.unknown` — not an error, so a toast and no banner.
  const unknownReported = useRef<string | null>(null);
  useEffect(() => {
    if (route.kind !== "replay") {
      unknownReported.current = null;
      return;
    }
    const unknown = session.floor.unknown_events;
    if (session.replay.phase === "ready" && unknown > 0 && unknownReported.current !== route.id) {
      unknownReported.current = route.id;
      toast(text("replay.unknown", { n: unknown }));
    }
  }, [route, session.replay.phase, session.floor.unknown_events, toast]);

  // ---- sheets: openers are remembered so focus returns to them on close (AX4) ----
  const sheetOpener = useRef<HTMLElement | null>(null);
  const openSheet = useCallback((next: SheetTarget) => {
    sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSheet(next);
  }, []);
  const closeSheet = useCallback(() => setSheet({ kind: "none" }), []);
  useEffect(() => {
    if (sheet.kind === "none") {
      sheetOpener.current?.focus();
      sheetOpener.current = null;
    }
  }, [sheet.kind]);

  // ---- theme + size on the root element (6.3, 6.6) ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.size = size;
  }, [theme, size]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1600px)");
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // ---- the replay index, lazily (the menu and key R share it) ----
  const index = useRef<Promise<RecordingIndex | null> | null>(null);
  const getIndex = useCallback(() => {
    index.current ??= loadRecordingIndex(fetch).then(({ index }) => {
      setReplayIndex(index);
      return index;
    });
    return index.current;
  }, []);

  const openRecording = useCallback((id: string) => navigate(`/replay/${encodeURIComponent(id)}`), [navigate]);
  const defaultRecordingDuration = useCallback((): string => {
    const id = defaultRecordingId(replayIndex);
    const entry = replayIndex?.recordings?.find((r) => r.id === id);
    return entry?.duration_ms === undefined ? "…" : duration(entry.duration_ms);
  }, [replayIndex]);
  // The start card names the default recording's duration; load the index when it can show.
  useEffect(() => {
    if (!replay && !owner) void getIndex();
  }, [replay, owner, getIndex]);

  const openDefaultRecording = useCallback(() => {
    void getIndex().then((list) => {
      const id = defaultRecordingId(list);
      if (id !== undefined) openRecording(id);
    });
  }, [getIndex, openRecording]);

  // ---- FR21: an owner request answered 401 - the session ended server-side. The page is
  // a visitor's again, the toast says so, and the key dialog opens for a new key. ----
  const sessionExpired = useCallback(() => {
    setOwner(false);
    setSheet({ kind: "owner" });
    setToasts((old) => [...old, { id: ++toastSeq, text: text("owner.expired") }].slice(-3));
  }, []);

  // ---- actions the views ask for ----
  const sendIntent = useCallback(
    async (text_: string) => {
      const intentPath = `/api/pools/${encodeURIComponent(pool)}/intents`;
      try {
        const response = await fetch(intentPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: text_, race: false, prewritten: false, request_id: crypto.randomUUID() }),
        });
        if (response.status === 401) sessionExpired();
        else if (!response.ok) toast(errorSentence(response.status));
        else toast(shell.t("toast.sent"));
      } catch {
        toast(errorSentence(null));
      }
    },
    [pool, shell, toast, sessionExpired],
  );

  const allow = useCallback(() => {
    void allowAgents().then((status) => {
      if (status === 401) sessionExpired();
      else if (status < 200 || status >= 300) toast(errorSentence(status === 0 ? null : status));
    });
  }, [sessionExpired, toast]);

  const onBannerAction = useCallback(
    (action: string) => {
      if (action === "kill.allow") {
        allow();
      } else if (action === "pool.rebuild") {
        openSheet({ kind: "rebuild" });
      }
    },
    [allow, openSheet],
  );

  // 3.19/CO38: the badge and key N open the oldest card that can be answered - not a race
  // card whose candidates are all still working.
  const openNeeds = useCallback(() => {
    const cardId = needsCards(session.floor)[0];
    if (cardId !== undefined) openSheet({ kind: "card", card_id: cardId });
  }, [session.floor, openSheet]);

  // ---- the key map of 6.6 ----
  const onKey = useCallback(
    (event: KeyEvent) => {
      const player = session.player;
      switch (event.action) {
        case "escape":
          if (sheet.kind !== "none") setSheet({ kind: "none" });
          else if (replayMenuOpen) setReplayMenuOpen(false);
          else if (view === "compare") setView("floor");
          break;
        case "focus-intent":
          document.querySelector<HTMLElement>(".intent-field")?.focus();
          break;
        case "view-floor":
          setView("floor");
          break;
        case "view-swarm":
          setView("swarm");
          break;
        case "view-overview":
          setView("overview");
          break;
        case "view-about":
          openSheet({ kind: "about" });
          break;
        case "view-compare":
          // 2.3: Compare exists only for a pool with a plain-merge pool beside it — and a
          // live picture: an imported pool (app null, IR12) never enters the view.
          if (session.floor.pool.plain_remote !== null && session.floor.pool.app !== null)
            setView((v) => (v === "compare" ? "floor" : "compare"));
          break;
        case "needs-you":
          openNeeds();
          break;
        case "tab-landed":
          document.querySelector<HTMLElement>('[role="tab"]:nth-child(2)')?.click();
          break;
        case "git-drawer":
          break; // the drawer belongs to an open Why card (floor-rail)
        case "pause-frames":
          setFramesPaused((p) => !p);
          break;
        case "kill":
          if (owner && !replay && !offline) openSheet({ kind: "kill" });
          break;
        case "replay-default":
          pauseNextReplay(); // RY26: R opens the default recording paused
          openDefaultRecording();
          break;
        case "theme": {
          const next = theme === "dark" ? "light" : "dark";
          setTheme(next);
          keep(THEME_KEY, next);
          break;
        }
        case "type-size": {
          const next = size === "stage" ? "laptop" : "stage";
          setSizePick(next);
          keep(SIZE_KEY, next);
          break;
        }
        case "shortcuts":
          openSheet({ kind: "shortcuts" });
          break;
        case "replay-toggle":
          player?.toggle();
          break;
        case "replay-chapter":
          if (event.digit !== undefined) player?.seekChapter(event.digit);
          break;
        case "replay-prev":
          player?.moveChapter(-1);
          break;
        case "replay-next":
          player?.moveChapter(1);
          break;
        case "replay-slower":
          player?.stepSpeed(-1);
          break;
        case "replay-faster":
          player?.stepSpeed(1);
          break;
        case "replay-restart":
          player?.restart();
          break;
      }
    },
    [
      session.player,
      session.floor.pool.plain_remote,
      session.floor.pool.app,
      sheet.kind,
      view,
      owner,
      replay,
      replayMenuOpen,
      theme,
      size,
      openDefaultRecording,
      openNeeds,
      openSheet,
      offline,
    ],
  );
  useKeys({ replay, shortcuts, onKey });

  // ---- render ----
  const floor = session.floor;
  // IR12: an imported pool has no live picture and no pool name of its own in the header —
  // it is named by the repository it came from (`<owner>/<name>`); a seed pool keeps its
  // pool name. `source` is null until a pool.state arrives, so the route's name is the
  // fallback while the kind is undecided.
  const headerPool = floor.pool.app === null && floor.pool.source !== null ? floor.pool.source : pool;
  const clock = session.clock.time();
  const needs = needsCards(floor).length;

  const bannerOpts = {
    replay: {
      // RY3: from the moment a recording starts loading until Replay is closed — an id that
      // never loads keeps the banner too, on the error's own page.
      active: replay,
      synthetic: session.replay.phase === "ready" && session.replay.recording.header.synthetic,
      title:
        session.replay.phase === "ready"
          ? (session.replay.recording.header.label ?? pool)
          : route.kind === "replay"
            ? route.id
            : "",
      date: session.replay.phase === "ready" ? session.replay.recording.header.recorded_at.slice(0, 10) : "",
    },
    view,
    connection: connectionSession.connection,
    connectionTries: connectionSession.tries,
    staleFor: connectionSession.staleFor,
    owner,
    offline,
  };
  const bannerFloor = !replay && view === "swarm" ? { ...floor, swarm: swarmSession.floor.swarm } : floor;
  const banners = bannerList(bannerFloor, clock, bannerOpts);
  const cells = stripCells(floor, clock, { greenFeature: settings.features.green });
  const sheets = (
    <>
      {/* FR33: every open sheet sits in a boundary of its own - a sheet that throws
          while drawing shows view.failed inside the sheet shell and the rest of the page
          keeps working. A boundary is keyed by its subject so the next sheet mounts clean. */}
      {sheet.kind === "card" && (
        <ViewBoundary key={`card ${sheet.card_id}`} sheet>
          {call(table.entries.get("sheet.card"), { floor, card_id: sheet.card_id, onClose: closeSheet })}
        </ViewBoundary>
      )}
      {sheet.kind === "why" && (
        <ViewBoundary key={`why ${sheet.seq}`} sheet>
          {call(table.entries.get("sheet.why"), {
            floor,
            seq: sheet.seq,
            mode: replay ? "replay" : "live",
            onClose: closeSheet,
            // 3.9: the card's `who.open` and `undo.open` buttons open the sibling sheets.
            onOpenWho: table.entries.has("sheet.who")
              ? (kind: string, key: string) => openSheet({ kind: "who", kind_: kind, key })
              : undefined,
            onOpenUndo: table.entries.has("sheet.undo") ? (seq: number) => openSheet({ kind: "undo", seq }) : undefined,
          })}
        </ViewBoundary>
      )}
      {sheet.kind === "who" && (
        <ViewBoundary key={`who ${sheet.kind_} ${sheet.key}`} sheet>
          {call(table.entries.get("sheet.who"), {
            floor,
            kind_: sheet.kind_,
            // `key` is React's own prop and never reaches a component: the panel reads `whoKey`.
            // As the element's key it also gives each subject a fresh panel.
            key: `${sheet.kind_} ${sheet.key}`,
            whoKey: sheet.key,
            onClose: closeSheet,
            onOpenWhy: table.entries.has("sheet.why") ? (seq: number) => openSheet({ kind: "why", seq }) : undefined,
          })}
        </ViewBoundary>
      )}
      {sheet.kind === "undo" && (
        <ViewBoundary key={`undo ${sheet.seq}`} sheet>
          {call(table.entries.get("sheet.undo"), { floor, seq: sheet.seq, onClose: closeSheet })}
        </ViewBoundary>
      )}
      {sheet.kind === "about" && (
        <ViewBoundary key="about" sheet>
          <AboutSheet
            floor={floor}
            shortcuts={shortcuts}
            onShortcuts={setShortcuts}
            onClose={closeSheet}
            build={aboutBuild}
          />
        </ViewBoundary>
      )}
      {sheet.kind === "shortcuts" && (
        <ViewBoundary key="shortcuts" sheet>
          <AboutSheet
            floor={floor}
            shortcuts={shortcuts}
            onShortcuts={setShortcuts}
            onClose={closeSheet}
            build={aboutBuild}
          />
        </ViewBoundary>
      )}
      {sheet.kind === "owner" && (
        <ViewBoundary key="owner" sheet>
          <OwnerDialog
            unlocked={owner}
            onToast={toast}
            onDone={(next) => {
              setOwner(next);
              closeSheet();
              if (!next) toast(shell.t("owner.locked_toast"));
            }}
            onClose={closeSheet}
          />
        </ViewBoundary>
      )}
      {sheet.kind === "kill" && (
        <ViewBoundary key="kill" sheet>
          <KillDialog onClose={closeSheet} onToast={toast} onExpired={sessionExpired} offline={offline} />
        </ViewBoundary>
      )}
      {sheet.kind === "rebuild" && (
        <ViewBoundary key="rebuild" sheet>
          <RebuildDialog
            pool={pool}
            onClose={closeSheet}
            onToast={toast}
            onExpired={sessionExpired}
            offline={offline}
          />
        </ViewBoundary>
      )}
      {replayMenuOpen && (
        <ViewBoundary key="replay-menu" sheet>
          <ReplayMenu
            index={replayIndex}
            owner={owner && !replay}
            pool={pool}
            onPick={(id) => {
              setReplayMenuOpen(false);
              openRecording(id);
            }}
            onClose={() => setReplayMenuOpen(false)}
          />
        </ViewBoundary>
      )}
    </>
  );

  let body: React.ReactNode;
  if (replay && session.replay.phase === "loading") {
    body = (
      <main className="floor-body floor-loading">
        <p className="floor-loading-line">
          {shell.t("replay.loading", { share: `${Math.round(session.replay.progress * 100)}%` })}
        </p>
      </main>
    );
  } else if (replay && session.replay.phase === "error") {
    const reason = replayError(session.replay.failure.check, session.replay.failure.vars);
    body = (
      <main className="floor-body floor-loading">
        <div className="missing-pool">
          <p>{shell.t("replay.error", { reason })}</p>
          <button
            type="button"
            className="primary"
            onClick={() => navigate(poolRoute(settings.default_pool, settings.default_pool))}
          >
            {shell.t("replay.to_live")}
          </button>
        </div>
      </main>
    );
  } else if (session.missing) {
    body = (
      <main className="floor-body floor-loading">
        <div className="missing-pool" data-testid="pool-missing">
          <p>{shell.t("pool.missing")}</p>
          <button type="button" className="primary" onClick={() => navigate("/")}>
            {shell.t("pool.to_default")}
          </button>
        </div>
      </main>
    );
  } else if (view === "swarm") {
    const swarmEntry = table.entries.get("view.swarm");
    body = (
      <main className="floor-body floor-swarm">
        {/* FR33: a throw while a view draws fails that view alone. The boundary is keyed
            by the view so switching to another view mounts it clean. */}
        <ViewBoundary key="swarm">
          {call(swarmEntry, {
            floor: replay ? floor : swarmSession.floor,
            owner: owner && !replay,
            offline,
            pool: settings.swarm_pool,
            clock: replay ? clock : swarmSession.clock.time(),
            waitingSince: activeSession.swarmWaitingSince,
            swarmRun: activeSession.swarmRun,
            readClock: () => activeSession.clock.time(),
            mainPool: floor.pool,
          }) ?? (
            <SwarmView
              floor={replay ? floor : swarmSession.floor}
              owner={owner && !replay}
              offline={offline}
              pool={settings.swarm_pool}
              clock={replay ? clock : swarmSession.clock.time()}
              waitingSince={activeSession.swarmWaitingSince}
              swarmRun={activeSession.swarmRun}
              readClock={() => activeSession.clock.time()}
              mainPool={floor.pool}
            />
          )}
        </ViewBoundary>
      </main>
    );
  } else if (
    view === "compare" &&
    floor.pool.plain_remote !== null &&
    floor.pool.app !== null &&
    table.entries.has("view.compare")
  ) {
    // 2.3: the Compare view - the main pool and the plain-merge pool side by side. The pool area
    // lane registers it; the shell owns the view state, the frames' pause and the way back.
    body = (
      <main className="floor-body floor-compare" data-view="compare">
        <ViewBoundary key="compare">
          {call(table.entries.get("view.compare"), {
            pool,
            floor,
            mode: replay ? "replay" : "live",
            paused: framesPaused,
            onPausedChange: setFramesPaused,
            onBack: () => setView("floor"),
          })}
        </ViewBoundary>
      </main>
    );
  } else if (view === "overview") {
    body = (
      <main className="floor-body floor-overview" data-view="overview">
        <ViewBoundary key="overview">
          <Overview
            pool={pool}
            floor={floor}
            mode={replay ? "replay" : "live"}
            owner={owner}
            visitor={shell.visitor}
            clock={clock}
            capReached={capReached(floor)}
            cells={cells}
            paused={framesPaused}
            onPausedChange={setFramesPaused}
            onCompare={
              floor.pool.plain_remote !== null && floor.pool.app !== null ? () => setView("compare") : undefined
            }
            onTapped={
              table.entries.has("sheet.why")
                ? (path) => {
                    const seq = floor.files[path]?.last_landed_seq;
                    if (seq !== null && seq !== undefined) openSheet({ kind: "why", seq });
                  }
                : undefined
            }
            onOpenCard={(cardId) => openSheet({ kind: "card", card_id: cardId })}
            onOpenWhy={table.entries.has("sheet.why") ? (seq) => openSheet({ kind: "why", seq }) : undefined}
            onFloor={() => setView("floor")}
            replayOffer={
              showStartCard(owner, replay, quietPool(floor, clock), startDismissed)
                ? {
                    label: shell.t("start.play", { duration: defaultRecordingDuration() }),
                    onPlay: openDefaultRecording,
                  }
                : undefined
            }
          />
        </ViewBoundary>
      </main>
    );
  } else {
    // The two regions of the Floor view, imported directly (the pool area is the pool-frame
    // lane's `PoolArea`, the rail the shell's container over the rail lane's `AttemptCard`).
    body = (
      <main className="floor-body" data-view={view}>
        <ViewBoundary key="floor">
          <div className="pool-column">
            <div className="pool-stage">
              <PoolArea
                pool={pool}
                state={floor}
                mode={replay ? "replay" : "live"}
                paused={framesPaused}
                onPausedChange={setFramesPaused}
                onCompare={
                  floor.pool.plain_remote !== null && floor.pool.app !== null ? () => setView("compare") : undefined
                }
                onTapped={
                  table.entries.has("sheet.why")
                    ? (path) => {
                        const seq = floor.files[path]?.last_landed_seq;
                        if (seq !== null && seq !== undefined) openSheet({ kind: "why", seq });
                      }
                    : undefined
                }
                onTileWho={
                  table.entries.has("sheet.who")
                    ? (path) => openSheet({ kind: "who", kind_: "file", key: path })
                    : undefined
                }
                onTileWhy={table.entries.has("sheet.why") ? (_path, seq) => openSheet({ kind: "why", seq }) : undefined}
              />
              {showStartCard(owner, replay, quietPool(floor, clock), startDismissed) && (
                <div className="start-overlay">
                  <div className="start-card" role="group" aria-label={shell.t("start.title")}>
                    <h3>{shell.t("start.title")}</h3>
                    <p>{shell.t("start.body")}</p>
                    <div className="start-actions">
                      <button type="button" className="primary" onClick={openDefaultRecording}>
                        {shell.t("start.play", { duration: defaultRecordingDuration() })}
                      </button>
                      <button type="button" onClick={() => setStartDismissed(true)}>
                        {/* A repository pool has no live pool to look around (IR12). */}
                        {shell.t(floor.pool.app === null ? "start.look.repo" : "start.look")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <Rail
            floor={floor}
            mode={replay ? "replay" : "live"}
            owner={owner}
            visitor={shell.visitor}
            clock={clock}
            dwellMs={reducedMotion ? 2000 : 1200}
            capReached={capReached(floor)}
            onSend={(t) => void sendIntent(t)}
            onOpenCard={(cardId) => openSheet({ kind: "card", card_id: cardId })}
            onOpenWhy={table.entries.has("sheet.why") ? (seq) => openSheet({ kind: "why", seq }) : undefined}
          />
        </ViewBoundary>
      </main>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <div
        className="floor"
        data-mode={replay ? "replay" : "live"}
        data-view={view}
        data-state={offline ? "offline" : undefined}
      >
        <Header
          pool={headerPool}
          view={view}
          mode={replay ? "replay" : "live"}
          needs={needs}
          owner={owner}
          killed={floor.limits?.killed === true}
          offline={offline}
          onView={(v) => {
            if (v === "compare" && floor.pool.plain_remote !== null && floor.pool.app !== null)
              setView((old) => (old === "compare" ? "floor" : "compare"));
            else if (v !== "compare") setView(v);
          }}
          onReplayMenu={() => {
            void getIndex();
            setReplayMenuOpen(true);
          }}
          onAbout={() => openSheet({ kind: "about" })}
          onNeeds={openNeeds}
          onOwner={() => {
            if (!replay) openSheet({ kind: "owner" });
          }}
          onKill={() => {
            if (floor.limits?.killed === true) allow();
            else openSheet({ kind: "kill" });
          }}
        />
        <Strip cells={cells} stale={replay || session.connection !== "lost" ? null : session.staleFor} />
        <Banners rows={banners} onAction={onBannerAction} />
        {/* Sheets live inside .floor-main so the header, banners and strip stay visible
            and usable above them (LY4); on the narrow layout they are full-screen (2.9). */}
        <div className="floor-main">
          {body}
          {sheets}
          <Announcer lines={session.effects.announces} toasts={toasts} />
        </div>
        <Toasts toasts={toasts} onDrop={dropToast} hidden={view === "compare"} />
        {replay && session.player !== null && (
          <ReplayBar
            player={session.player}
            onClose={() => navigate(pool === "" ? "/" : poolRoute(pool, settings.default_pool))}
          />
        )}
      </div>
    </ShellContext.Provider>
  );
}
