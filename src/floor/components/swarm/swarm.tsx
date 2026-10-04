// The Swarm view of 03-floor 3.15: the wall of scripted agents and the run's numbers
// (lps, time to land, go-around rate, waiting, the two small rates, the push backlog).
// CO44: the SYNTHETIC banner is on whenever this view is open; the banner layer reads it
// from `view === "swarm"`. CO48: the page shows the numbers of the newest `swarm.state`
// and `metrics`, never of its own request. Slice 1 draws the numbers and the wall; the
// start/stop controls are the owner's and send `SwarmRequest` (SWR1).

import { useContext, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { duration } from "../../../copy/format.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { inFlight } from "../../state/derive.ts";

function share(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function SwarmView({ floor, owner, pool }: { floor: FloorState; owner: boolean; pool: string }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState(12);
  const [dial, setDial] = useState(0);

  const swarm = floor.swarm;
  const metrics = floor.metrics;
  const wall = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");
  const working = wall.filter((a) => inFlight(a) && a.state !== "going_around").length;
  const goingAround = wall.filter((a) => a.state === "going_around").length;
  const landing = wall.filter((a) => a.state === "landed").length;

  const send = async (running: boolean) => {
    setBusy(true);
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
      const response = await fetch("/api/swarm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) setError(errorSentence(response.status));
    } catch {
      setError(errorSentence(null));
    } finally {
      setBusy(false);
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
                  : t("swarm.false_abort", { share: share(metrics.false_abort_rate) })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label" title={t("swarm.escape.tip")}>
                {metrics?.escape_rate == null
                  ? t("strip.dash")
                  : t("swarm.escape", { share: share(metrics.escape_rate) })}
              </div>
            </div>
            <div className="swarm-cell">
              <div className="strip-label">{t("swarm.backlog", { n: metrics?.push_backlog ?? 0 })}</div>
            </div>
          </div>
          {wall.length > 0 && (
            <>
              <p className="swarm-wall-summary">
                {t("swarm.wall.summary", { n: [wall.length, working, goingAround, landing] })}
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
              onChange={(e) => setDial(Number(e.target.value))}
            />
          </label>
          {swarm?.running ? (
            <button type="button" disabled={busy || blocked} onClick={() => void send(false)}>
              {t("swarm.stop")}
            </button>
          ) : (
            <button type="button" disabled={busy || blocked} onClick={() => void send(true)}>
              {t("swarm.start")}
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
