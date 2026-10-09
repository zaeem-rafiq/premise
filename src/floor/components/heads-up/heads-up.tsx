// The heads-up panel of an attempt card (03-floor 3.4): title, cause line, one block per item —
// the exact diff, before and after, added and context — the dropped edits and the closing line.
// The panel opens by itself for `repair`/`confirm` (CO11, the card owns that state); the owner
// toggles it with its header. Every string a message carries is rendered as text (FL8).

import "./heads-up.css";

import { useState } from "react";
import { text } from "../../../copy/strings.ts";
import type { HeadsUpModel, ItemBlock, UseLine } from "./model.ts";

/** CO19: before and after show at most 12 lines, then `headsup.show_all` unfolds the rest. */
const CODE_LINES_MAX = 12;

/** A before/after code block: the label, the source capped at 12 lines, then the toggle. */
function CodeBlock({ label, source, added = false }: { label: string; source: string; added?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = source.split("\n");
  const over = lines.length > CODE_LINES_MAX;
  const shown = (all ? lines : lines.slice(0, CODE_LINES_MAX)).join("\n");
  return (
    <div className="headsup-code">
      <span className="headsup-code__label">{label}</span>
      <pre className="headsup-code__text">
        <code>{added ? <mark className="headsup-code__added">{shown}</mark> : shown}</code>
      </pre>
      {over && !all && (
        <button type="button" className="headsup-code__more" onClick={() => setAll(true)}>
          {text("headsup.show_all", { n: lines.length })}
        </button>
      )}
    </div>
  );
}

function UseLines({ uses }: { uses: UseLine[] }) {
  if (uses.length === 0) return null;
  return (
    <div className="headsup-uses">
      <span className="headsup-code__label">{text("headsup.uses")}</span>
      <ul className="headsup-uses__list">
        {uses.map((use, index) => (
          <li key={index}>
            <span className="headsup-uses__ref" dir="auto">
              {use.path} line {use.line}
            </span>
            <code className="headsup-uses__text" dir="auto">
              {use.text}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One item block (3.4): the rule sentence, then the fields its `diff.kind` carries. */
function ItemView({ item }: { item: ItemBlock }) {
  const [all, setAll] = useState(false);
  const unified = item.unified === null ? null : item.unified.split("\n");
  return (
    <div className="headsup-item" data-kind={item.kind}>
      <p className="headsup-item__sentence">{item.sentence}</p>
      {item.kind === "entity" && (
        <div className="headsup-diff">
          {item.beforeUnavailable ? (
            <p className="headsup-note">{text("headsup.before_unavailable")}</p>
          ) : item.before === null ? (
            item.after !== null && <CodeBlock label={text("headsup.now")} source={item.after} />
          ) : (
            <>
              <CodeBlock label={text("headsup.before")} source={item.before} />
              {item.after !== null && <CodeBlock label={text("headsup.after")} source={item.after} />}
            </>
          )}
          {item.beforeUnavailable && item.after !== null && (
            <CodeBlock label={text("headsup.after")} source={item.after} />
          )}
        </div>
      )}
      {item.kind === "file" && unified !== null && (
        <div className="headsup-diff">
          <span className="headsup-code__label">
            {text("headsup.before")} / {text("headsup.after")}
          </span>
          <pre className="headsup-code__text">
            <code>{(all ? unified : unified.slice(0, CODE_LINES_MAX)).join("\n")}</code>
          </pre>
          {unified.length > CODE_LINES_MAX && !all && (
            <button type="button" className="headsup-code__more" onClick={() => setAll(true)}>
              {text("headsup.show_all", { n: unified.length })}
            </button>
          )}
        </div>
      )}
      {item.kind === "query" &&
        item.addedSources.map((entry, index) =>
          entry.source === null ? (
            <p className="headsup-note" key={index}>
              {text("headsup.added", { list: entry.label })}
            </p>
          ) : (
            <CodeBlock key={index} label={text("headsup.added", { list: entry.label })} source={entry.source} added />
          ),
        )}
      {item.kind !== "query" && item.added.length > 0 && (
        <p className="headsup-note">{text("headsup.added", { list: item.added.join(", ") })}</p>
      )}
      {item.removed.length > 0 && (
        <p className="headsup-note">{text("headsup.removed", { list: item.removed.join(", ") })}</p>
      )}
      {item.context.length > 0 && (
        <div className="headsup-context">
          <span className="headsup-code__label">{text("headsup.context")}</span>
          <ul>
            {item.context.map((entry, index) => (
              <li key={index} dir="auto">
                <CodeBlock label={entry.label} source={entry.source} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.kind === "check" && item.checkLabel !== null && (
        <p className="headsup-note">{text("headsup.check", { "check label": item.checkLabel })}</p>
      )}
      <UseLines uses={item.uses} />
      {item.truncated && <p className="headsup-note">{text("headsup.truncated")}</p>}
    </div>
  );
}

/** The panel itself: its edge is the state's colour (3.4 state table), its header toggles it. */
export function HeadsUpPanel({ model, open, onToggle }: { model: HeadsUpModel; open: boolean; onToggle: () => void }) {
  return (
    <section className={`headsup headsup--${model.tone}`} data-hn={model.hn}>
      <button type="button" className="headsup__head" aria-expanded={open} onClick={onToggle}>
        <span className="headsup__title">{model.title}</span>
      </button>
      {open && (
        <div className="headsup__body">
          <p className="headsup__cause" dir="auto">
            {model.cause}
          </p>
          {model.items === null ? (
            <>
              {model.keySentences.map((sentence, index) => (
                <p className="headsup-item__sentence" key={index} dir="auto">
                  {sentence}
                </p>
              ))}
              <p className="headsup-note">{text("headsup.no_diff")}</p>
            </>
          ) : (
            model.items.map((item, index) => <ItemView key={index} item={item} />)
          )}
          {model.dropped.map((line, index) => (
            <p className="headsup-note" key={index} dir="auto">
              {line}
            </p>
          ))}
          {model.tail !== null && <p className="headsup__tail">{model.tail.sentence}</p>}
        </div>
      )}
    </section>
  );
}
