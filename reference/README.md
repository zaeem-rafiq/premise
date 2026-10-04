# Reference material

This directory is not product code. It holds the working material that the
specification and the platform measurements were checked with. It is kept so
that an implementer can see how a rule or a number was arrived at.

| Directory | What it is |
| --- | --- |
| `spec-sim/` | The specification author's scratch simulator of the pure core (`sim.mjs`), its runner (`run.mjs`), and the generators for `docs/spec/premise-cases.json`. The cases were written by hand from the rules and then checked against this simulator. It has one author, so agreement shows the rules are consistent, not that they are right. |
| `tidepool-check/` | The tide pool designer's scenario simulations: the hero conflict in both landing orders, the second catch, colliding pairs, and the plain-merge comparison. `hero/` holds the creature files used in those scenarios. |
| `artifacts-spike/` | The throwaway harness that measured Cloudflare Artifacts from inside a Durable Object, with its local tests. `spike2/` is the small Worker that measured Dynamic Workers and Clef. Results: [`docs/measurements/spikes/2026-10-04-platform.md`](../docs/measurements/spikes/2026-10-04-platform.md). |

The product's own implementation lives under `src/` and is tested against
`docs/spec/premise-cases.json` and real git, not against this directory.
