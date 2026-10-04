// The session hook: the one place `FloorState` is produced. Live mode opens the read-only
// stream of `01-core.md` 12.2 (snapshot or event frames, FL1/FE3); Replay mode plays a
// recording through the same reducer (RY5). What renders is always
// `render(FloorState, ViewState, clock)`.

import { useEffect, useRef, useState } from "react";
import type { PoolEvent } from "../../protocol/events.ts";
import type { FloorJson } from "../../protocol/floor-json.ts";
import { reduce } from "../../protocol/reducer/reduce.ts";
import { emptyFloorState, type FloorState } from "../../protocol/reducer/state.ts";
import { LiveClock, type StreamClock } from "../stream/clock.ts";
import { openLiveStream, type Connection, type SocketLike } from "../stream/live.ts";
import {
  ReplayPlayer,
  loadRecordingText,
  parseRecording,
  type PlayerSnapshot,
  type Recording,
  type ReplayFailure,
} from "../replay/player.ts";
import { linesForEvent, type AnnouncedLine, type BeforeBits } from "../components/toast/announce.ts";
import { changeName } from "../../copy/names.ts";
import { text } from "../../copy/strings.ts";
import type { Route } from "./route.ts";

export type ReplayStatus =
  | { phase: "loading"; progress: number }
  | { phase: "ready"; recording: Recording }
  | { phase: "error"; failure: ReplayFailure }
  | { phase: "idle" };

/** What a screen reader or the toast stack must hear of an applied event (5.13, 3.19). */
export type SessionEffects = {
  announces: AnnouncedLine[];
  toasts: string[];
};

export type Session = {
  floor: FloorState;
  clock: StreamClock;
  connection: Connection;
  tries: number;
  missing: boolean; // FR30: /p/{pool} named a pool the stream does not answer
  staleFor: number | null; // ms since the newest applied event's ts (banner.offline)
  replay: ReplayStatus;
  player: ReplayPlayer | null;
  snap: PlayerSnapshot | null;
  effects: SessionEffects;
};

/** A one-shot flag key `R` sets: the default recording opens paused (RY26). The session
 * reads and clears it once, when the player is made. */
const REPLAY_PAUSED_KEY = "premise.replay.paused";
export function pauseNextReplay(): void {
  try {
    window.sessionStorage.setItem(REPLAY_PAUSED_KEY, "1");
  } catch {
    // storage can be off; the recording then plays, the kinder default
  }
}
function takePausedFlag(): boolean {
  try {
    const flag = window.sessionStorage.getItem(REPLAY_PAUSED_KEY) === "1";
    window.sessionStorage.removeItem(REPLAY_PAUSED_KEY);
    return flag;
  } catch {
    return false;
  }
}

const NULL_CLOCK: StreamClock = { time: () => 0 };

export function browserTimers() {
  return {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
  };
}

function newSession(): Session {
  return {
    floor: emptyFloorState(),
    clock: NULL_CLOCK,
    connection: "connecting",
    tries: 0,
    missing: false,
    staleFor: null,
    replay: { phase: "idle" },
    player: null,
    snap: null,
    effects: { announces: [], toasts: [] },
  };
}

/**
 * Runs the session for `route`. Live mode opens the stream of `pool` (the route's, or the
 * default pool of `/floor.json`); Replay mode loads and plays the recording of `route.id`.
 */
export function useSession(route: Route, settings: FloorJson, reducedMotion: boolean): Session {
  const [session, setSession] = useState<Session>(newSession);
  const [, bump] = useState(0);
  const floorRef = useRef<FloorState>(emptyFloorState());
  const effectsRef = useRef<SessionEffects>({ announces: [], toasts: [] });

  const key = route.kind === "replay" ? `replay:${route.id}` : `pool:${route.pool ?? settings.default_pool}`;

  useEffect(() => {
    let disposed = false;
    const tick = () => {
      if (!disposed) bump((n) => n + 1);
    };

    if (route.kind === "replay") {
      let player: ReplayPlayer | null = null;
      let unsubscribe: (() => void) | null = null;
      const clock: StreamClock = { time: () => player?.snapshot().clock ?? 0 };
      floorRef.current = emptyFloorState();
      setSession({ ...newSession(), clock, replay: { phase: "loading", progress: 0 } });

      void (async () => {
        const text = await loadRecordingText(route.id, fetch);
        if (disposed) return;
        if (text === null) {
          setSession((s) => ({ ...s, replay: { phase: "error", failure: { check: "download", vars: {} } } }));
          return;
        }
        const parsed = parseRecording(text);
        if (!parsed.ok) {
          setSession((s) => ({ ...s, replay: { phase: "error", failure: parsed.failure } }));
          return;
        }
        player = new ReplayPlayer(parsed.recording, browserTimers(), {
          // RY18: a direct link loads and plays; with reduced motion it loads paused (6.4),
          // and key R opens the default recording paused (RY26).
          playing: !(reducedMotion || takePausedFlag()),
          speed: 1,
        });
        unsubscribe = player.subscribe(tick);
        floorRef.current = player.snapshot().floor;
        setSession((s) => ({
          ...s,
          replay: { phase: "ready", recording: parsed.recording },
          player,
          snap: player!.snapshot(),
          floor: player!.snapshot().floor,
        }));
        tick();
      })();

      return () => {
        disposed = true;
        unsubscribe?.();
        player?.close();
      };
    }

    // ---- live mode ----
    const pool = route.pool ?? settings.default_pool;
    const floor = emptyFloorState();
    floorRef.current = floor;
    const clock = new LiveClock(() => Date.now());
    const session: Session = { ...newSession(), floor, clock };
    setSession(session);

    const handle = openLiveStream(
      pool,
      {
        // `fetch` keeps its Window receiver: `env.get(...)` would call it on `env`
        // and Chromium rejects that with "Illegal invocation".
        get: (input, init) => fetch(input, init),
        origin: location.origin,
        socket: (url) => new WebSocket(url) as unknown as SocketLike,
        now: () => Date.now(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h as number),
      },
      {
        onSnapshot(_n, state) {
          if (disposed) return;
          for (const key of Object.keys(floor) as Array<keyof FloorState>) {
            // A snapshot replaces the whole state (FE3): same shape, JSON values only.
            (floor as Record<string, unknown>)[key] = (state as Record<string, unknown>)[key];
          }
          tick();
        },
        onEvents(events) {
          if (disposed) return;
          for (const event of events) {
            if (event.n > floor.n) {
              const before = beforeBits(floor, event);
              reduce(floor, event);
              clock.note(event.ts);
              effectsRef.current.announces.push(...linesForEvent(event, floor, before));
              if (event.type === "landing.landed" && floor.landings[event.seq]?.kind === "change") {
                const attemptId = floor.landings[event.seq]?.attempt_id;
                const attempt = attemptId == null ? undefined : floor.attempts[attemptId];
                const intent = attempt === undefined ? undefined : floor.intents[attempt.intent_id];
                if (attempt !== undefined && intent !== undefined) {
                  effectsRef.current.toasts.push(
                    text("toast.landed", {
                      changeName: changeName({
                        intentText: intent.text,
                        race: attempt.race,
                        model: attempt.model,
                        premises: Object.values(attempt.premises).map((pr) => ({
                          kind: pr.kind,
                          key: pr.key,
                          edit: pr.edit,
                        })),
                      }),
                    }),
                  );
                }
              }
            }
          }
          tick();
        },
        onConnection(connection, tries) {
          if (disposed) return;
          setSession((s) => ({ ...s, connection, tries }));
        },
        onMissing() {
          if (disposed) return;
          setSession((s) => ({ ...s, missing: true }));
        },
      },
    );

    // VD4: the run clock and the stall/idle timers of 4.4 tick between events.
    const ticker = window.setInterval(tick, 1_000);
    return () => {
      window.clearInterval(ticker);
      handle.close();
    };
  }, [key, settings, reducedMotion, route]);

  // Keep the snapshot view fresh: the player's subscribe bumps, but the fields below must
  // always read the newest values.
  const player = session.player;
  const snap = player === null ? null : player.snapshot();
  const floor = snap === null ? floorRef.current : snap.floor;
  const staleFor = floor.ts === 0 ? null : Math.max(0, session.clock.time() - floor.ts);
  return { ...session, floor, snap, staleFor, effects: effectsRef.current };
}

function beforeBits(floor: FloorState, event: PoolEvent): BeforeBits {
  return {
    poolState: floor.pool.state,
    killed: floor.limits?.killed === true,
    spendAtCap: floor.limits !== null && floor.limits.cap_usd > 0 && floor.limits.spend_usd >= floor.limits.cap_usd,
    swarmRunning: floor.swarm?.running === true,
    cardAnswerable: (cardId) => (floor.cards[cardId]?.card.options.length ?? 0) > 0,
  };
  void event;
}
