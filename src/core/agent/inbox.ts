// src/core/agent/inbox.ts — heads-up ordering (HU1, HU6a, SP5).
//
// The five cases I01–I05 of docs/spec/premise-cases.json are the required
// behaviour of inboxNext:
//   I01  shown_hn 0, inbox {1,2}  → show {1,2}, no sync
//   I02  shown_hn 0, inbox {2}    → show {},    sync
//   I03  shown_hn 2, inbox {3,5}  → show {3},   sync
//   I04  shown_hn 2, inbox {}     → show {},    no sync
//   I05  shown_hn 2, inbox {1,2}  → show {},    no sync
//
// Pure: synchronous, no I/O, no Clock, no packages.

export type InboxNext = {
  // The contiguous run of heads-up numbers above shown_hn, in ascending
  // order; the run the next context row may show (SP5).
  show: number[];
  // Whether the Agent must call sync before it may show more heads-ups:
  // the inbox holds a number above the contiguous run, with a gap below
  // it (the missing ones come from the sync response).
  sync: boolean;
};

export function inboxNext(shown_hn: number, inbox: readonly number[]): InboxNext {
  const held = new Set(inbox);
  const show: number[] = [];
  for (let hn = shown_hn + 1; held.has(hn); hn += 1) {
    show.push(hn);
  }
  const top = show.at(-1) ?? shown_hn;
  return { show, sync: inbox.some((hn) => hn > top) };
}
