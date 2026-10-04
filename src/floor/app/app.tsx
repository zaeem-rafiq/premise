// The Floor app: `render(FloorState, ViewState, clock)` (FL1). Live mode, a snapshot and
// Replay draw the same components of the same `FloorState` (FE4). The body comes from the
// registry seam: `view.pool-area` and `view.rail` are the other two lanes' entries; while
// they are not registered the shell's fallbacks hold the layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FloorJson } from "../../protocol/floor-json.ts";
import type { FloorState } from "../../protocol/reducer/state.ts";
import type { RegistryEntry, RegistryTable } from "./registry.ts";
import { parseRoute, poolRoute, type Route } from "./route.ts";
import { ShellContext, makeShell } from "./context.ts";
import { pauseNextReplay, useSession } from "./session.ts";
import { useKeys, type KeyEvent } from "../keys/keys.ts";
import { bannerList, capReached, quietPool, stripCells } from "../state/derive.ts";
import type { SheetTarget, Toast } from "../state/view-state.ts";
import { Header } from "./header.tsx";
import { Strip } from "../components/strip/strip.tsx";
import { Banners } from "../components/banners/banners.tsx";
import { Toasts } from "../components/toast/toasts.tsx";
import { Announcer } from "../components/toast/announcer.tsx";
import { AboutSheet } from "../components/about/about.tsx";
import { OwnerDialog } from "../components/owner-key/owner-key.tsx";
import { KillDialog, allowAgents } from "../components/kill-switch/kill-switch.tsx";
import { SwarmView } from "../components/swarm/swarm.tsx";
import { GreenLine } from "../components/green/green.tsx";
import { PoolAreaFallback } from "./pool-area-fallback.tsx";
import { RailFallback } from "./rail-fallback.tsx";
import { ReplayBar } from "../replay/replay-bar.tsx";
import { ReplayMenu } from "../replay/replay-menu.tsx";
import { loadRecordingIndex, recordingFileUrl, type RecordingIndex } from "../replay/player.ts";
import { replayError } from "../../copy/replay.ts";
import { errorSentence } from "../../copy/errors.ts";
import { sessionPath } from "../stream/urls.ts";
import { duration } from "../../copy/format.ts";

type RegistryComponent = (props: Record<string, unknown>) => React.ReactNode;

// The components a registry entry's string `value` names. A wiring module cannot import these
// `.tsx` files (test/arch/seams.test.ts compiles every wiring module in the Node program, which
// has no JSX), so a lane registers the entry's name and the app binds the name here.
const SHELL_COMPONENTS: Record<string, RegistryComponent> = {
  "view.swarm": (props) => (
    <SwarmView floor={props.floor as FloorState} owner={props.owner === true} pool={String(props.pool)} />
  ),
};

/** Calls the registered component, or null when the entry is missing or unbound (the app draws
 * its fallback then). A `value` may be the component itself or its entry's name. */
function call(entry: RegistryEntry | undefined, props: Record<string, unknown>): React.ReactNode {
  if (entry === undefined) return null;
  const Component =
    typeof entry.value === "function"
      ? (entry.value as RegistryComponent)
      : typeof entry.value === "string"
        ? SHELL_COMPONENTS[entry.value]
        : undefined;
  if (Component === undefined) return null;
  return <Component {...props} />;
}

let toastSeq = 0;

export function FloorApp({ settings, table }: { settings: FloorJson; table: RegistryTable }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [view, setView] = useState<"floor" | "compare" | "swarm">("floor");
  const [sheet, setSheet] = useState<SheetTarget>({ kind: "none" });
  const [owner, setOwner] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const [size, setSize] = useState<"stage" | "laptop">("laptop");
  const [shortcuts, setShortcuts] = useState(true);
  const [framesPaused, setFramesPaused] = useState(false);
  const [startDismissed, setStartDismissed] = useState(false);
  const [replayIndex, setReplayIndex] = useState<RecordingIndex | null>(null);
  const [replayMenuOpen, setReplayMenuOpen] = useState(false);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const replay = route.kind === "replay";
  const session = useSession(route, settings, reducedMotion);
  const shell = useMemo(() => makeShell(settings, owner, replay), [settings, owner, replay]);

  // ---- routing (client routes of 4.5; the page never reloads) ----
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
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
  const fed = useRef({ toasts: 0 });
  useEffect(() => {
    const fresh = session.effects.toasts.slice(fed.current.toasts);
    fed.current.toasts = session.effects.toasts.length;
    if (fresh.length > 0) {
      setToasts((old) => [...old, ...fresh.map((text) => ({ id: ++toastSeq, text }))].slice(-3));
    }
  }, [session.effects, session.floor.n]);
  const dropToast = useCallback((id: number) => setToasts((old) => old.filter((t) => t.id !== id)), []);
  const toast = useCallback((text: string) => setToasts((old) => [...old, { id: ++toastSeq, text }].slice(-3)), []);

  // ---- theme + size on the root element (6.3, 6.6) ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.size = size;
  }, [theme, size]);

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
    const list = replayIndex?.recordings;
    const entry = list?.find((r) => r.id === replayIndex?.default) ?? list?.[0];
    return entry?.duration_ms === undefined ? "…" : duration(entry.duration_ms);
  }, [replayIndex]);
  // The start card names the default recording's duration; load the index when it can show.
  useEffect(() => {
    if (!replay && !owner) void getIndex();
  }, [replay, owner, getIndex]);

  const openDefaultRecording = useCallback(() => {
    void getIndex().then((list) => {
      const id = list?.default ?? list?.recordings?.[0]?.id;
      if (id !== undefined) openRecording(id);
    });
  }, [getIndex, openRecording]);

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
        if (!response.ok) toast(errorSentence(response.status));
        else toast(shell.t("toast.sent"));
      } catch {
        toast(errorSentence(null));
      }
    },
    [pool, shell, toast],
  );

  const onBannerAction = useCallback(
    (action: string) => {
      if (action === "kill.allow") {
        void allowAgents().then((ok) => {
          if (!ok) toast(errorSentence(null));
        });
      } else if (action === "pool.rebuild") {
        setSheet({ kind: "none" });
        void fetch(`/api/pools/${encodeURIComponent(pool)}/rebuild`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request_id: crypto.randomUUID() }),
        })
          .then((response) => {
            if (!response.ok) toast(errorSentence(response.status));
          })
          .catch(() => toast(errorSentence(null)));
      }
    },
    [pool, toast],
  );

  const openNeeds = useCallback(() => {
    const cardId = session.floor.open_cards[0];
    if (cardId !== undefined) setSheet({ kind: "card", card_id: cardId });
  }, [session.floor]);

  // ---- the key map of 6.6 ----
  const onKey = useCallback(
    (event: KeyEvent) => {
      const player = session.player;
      switch (event.action) {
        case "escape":
          if (sheet.kind !== "none") setSheet({ kind: "none" });
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
        case "view-about":
          setSheet({ kind: "about" });
          break;
        case "view-compare":
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
          if (owner && !replay) setSheet({ kind: "kill" });
          break;
        case "replay-default":
          pauseNextReplay(); // RY26: R opens the default recording paused
          openDefaultRecording();
          break;
        case "theme":
          setTheme((t) => (t === "dark" ? "light" : "dark"));
          break;
        case "type-size":
          setSize((s) => (s === "stage" ? "laptop" : "stage"));
          break;
        case "shortcuts":
          setSheet({ kind: "shortcuts" });
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
    [session.player, sheet.kind, view, owner, replay, openDefaultRecording, openNeeds],
  );
  useKeys({ replay, shortcuts, onKey });

  // ---- render ----
  const floor = session.floor;
  const clock = session.clock.time();
  const needs = floor.open_cards.filter((id) => {
    const card = floor.cards[id]?.card;
    return card !== undefined && card.options.length > 0;
  }).length;

  const bannerOpts = {
    replay: {
      active: replay && session.replay.phase !== "error",
      synthetic: session.replay.phase === "ready" && session.replay.recording.header.synthetic,
      title: session.replay.phase === "ready" ? (session.replay.recording.header.label ?? pool) : "",
      date: session.replay.phase === "ready" ? session.replay.recording.header.recorded_at.slice(0, 10) : "",
    },
    view,
    connection: session.connection,
    connectionTries: session.tries,
    staleFor: session.staleFor,
    owner,
  };
  const banners = bannerList(floor, clock, bannerOpts);
  const cells = stripCells(floor, clock, { greenFeature: settings.features.green });
  const landingCount =
    floor.push === null
      ? 0
      : floor.landed_order.filter((seq) => {
          const landing = floor.landings[seq];
          return (
            landing !== undefined &&
            landing.batch_id === floor.push!.batch_id &&
            (landing.digest === true ? landing.landed_ts === null : landing.landed === null)
          );
        }).length;

  const viewProps: Record<string, unknown> = {
    floor,
    view,
    clock,
    mode: replay ? "replay" : "live",
    owner,
    settings,
    shell,
    sheet,
    setSheet,
    sendIntent,
    toast,
    framesPaused,
    navigate,
  };

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
        {call(swarmEntry, { floor, owner, pool: settings.swarm_pool }) ?? (
          <SwarmView floor={floor} owner={owner} pool={settings.swarm_pool} />
        )}
      </main>
    );
  } else {
    const poolAreaEntry = table.entries.get("view.pool-area");
    const railEntry = table.entries.get("view.rail");
    body = (
      <main className="floor-body" data-view={view}>
        <div className="pool-column">
          {call(poolAreaEntry, viewProps) ?? (
            <>
              <PoolAreaFallback
                floor={floor}
                mode={replay ? "replay" : "live"}
                quiet={quietPool(floor, clock) && !startDismissed}
                start={{ duration: defaultRecordingDuration() }}
                paused={floor.pool.state === "paused" || framesPaused}
                landing={landingCount}
                onStartPlay={openDefaultRecording}
                onStartDismiss={() => setStartDismissed(true)}
              />
              <div className="frame-under">
                <GreenLine floor={floor} />
              </div>
            </>
          )}
        </div>
        {call(railEntry, viewProps) ?? (
          <RailFallback
            floor={floor}
            mode={replay ? "replay" : "live"}
            owner={owner}
            capReached={capReached(floor)}
            onSend={(t) => void sendIntent(t)}
          />
        )}
      </main>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <div className="floor" data-mode={replay ? "replay" : "live"} data-view={view}>
        <Header
          pool={pool}
          view={view}
          mode={replay ? "replay" : "live"}
          needs={needs}
          owner={owner}
          killed={floor.limits?.killed === true}
          onView={(v) => {
            if (v === "compare") setView((old) => (old === "compare" ? "floor" : "compare"));
            else setView(v);
          }}
          onReplayMenu={() => {
            void getIndex();
            setSheet({ kind: "none" });
            setReplayMenuOpen(true);
          }}
          onAbout={() => setSheet({ kind: "about" })}
          onNeeds={openNeeds}
          onOwner={() => {
            if (!replay) setSheet({ kind: "owner" });
          }}
          onKill={() => {
            if (floor.limits?.killed === true) {
              void allowAgents().then((ok) => {
                if (!ok) toast(errorSentence(null));
              });
            } else {
              setSheet({ kind: "kill" });
            }
          }}
        />
        <Banners rows={banners} onAction={onBannerAction} />
        <Strip cells={cells} stale={replay ? null : session.staleFor} />
        {body}
        {replay && session.player !== null && (
          <ReplayBar player={session.player} onClose={() => navigate(poolRoute(pool, settings.default_pool))} />
        )}
        <Toasts toasts={toasts} onDrop={dropToast} />
        <Announcer lines={session.effects.announces} />
        {sheet.kind === "about" && (
          <AboutSheet
            floor={floor}
            shortcuts={shortcuts}
            onShortcuts={setShortcuts}
            onClose={() => setSheet({ kind: "none" })}
          />
        )}
        {sheet.kind === "owner" && (
          <OwnerDialog
            onDone={(next) => {
              setOwner(next);
              setSheet({ kind: "none" });
              if (!next) toast(shell.t("owner.locked_toast"));
            }}
            onClose={() => setSheet({ kind: "none" })}
          />
        )}
        {sheet.kind === "kill" && <KillDialog onClose={() => setSheet({ kind: "none" })} />}
        {sheet.kind === "shortcuts" && (
          <AboutSheet
            floor={floor}
            shortcuts={shortcuts}
            onShortcuts={setShortcuts}
            onClose={() => setSheet({ kind: "none" })}
          />
        )}
        {replayMenuOpen && (
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
        )}
      </div>
    </ShellContext.Provider>
  );
}
