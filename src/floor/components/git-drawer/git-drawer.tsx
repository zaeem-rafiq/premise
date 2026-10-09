// The "show the git" drawer (03-floor 3.10, 2.5): it opens to the left of the Why sheet. Commit
// id, parent and tree in full; the commit message as git stores it; the note as indented JSON;
// the two plain-git commands and the clone command; `git.read_token`. Every id and command gets
// a copy button. The page never shows or holds a repository token (01-core SE5c).

import "./git-drawer.css";

import { useContext, useState } from "react";
import type { Note } from "../../../protocol/note.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { WhyCard } from "../../../protocol/reducer/why.ts";
import { ShellContext } from "../../app/context.ts";
import { commitMessage, noteCommands, noteJson } from "./model.ts";

export type GitDrawerProps = {
  floor: FloorState;
  card: WhyCard;
  /** What the note block shows: the note, "loading" while the route answers, "none" on 404/replay. */
  noteState: "held" | "loading" | "none";
  note: Note | null;
  onClose: () => void;
};

function CopyButton({ value }: { value: string }) {
  const shell = useContext(ShellContext)!;
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="git-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? shell.t("git.copied") : shell.t("git.copy")}
    </button>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="git-row">
      <span className="git-row__label">{label}</span>
      <code className="git-row__value" dir="auto">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}

export function GitDrawer({ floor, card, noteState, note, onClose }: GitDrawerProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const commands = noteCommands(floor.pool.remote);
  const json = noteJson(note);
  return (
    <aside className="git-drawer" role="complementary" aria-label={t("git.title")} data-state={noteState}>
      <header className="git-drawer__head">
        <h2 className="git-drawer__title">{t("git.title")}</h2>
        <button type="button" className="git-drawer__close" onClick={onClose}>
          {t("card.close")}
        </button>
      </header>

      <p className="git-lead">{t("git.commit_is")}</p>
      {card.commit !== null && <IdRow label={t("git.commit")} value={card.commit} />}
      {card.parentCommit !== null && <IdRow label={t("git.parent")} value={card.parentCommit} />}
      {card.tree !== null && <IdRow label={t("git.tree")} value={card.tree} />}

      <pre className="git-message" dir="auto">
        {commitMessage(floor, card)}
      </pre>

      <p className="git-lead">{t("git.note_is")}</p>
      {noteState === "held" && json !== null && (
        <pre className="git-note" dir="auto">
          {json}
        </pre>
      )}
      {noteState === "loading" && <p className="git-note-state">{t("git.loading_note")}</p>}
      {noteState === "none" && <p className="git-note-state">{t("git.no_note")}</p>}

      <p className="git-lead">{t("git.read_yourself")}</p>
      <div className="git-row">
        <code className="git-row__value">{commands.fetch}</code>
        <CopyButton value={commands.fetch} />
      </div>
      <div className="git-row">
        <code className="git-row__value">{commands.log}</code>
        <CopyButton value={commands.log} />
      </div>
      {commands.clone !== null && (
        <div className="git-row">
          <code className="git-row__value" dir="auto">
            {commands.clone}
          </code>
          <CopyButton value={commands.clone} />
        </div>
      )}
      <p className="git-token">{t("git.read_token")}</p>
    </aside>
  );
}
