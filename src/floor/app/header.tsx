// The header (03 2.10, 3.19): the `banner` landmark - the name, the view switch with
// `aria-current`, the Needs-you badge (absent at 0), the kill switch (owner, live) and the
// owner lock. `nav.skip` is the first focus stop (AX2).

import { useContext } from "react";
import { ShellContext } from "./context.ts";

export type HeaderProps = {
  pool: string; // the pool name in the address (FE7), or the recording's pool
  view: "floor" | "compare" | "swarm";
  mode: "live" | "replay";
  needs: number; // open cards that can be answered
  owner: boolean;
  killed: boolean; // limits.killed - the button becomes kill.allow
  onView: (view: "floor" | "compare" | "swarm") => void;
  onReplayMenu: () => void;
  onAbout: () => void;
  onNeeds: () => void;
  onOwner: () => void;
  onKill: () => void;
};

export function Header(props: HeaderProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const item = (view: "floor" | "swarm", label: string) => (
    <button
      type="button"
      className="nav-item"
      aria-current={props.view === view ? "page" : undefined}
      onClick={() => props.onView(view)}
    >
      {label}
    </button>
  );
  return (
    <header className="header">
      <a className="skip-link" href="#rail">
        {t("nav.skip")}
      </a>
      <div className="header-name">
        <span className="app-name">{t("app.name")}</span>
        <span className="pool-name">{props.pool}</span>
      </div>
      <nav className="view-switch" aria-label="views">
        {item("floor", t("nav.floor"))}
        {item("swarm", t("nav.swarm"))}
        <button type="button" className="nav-item" onClick={props.onReplayMenu}>
          {t("nav.replay")}
        </button>
        <button type="button" className="nav-item" onClick={props.onAbout}>
          {t("nav.about")}
        </button>
      </nav>
      {props.needs > 0 && (
        <button type="button" className="needs-badge" onClick={props.onNeeds}>
          {t("needs.badge", { n: props.needs })}
        </button>
      )}
      <div className="header-end">
        {props.mode === "live" && props.owner && (
          <button type="button" className="kill-open" onClick={props.onKill}>
            {props.killed ? t("kill.allow") : t("kill.open")}
          </button>
        )}
        <button type="button" className="owner-button" onClick={props.onOwner} disabled={props.mode === "replay"}>
          {props.mode === "replay" ? t("owner.replay") : props.owner ? t("owner.unlocked") : t("owner.visitor")}
        </button>
      </div>
    </header>
  );
}
