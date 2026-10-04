// The About sheet (3.19, 5.12): `about.how` (the fixed seven-box diagram), `about.run`
// (counts from the stream), `about.limits` (the limits list of `/floor.json`, the same
// source the README shows) and `about.related`. A `dialog` named by its title (AX6).

import { useContext, useEffect, useRef } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { ABOUT_HOW_BOXES, SHORTCUT_ROWS } from "../../../copy/strings.ts";
import { money } from "../../../copy/format.ts";

export function AboutSheet({
  floor,
  shortcuts,
  onShortcuts,
  onClose,
}: {
  floor: FloorState;
  shortcuts: boolean;
  onShortcuts: (on: boolean) => void;
  onClose: () => void;
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const models = [
    ...new Set(
      Object.values(floor.attempts)
        .map((a) => a.model)
        .filter((m): m is string => m !== null),
    ),
  ].map((id) => shell.model(id));
  const synthetic = Object.values(floor.attempts).filter((a) => a.agent === "synthetic").length;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet about-sheet"
        role="dialog"
        aria-label={t("about.title")}
        tabIndex={-1}
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="sheet-title">{t("about.title")}</h2>
        <div className="about-columns">
          <section>
            <h3>{t("about.how")}</h3>
            <ol className="about-how">
              {ABOUT_HOW_BOXES.map((box) => (
                <li key={box}>{box}</li>
              ))}
            </ol>
          </section>
          <section>
            <h3>{t("about.run")}</h3>
            <p>{t("about.run.real", { max: floor.pool.max_real_agents, models: models.join(", ") || "—" })}</p>
            <p>{t("about.run.landed", { n: [floor.counters.landed_changes, floor.counters.go_arounds] })}</p>
            {synthetic > 0 && <p>{t("about.run.synthetic", { n: synthetic })}</p>}
            {floor.plain !== null && <p>{t("about.run.constructed")}</p>}
            {floor.limits !== null && (
              <p>{t("about.run.spend", { spent: money(floor.limits.spend_usd), cap: money(floor.limits.cap_usd) })}</p>
            )}
            {floor.unknown_events > 0 && <p>{t("about.unknown_events", { n: floor.unknown_events })}</p>}
            {floor.trunk_errors > 0 && <p>{t("about.trunk_errors", { n: floor.trunk_errors })}</p>}
          </section>
          <section>
            <h3>{t("about.limits")}</h3>
            <ul className="about-limits">
              {shell.settings.limits.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <h3>{t("about.related")}</h3>
            <p>{shell.settings.related}</p>
          </section>
        </div>
        <section className="about-keys">
          <h3>{t("shortcuts.title")}</h3>
          <label className="field field-check">
            <input type="checkbox" checked={shortcuts} onChange={(event) => onShortcuts(event.target.checked)} />
            <span>{t("shortcuts.toggle")}</span>
          </label>
          <table className="shortcut-table">
            <tbody>
              {SHORTCUT_ROWS.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.key}</th>
                  <td>{row.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            {t("owner.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
