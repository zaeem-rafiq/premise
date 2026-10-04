// The thirty-six pre-written requests of 02-tidepool section 9, in the order of its tables
// (9.1, then 9.2, then 9.3): `group` is the row's group, `"starter"` or `null`; `race` is true
// for P1a only — the request the video sends to three models.
//
// GENERATED from docs/spec/02-tidepool.md section 9 by the Slice 0b build; floor-json.test.ts keeps it
// equal to the tables. Do not edit by hand: regenerate or update the spec.

import type { PrewrittenIntent } from "../protocol/floor-json.ts";

export const PREWRITTEN: readonly PrewrittenIntent[] = [
  { id: "A01", text: "a jellyfish that drifts up and down", group: "starter", race: false },
  { id: "A02", text: "a seahorse that bobs up and down", group: null, race: false },
  { id: "A03", text: "a starfish that sits on the sand and slowly turns", group: "starter", race: false },
  { id: "A04", text: "a sea urchin on the sand that waves its spines", group: "starter", race: false },
  { id: "A05", text: "a manta ray that glides in wide slow circles", group: null, race: false },
  { id: "A06", text: "an octopus that is dark at night and bright in the day", group: "starter", race: false },
  { id: "A07", text: "an anglerfish whose light only shows at night", group: null, race: false },
  { id: "A08", text: "a school of eight tiny blue fish that stay together", group: null, race: false },
  { id: "A09", text: "an eel that goes straight for the nearest food", group: null, race: false },
  { id: "A10", text: "a pufferfish that puffs up when another creature comes close", group: null, race: false },
  {
    id: "A11",
    text: "a lobster that walks along the sand and turns around at the walls",
    group: "starter",
    race: false,
  },
  { id: "A12", text: "a little cleaner fish that follows the turtle around", group: null, race: false },
  { id: "R01", text: "make energy a fraction from 0 to 1", group: null, race: false },
  { id: "R02", text: "make the day twice as long", group: null, race: false },
  { id: "R03", text: "let creatures swim half as fast again at top speed", group: null, race: false },
  { id: "R04", text: "lower the water line so there is more sky", group: null, race: false },
  { id: "R05", text: "drop food twice as often", group: null, race: false },
  {
    id: "R06",
    text: "the side walls are solid now: nothing swims out one side and back in the other",
    group: null,
    race: false,
  },
  { id: "R07", text: "tired creatures should rest for half as long", group: null, race: false },
  { id: "R08", text: "one pellet of food should fill half a creature's energy", group: null, race: false },
  { id: "R09", text: "make the night shorter: only the last third of the day is dark", group: null, race: false },
  { id: "R10", text: "tidy the comments in the energy rules so they are easier to read", group: null, race: false },
  { id: "R11", text: "resting creatures should float up to the surface instead of sinking", group: null, race: false },
  { id: "R12", text: "make the sand darker and the water greener", group: null, race: false },
  { id: "P1a", text: "a crab that hides in its shell when its energy drops below 30", group: null, race: true },
  {
    id: "P1b",
    text: "a shrimp that darts every two seconds and spends 5 energy on each dart",
    group: "starter",
    race: false,
  },
  { id: "P2a", text: "repaint every creature in gold", group: null, race: false },
  {
    id: "P3a",
    text: "make every creature that swims out one side and back in the other turn around at the walls instead",
    group: null,
    race: false,
  },
  {
    id: "P3b",
    text: "a ray that glides across the pool and comes back in on the other side",
    group: null,
    race: false,
  },
  { id: "P4b", text: "make the day half as long", group: null, race: false },
  { id: "P4c", text: "make the day three times as long", group: null, race: false },
  { id: "P5b", text: "a crab that walks sideways and waves one big claw", group: null, race: false },
  { id: "P6b", text: "a lily pad that floats on the water line", group: null, race: false },
  { id: "P8b", text: "a sailfish that always swims at top speed", group: null, race: false },
  {
    id: "P9a",
    text: "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy",
    group: null,
    race: false,
  },
  {
    id: "P9b",
    text: "a squid that shoots forward every three seconds and spends a tenth of its energy on each burst",
    group: null,
    race: false,
  },
];
