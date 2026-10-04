// The shell's fallback pool area, drawn while `view.pool-area` is not registered (the
// floor-pool lane's wiring module registers it). It holds the region's layout: the caption
// bar and the 16:9 frame box with the states of 3.5 the shell owns (paused picture, the
// quiet-pool start card of RY23, `frame.landing` while a push is out). The sandboxed iframe
// and its SE16 channel belong to the floor-pool lane.

import { useContext } from "react";
import type { FloorState } from "../../protocol/reducer/state.ts";
import { ShellContext } from "./context.ts";
import { landingLabel } from "../../copy/format.ts";

export type PoolAreaFallbackProps = {
  floor: FloorState;
  mode: "live" | "replay";
  quiet: boolean; // RY23: visitor on a quiet pool sees the start card
  start: { duration: string } | null; // the default recording's duration, when known
  paused: boolean;
  landing: number; // landings in flight in the pending push (frame.landing)
  onStartPlay: () => void;
  onStartDismiss: () => void;
};

export function PoolAreaFallback(props: PoolAreaFallbackProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const { floor } = props;
  const caption =
    props.mode === "replay"
      ? t("frame.replay", { landing: landingLabel(floor.pool.landed_seq) })
      : floor.pool.landed_seq === 0
        ? t("frame.main.seed")
        : t("frame.main.caption", { landing: landingLabel(floor.pool.landed_seq) });
  return (
    <section className="pool-area" aria-label="pool">
      <div className="frame-bar">
        <span className="frame-caption">{caption}</span>
        {props.landing > 0 && <span className="frame-landing">{t("frame.landing", { n: props.landing })}</span>}
      </div>
      <div className="pool-frame" data-paused={props.paused}>
        {props.paused && <p className="frame-note">{t("frame.paused")}</p>}
        {props.quiet && props.mode === "live" && (
          <div className="start-card" role="group" aria-label={t("start.title")}>
            <h3>{t("start.title")}</h3>
            <p>{t("start.body")}</p>
            <div className="start-actions">
              <button type="button" className="primary" onClick={props.onStartPlay}>
                {t("start.play", { duration: props.start?.duration ?? "…" })}
              </button>
              <button type="button" onClick={props.onStartDismiss}>
                {t("start.look")}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
