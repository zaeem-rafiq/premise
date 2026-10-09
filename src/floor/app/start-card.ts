/** RY23: the start card belongs to visitors looking at a quiet live pool. */
export function showStartCard(owner: boolean, replay: boolean, quiet: boolean, dismissed: boolean): boolean {
  return !owner && !replay && quiet && !dismissed;
}
