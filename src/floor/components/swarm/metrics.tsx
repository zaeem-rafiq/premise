import { useContext } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { count, duration } from "../../../copy/format.ts";
import { text } from "../../../copy/strings.ts";
import { ESCAPE_TARGET, FALSE_ABORT_TARGET } from "../../../protocol/constants.ts";

export function share(value: number | null | undefined): string {
  return value == null ? text("strip.dash") : `${Math.round(value * 100)}%`;
}

export function SwarmNumbers({ floor }: { floor: FloorState }) {
  const { t, settings } = useContext(ShellContext)!;
  const metrics = floor.metrics;
  const dash = t("strip.dash");
  const window = metrics === null ? dash : t("swarm.window", { seconds: Math.round(metrics.window_ms / 1000) });
  const history = floor.metrics_history;
  const end = history.at(-1)?.ts ?? 0;
  const max = Math.max(1, ...history.map((sample) => sample.landings_per_second));
  const points = history
    .map((sample) => `${(sample.ts - end + 60_000) / 200},${40 - (sample.landings_per_second / max) * 36}`)
    .join(" ");
  return (
    <div className="swarm-numbers">
      <div className="swarm-primary">
        <div className="swarm-cell">
          <div className="strip-label">{t("swarm.lps")}</div>
          <div className="strip-value">{metrics === null ? dash : metrics.landings_per_second.toFixed(2)}</div>
          <div className="strip-sub">{window}</div>
          <svg
            className="swarm-chart"
            viewBox="0 0 300 44"
            preserveAspectRatio="none"
            role="img"
            aria-label={t("swarm.lps")}
          >
            <path className="swarm-chart-axis" d="M0 42H300" />
            {history.length > 0 && <polyline points={points} />}
          </svg>
        </div>
        <div className="swarm-cell">
          <div className="strip-label">{t("swarm.ttl")}</div>
          <div className="strip-value">
            {metrics?.time_to_land_ms.p50 == null ? dash : duration(metrics.time_to_land_ms.p50)}
          </div>
          <div className="strip-sub">
            {t("swarm.ttl.sub", {
              duration: metrics?.time_to_land_ms.p99 == null ? dash : duration(metrics.time_to_land_ms.p99),
            })}
          </div>
          <div className="strip-sub">{window}</div>
        </div>
        <div className="swarm-cell">
          <div className="strip-label">{t("swarm.gar")}</div>
          <div className="strip-value">{share(metrics?.go_around_rate)}</div>
          <div className="strip-sub">{window}</div>
        </div>
        <div className="swarm-cell">
          <div className="strip-label">{t("swarm.waiting")}</div>
          <div className="strip-value">{metrics === null ? dash : count(metrics.waiting_behind)}</div>
          <div className="strip-sub">{t("swarm.now")}</div>
        </div>
      </div>
      <div className="swarm-secondary">
        <span title={t("swarm.false_abort.tip")}>
          {t("swarm.false_abort", { share: [share(metrics?.false_abort_rate), share(FALSE_ABORT_TARGET)] })}
        </span>
        <span title={t("swarm.escape.tip")}>
          {t("swarm.escape", {
            share: [share(settings.features.green === "none" ? null : metrics?.escape_rate), share(ESCAPE_TARGET)],
          })}
        </span>
        <span>{t("swarm.backlog", { n: metrics === null ? dash : count(metrics.push_backlog) })}</span>
        <span>
          {floor.last_push === null
            ? t("swarm.last_push.unknown")
            : t("swarm.last_push", { n: floor.last_push.landings })}
        </span>
      </div>
    </div>
  );
}
