// The Swarm view of 03-floor 3.15: the wall of scripted agents and the run's numbers
// (lps, time to land, go-around rate, waiting, the two small rates, the push backlog).
// CO44: the SYNTHETIC banner is on whenever this view is open; the banner layer reads it
// from `view === "swarm"`. CO48: the page shows the numbers of the newest `swarm.state`
// and `metrics`, never of its own request. Slice 1 draws the numbers and the wall; the
// start/stop controls are the owner's and send `SwarmRequest` (SWR1).

import { useContext, useEffect, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { count, timeOfDay } from "../../../copy/format.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { SwarmNumbers, share } from "./metrics.tsx";
import { SwarmWall } from "./wall.tsx";

import { shownSwarm, swarmDidNotStart, swarmRequestAcknowledged } from "./startup.ts";

export function SwarmView({
  floor,
  owner,
  offline = false,
  pool,
  clock = floor.ts,
  waitingSince = null,
  swarmRun = 0,
  readClock,
  mainPool = floor.pool,
}: {
  floor: FloorState;
  owner: boolean;
  offline?: boolean;
  pool: string;
  clock?: number;
  waitingSince?: number | null;
  swarmRun?: number;
  readClock?: () => number;
  mainPool?: FloorState["pool"];
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  // FL10: the request in flight, so its button says what is being waited for.
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [answered, setAnswered] = useState(false);
  const [requestedRun, setRequestedRun] = useState(0);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState(64);
  const [dial, setDial] = useState(0);

  const swarm = shownSwarm(floor.swarm);

  useEffect(() => {
    if (swarmRequestAcknowledged(pending, answered, requestedRun, swarmRun, swarm?.running)) setPending(null);
  }, [answered, pending, requestedRun, swarmRun, swarm?.running]);

  // CO48: every new swarm.state wins over local drafts, including a rejected dial move.
  useEffect(() => {
    if (swarm === null) return;
    setAgents(swarm.agents);
    setDial(swarm.collision_dial);
  }, [swarm]);
  const wall = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");

  const send = async (running: boolean) => {
    setAnswered(false);
    setRequestedRun(swarmRun);
    setPending(running ? "start" : "stop");
    setError(null);
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
    if (await post(body)) setAnswered(true);
    else setPending(null);
  };

  const post = async (body: object) => {
    try {
      const response = await fetch("/api/swarm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) setError(errorSentence(response.status));
      return response.ok;
    } catch {
      setError(errorSentence(null));
      return false;
    }
  };

  // CO44a: moving the dial during a run sends { pool, running: true, collision_dial } at once —
  // while idle it is the config the next Start sends.
  const moveDial = (value: number) => {
    if (swarm?.running === true) {
      setError(null);
      void post({ pool, running: true, collision_dial: value, request_id: crypto.randomUUID() });
    } else setDial(value);
  };

  const blocked = floor.limits?.killed === true || floor.pool.state === "paused";

  return (
    <div className="swarm-view">
      {swarm === null ? (
        <p className="swarm-empty">{t("swarm.empty")}</p>
      ) : (
        <>
          {!swarm.running && swarm.ever_ran && (
            <p className="swarm-final">{t("swarm.final", { time: timeOfDay(floor.ts) })}</p>
          )}
          {swarm.running && waitingSince !== null && (
            <p className="swarm-final">
              {swarmDidNotStart(waitingSince, clock) ? t("swarm.no_agents") : t("swarm.starting", { n: swarm.agents })}
            </p>
          )}
          <SwarmNumbers floor={floor} />
          {wall.length > 0 && <SwarmWall floor={floor} clock={clock} readClock={readClock} />}
        </>
      )}
      {owner && (
        <div className="swarm-controls">
          <fieldset className="swarm-agents" disabled={busy || blocked || offline || swarm?.running === true}>
            <legend>{t("swarm.agents")}</legend>
            {[64, 256, 1024, 2048].map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="swarm-agents"
                  value={value}
                  checked={agents === value}
                  onChange={() => setAgents(value)}
                />
                <span>{count(value)}</span>
              </label>
            ))}
            {![64, 256, 1024, 2048].includes(agents) && <output className="swarm-agent-count">{count(agents)}</output>}
          </fieldset>
          <label className="field">
            <span>{t("swarm.dial")}</span>
            <output>{share(dial)}</output>
            <input
              disabled={busy || blocked || offline}
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
            <button type="button" disabled={busy || blocked || offline} onClick={() => void send(false)}>
              {pending === "start"
                ? t("swarm.starting", { n: agents })
                : pending === "stop"
                  ? t("swarm.stopping")
                  : t("swarm.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || blocked || offline}
              onClick={() => void send(true)}
            >
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
      <p className="swarm-real-limit">{t("swarm.real_limit", { max: mainPool.max_real_agents })}</p>
      {swarm !== null && (
        // CO44b: a run is one pool's (SWR1: `run-<pool>`); `swarm.state.pools` lists where the
        // state is delivered (every registered pool, EV2a), not where agents run.
        <p className="swarm-shape">{t("swarm.shape", { pools: 1, agents: swarm.agents })}</p>
      )}
      <p className="swarm-repair">{t("swarm.repair_note")}</p>
    </div>
  );
}
