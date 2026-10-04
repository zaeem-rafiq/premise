// AX8: two live regions. Polite holds the non-urgent lines of 5.13 and every toast, at
// most one per second, merging more than five waiting lines into `sr.more`. Assertive
// holds the urgent lines immediately.

import { useContext, useEffect, useRef, useState } from "react";
import { ShellContext } from "../../app/context.ts";
import type { AnnouncedLine } from "./announce.ts";
import type { Toast } from "../../state/view-state.ts";

export function Announcer({ lines, toasts = [] }: { lines: AnnouncedLine[]; toasts?: Toast[] }) {
  const shell = useContext(ShellContext)!;
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const queue = useRef<string[]>([]);
  const fed = useRef(0);
  const heard = useRef(new Set<number>());

  useEffect(() => {
    const fresh = lines.slice(fed.current);
    fed.current = lines.length;
    for (const line of fresh) {
      if (line.urgent) setAssertive(line.text);
      else queue.current.push(line.text);
    }
    // Every toast is also a polite log line (3.19); a toast's own id dedupes it.
    for (const toast of toasts) {
      if (heard.current.has(toast.id)) continue;
      heard.current.add(toast.id);
      queue.current.push(toast.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lines.length, toasts]);

  useEffect(() => {
    const handle = window.setInterval(() => {
      const waiting = queue.current;
      if (waiting.length === 0) return;
      if (waiting.length > 5) {
        const first = waiting.shift()!;
        const rest = waiting.length;
        waiting.length = 0;
        setPolite(`${first} ${shell.t("sr.more", { n: rest })}`);
        return;
      }
      setPolite(waiting.shift()!);
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [shell]);

  return (
    <div className="sr-only">
      <div aria-live="polite" role="log" data-testid="sr-polite">
        {polite}
      </div>
      <div aria-live="assertive" role="alert" data-testid="sr-assertive">
        {assertive}
      </div>
    </div>
  );
}
