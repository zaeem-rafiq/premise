/** RY23: the start card belongs to visitors looking at a quiet live pool, and to the person who
 * has just locked the page (beat 10: lock, then "Play the Replay"), quiet or not. */
export function showStartCard(
  owner: boolean,
  replay: boolean,
  quiet: boolean,
  dismissed: boolean,
  justLocked = false,
): boolean {
  return !owner && !replay && (quiet || justLocked) && !dismissed;
}
