// The Swarm view of 03-floor 3.15: the wall of scripted agents and the run's numbers
// (lps, time to land, go-around rate, waiting, the two small rates, the push backlog).
// CO44: the SYNTHETIC banner is on whenever this view is open; the banner layer reads it
// from `view === "swarm"`. CO48: the page shows the numbers of the newest `swarm.state`
// and `metrics`, never of its own request. Slice 1 draws the numbers and the wall; the
// start/stop controls are the owner's and send `SwarmRequest` (SWR1).

import { useContext, useEffect, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { duration } from "../../../copy/format.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { ESCAPE_TARGET, FALSE_ABORT_TARGET } from "../../../protocol/constants.ts";
import { inFlight } from "../../state/derive.ts";

function share(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function SwarmView({ floor, owner, pool }: { floor: FloorState; owner: boolean; pool: string }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  // FL10: the request in flight, so its button says what is being waited for.
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState(12);
  const [dial, setDial] = useState(0);

  const swarm = floor.swarm;
  const metrics = floor.metrics;

  // CO48: the controls show the newest swarm.state, not the page's own requests. The local
  // values are drafts while no state has arrived; a new state adopts its numbers (a value the
  // owner already set does not drag the control back).
  const seen = useRef<{ agents?: number; dial?: number }>({});
  useEffect(() => {
    if (swarm !== null && swarm.agents !== seen.current.agents) setAgents(swarm.agents);
    if (swarm !== null && swarm.collision_dial !== seen.current.dial) setDial(swarm.collision_dial);
    seen.current = { agents: swarm?.agents, dial: swarm?.collision_dial };
  }, [swarm]);
  const wall = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");
  const working = wall.filter((a) => inFlight(a) && a.state !== "going_around").length;
  const goingAround = wall.filter((a) => a.state === "going_around").length;
  const landing = wall.filter((a) => a.state === "landed").length;

  const send = async (running: boolean) => {
    setPending(running ? "start" : "stop");
    setError(null);
    try {
      const body = running
        ? {
            pool,
            running: true,
            agents,
            collision_dial: dial,
            ...shell.settings.swarm_defaults,
            request_id: crypto.randomUUID(),
          }
        : { pool, running: false, request_id: crypto.randomUUID() };
      await post(body);
    } finally {
      setPending(null);
    }
  };

  const post = async (body: object) => {
    try {
      const response = await fetch("/api/swarm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) setError(errorSentence(response.status));
    } catch {
      setError(errorSentence(null));
    }
  };

  // CO44a: moving the dial during a run sends { pool, running: true, collision_dial } at once —
  // while idle it is the config the next Start sends.
  const moveDial = (value: number) => {
    setDial(value);
    if (swarm?.running === true) {
      setError(null);
      void post({ pool, running: true, collision_dial: value, request_id: crypto.randomUUID() });
    }
  };

  const blocked = floor.limits?.killed === true || floor.pool.state === "paused";

  return (
    <div className="swarm-view">
      {swarm === null ? (
        <p className="swarm-empty">{t("swarm.empty")}</p>
      ) : (
        <>
          {!swarm.running && swarm.ever_ran && <p className="swarm-final">{t("swarm.final")}</p>}
          {swarm.running && wall.length === 0 && (
            <p className="swarm-final">{t("swarm.starting", { n: swarm.agents })}</p>
          )}
          <p className="swarm-shape">{t("swarm.shape", { pools: swarm.pools.length, agents: swarm.agents })}</p>
          <div className="swarm-numbers">
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.lps")}</div>
              <div className="strip-value">
                {metrics === null ? t("strip.dash") : metrics.landings_per_second.toFixed(2)}
              </div>
              <div className="strip-sub">
                {t("swarm.window", { seconds: Math.round((metrics?.window_ms ?? 0) / 1000) })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.ttl")}</div>
              <div className="strip-value">
                {metrics?.time_to_land_ms.p50 == null ? t("strip.dash") : duration(metrics.time_to_land_ms.p50)}
              </div>
              <div className="strip-sub">
                {t("swarm.ttl.sub", {
                  duration:
                    metrics?.time_to_land_ms.p99 == null ? t("strip.dash") : duration(metrics.time_to_land_ms.p99),
                })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.gar")}</div>
              <div className="strip-value">
                {metrics?.go_around_rate == null ? t("strip.dash") : share(metrics.go_around_rate)}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.waiting")}</div>
              <div className="strip-value">{metrics === null ? t("strip.dash") : metrics.waiting_behind}</div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label" title={t("swarm.false_abort.tip")}>
                {metrics?.false_abort_rate == null
                  ? t("strip.dash")
                  : t("swarm.false_abort", { share: [share(metrics.false_abort_rate), share(FALSE_ABORT_TARGET)] })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label" title={t("swarm.escape.tip")}>
                {metrics?.escape_rate == null
                  ? t("strip.dash")
                  : t("swarm.escape", { share: [share(metrics.escape_rate), share(ESCAPE_TARGET)] })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.backlog", { n: metrics?.push_backlog ?? 0 })}</div>
            </div>
          </div>
          {wall.length > 0 && (
            <>
              <p className="swarm-wall-summary">
                {t("swarm.wall.summary", { n: wall.length, a: working, b: goingAround, c: landing })}
              </p>
              <div className="swarm-wall" role="list">
                {wall.map((a) => (
                  <div className="swarm-tile" role="listitem" key={a.id} data-state={a.state}>
                    {a.state}
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="swarm-repair">{t("swarm.repair_note")}</p>
        </>
      )}
      {owner && (
        <div className="swarm-controls">
          <label className="field">
            <span>{t("swarm.agents")}</span>
            <input type="number" min={1} value={agents} onChange={(e) => setAgents(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>{t("swarm.dial")}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={dial}
              title={t("swarm.dial.tip")}
              onChange={(e) => moveDial(Number(e.target.value))}
            />
          </label>
          {swarm?.running ? (
            <button type="button" disabled={busy || blocked} onClick={() => void send(false)}>
              {pending === "start"
                ? t("swarm.starting", { n: agents })
                : pending === "stop"
                  ? t("swarm.stopping")
                  : t("swarm.stop")}
            </button>
          ) : (
            <button type="button" disabled={busy || blocked} onClick={() => void send(true)}>
              {pending === "start"
                ? t("swarm.starting", { n: agents })
                : pending === "stop"
                  ? t("swarm.stopping")
                  : t("swarm.start")}
            </button>
          )}
          {blocked && <p className="field-error">{t("swarm.blocked")}</p>}
          {error !== null && <p className="field-error">{error}</p>}
        </div>
      )}
      {!owner && swarm === null && null}
    </div>
  );
}
