#!/usr/bin/env python3
"""Builds docs/spec/premise-cases.json. Expected values are written by hand from
the rules in 01-core.md; this script only assembles the JSON."""
import json, sys

OUT = sys.argv[1]

POLICY = '{\n  "v": 1,\n  "default": "held",\n  "tiers": [\n    { "paths": ["creatures/**", "world/**"], "tier": "auto" }\n  ]\n}\n'
POLICY_HELD = '{\n  "v": 1,\n  "default": "held",\n  "tiers": [\n    { "paths": ["creatures/**"], "tier": "auto" },\n    { "paths": ["world/**"], "tier": "held" }\n  ]\n}\n'

ENERGY = (
    "// Energy is counted in points, from 0 to ENERGY_MAX.\n"
    "export const ENERGY_MAX = 100;\n"
    "\n"
    "// Remove energy from a creature. `amount` is in points per tick.\n"
    "export function drain(creature, amount) {\n"
    "  creature.energy = Math.max(0, creature.energy - amount);\n"
    "}\n"
)
MOVEMENT = (
    "export const MAX_SPEED = 2;\n"
    "\n"
    "export function step(creature) {\n"
    "  creature.x += creature.vx;\n"
    "  creature.y += creature.vy;\n"
    "}\n"
)
FISH = (
    'import { ENERGY_MAX, drain } from "../world/energy.js";\n'
    'import { step } from "../world/movement.js";\n'
    "\n"
    "export function spawn() {\n"
    "  return { x: 40, y: 60, vx: 1, vy: 0, energy: ENERGY_MAX };\n"
    "}\n"
    "\n"
    "export function update(fish) {\n"
    "  step(fish);\n"
    "  drain(fish, 1);\n"
    "}\n"
)
SNAIL = (
    'import { ENERGY_MAX } from "../world/energy.js";\n'
    "\n"
    "export function spawn() {\n"
    "  return { x: 10, y: 190, vx: 0, vy: 0, energy: ENERGY_MAX };\n"
    "}\n"
    "\n"
    "export function update(snail) {\n"
    "  snail.x += 0.1;\n"
    "}\n"
)

def crab(threshold):
    return (
        'import { ENERGY_MAX } from "../world/energy.js";\n'
        "\n"
        "export function spawn() {\n"
        "  return { x: 20, y: 180, vx: 0, vy: 0, energy: ENERGY_MAX };\n"
        "}\n"
        "\n"
        "export function update(crab) {\n"
        "  crab.hiding = crab.energy < %s;\n"
        "}\n" % threshold
    )
CRAB_30 = crab("30")
CRAB_03 = crab("0.3")

def crab_drain(amount):
    return (
        'import { drain } from "../world/energy.js";\n'
        "\n"
        "export function spawn() {\n"
        "  return { x: 20, y: 180, vx: 0, vy: 0, energy: 60 };\n"
        "}\n"
        "\n"
        "export function update(crab) {\n"
        "  drain(crab, %s);\n"
        "}\n" % amount
    )
EEL = (
    'import { MAX_SPEED } from "../world/movement.js";\n'
    "\n"
    "export function spawn() {\n"
    "  return { x: 5, y: 100, vx: MAX_SPEED, vy: 0, energy: 50 };\n"
    "}\n"
)
def plain(x):
    return "export function spawn() {\n  return { x: %d, y: 195, vx: 0, vy: 0, energy: 50 };\n}\n" % x
URCHIN, ANEMONE, LIMPET = plain(150), plain(200), plain(250)

K_EMAX = "world/energy.js#ENERGY_MAX"
K_DRAIN = "world/energy.js#drain"
K_SPEED = "world/movement.js#MAX_SPEED"
K_STEP = "world/movement.js#step"
CRAB = "creatures/crab.js"
CRAB_IMPORT = "creatures/crab.js#(import ../world/energy.js)"
REFS_EMAX_0 = [
    "creatures/fish.js#(import ../world/energy.js)", "creatures/fish.js#spawn",
    "creatures/snail.js#(import ../world/energy.js)", "creatures/snail.js#spawn",
]

def P(kind, key, at=None, read=False, edit=False, derived=False, absent=False):
    d = {"kind": kind, "key": key}
    if absent: d["hash"] = "absent"
    else: d["at"] = at
    d.update(read=read, edit=edit, derived=derived)
    return d

def S(by, do, args=None, **expect):
    st = {}
    if by: st["by"] = by
    st["do"] = do
    if args is not None: st["args"] = args
    for k in ("call_id", "ack"):
        if k in expect: st[k] = expect.pop(k)
    if expect: st["expect"] = expect
    return st

def read_e(by, key, at=0, **kw):
    path, name = key.split("#")
    return S(by, "read", {"path": path, "entity": name}, ok=True,
             premises=[P("entity", key, at, read=True, **kw)])
def read_f(by, path, at=0, **kw):
    return S(by, "read", {"path": path}, ok=True, premises=[P("file", path, at, read=True, **kw)])
def item(kind, key, rule, result, **kw):
    d = {"kind": kind, "key": key, "rule": rule, "result": result}; d.update(kw); return d
def hu(to, hn, result, items, **kw):
    d = {"to": to, "hn": hn, "result": result, "items": items}; d.update(kw); return d
def J(attempt, kind, key, rule, cls, result=None):
    d = {"attempt": attempt, "kind": kind, "key": key, "rule": rule, "class": cls}
    if result: d["result"] = result
    return d
def submit(by, summary, ack=None, statement=None, **expect):
    a = {"summary": summary}
    if ack is not None: a["acknowledge"] = ack; a["statement"] = statement
    return S(by, "submit", a, **expect)
def tick(**e): return S(None, "tick", None, **e)
def push_ok(landed, **e): return S(None, "push_ok", None, landed=landed, **e)

cases = []
def case(id, title, rules, attempts, steps, final, **kw):
    c = {"id": id, "title": title, "rules": rules, "pool": "tidepool"}
    for k in ("files", "constants"):
        if k in kw: c[k] = kw.pop(k)
    c["attempts"] = {k: (v if isinstance(v, dict) else {"intent": v}) for k, v in attempts.items()}
    c["steps"] = steps
    c["final"] = final
    if "note" in kw: c["note"] = kw["note"]
    cases.append(c)

I_CRAB = "a crab that hides when its energy is low"
I_FRACTION = "make energy a fraction from 0 to 1"
I_EEL = "an eel that swims at top speed"

# ---------------------------------------------------------------- C01
case("C01-disjoint-batch",
     "Two changes that share nothing land in one batch, in one push",
     ["9.4", "LP2", "D1", "W4", "TA7"],
     {"A": I_CRAB, "B": I_EEL},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True,
           result={"created": True, "added": [CRAB_IMPORT, CRAB + "#spawn", CRAB + "#update"], "altered": [], "removed": []},
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", K_EMAX, 0, read=True, derived=True)]),
         submit("A", "Add a crab that hides when its energy is low", status="validated",
                premises=[], states={"A": "validated"}),
         read_e("B", K_SPEED),
         S("B", "write", {"path": "creatures/eel.js", "content": EEL}, ok=True,
           premises=[P("file", "creatures/eel.js", absent=True, edit=True), P("entity", K_SPEED, 0, read=True, derived=True)]),
         submit("B", "Add an eel", status="validated", premises=[]),
         tick(accepted=["A", "B"], skipped={}, landings=[{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "B", "kind": "change"}],
              heads_ups=[], judgments=[], states={"A": "accepted", "B": "accepted"},
              events_include=["landing.accepted"], events_exclude=["landing.landed"]),
         push_ok([1, 2], states={"A": "landed", "B": "landed"}, events_include=["batch.pushed", "landing.landed"]),
     ],
     {"head_seq": 2, "files": {CRAB: CRAB_30, "creatures/eel.js": EEL},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "B", "kind": "change"}]})

# ---------------------------------------------------------------- C02
MOVEMENT_C02 = MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 3").replace("creature.x += creature.vx;", "creature.x += creature.vx * 0.5;")
case("C02-same-file-different-entities",
     "Two replaces in one file that touch different entities are disjoint and land in one batch",
     ["9.4 step 3b", "R4", "D2", "E0", "5.3"],
     {"A": "creatures drift half as fast sideways", "B": "raise the top speed to 3"},
     [
         read_e("A", K_STEP),
         S("A", "replace", {"path": "world/movement.js", "old": "creature.x += creature.vx;", "new": "creature.x += creature.vx * 0.5;"}, ok=True,
           result={"targets": [K_STEP], "altered": [K_STEP],
                   "relied_on_by": {K_STEP: ["creatures/fish.js#(import ../world/movement.js)", "creatures/fish.js#update"]}},
           premises=[P("entity", K_STEP, 0, read=True, edit=True), P("query", "refs:" + K_STEP, 0, derived=True)]),
         submit("A", "Halve sideways drift", status="validated", premises=[]),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True,
           result={"targets": [K_SPEED], "altered": [K_SPEED], "relied_on_by": {K_SPEED: []}},
           premises=[P("entity", K_SPEED, 0, read=True, edit=True), P("query", "refs:" + K_SPEED, 0, derived=True)]),
         submit("B", "Raise MAX_SPEED to 3", status="validated", premises=[]),
         tick(accepted=["A", "B"], skipped={}, heads_ups=[], judgments=[]),
         push_ok([1, 2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT_C02}, "states": {"A": "landed", "B": "landed"},
      "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "B", "kind": "change"}]},
     note="B's premises (entity MAX_SPEED, refs:MAX_SPEED) are untouched by A's landing, and B's replace still matches exactly once in MAX_SPEED after A, so B is disjoint from the batch.")

# ---------------------------------------------------------------- C03
case("C03-same-entity-twice",
     "Two changes to one entity: the second is sent around with its replace dropped, then lands on top",
     ["E1", "OP1", "OP6", "T8", "GA1", "9.4 step 3b", "CK1"],
     {"A": "raise the top speed to 3", "B": "raise the top speed to 4"},
     [
         read_e("A", K_SPEED),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("A", "Raise MAX_SPEED to 3", status="validated"),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 4"}, ok=True),
         submit("B", "Raise MAX_SPEED to 4", status="validated"),
         tick(accepted=["A"], skipped={"B": "not_disjoint"},
              judgments=[J("B", "entity", K_SPEED, "E1", "rule", "repair")],
              heads_ups=[hu("B", 1, "repair", [item("entity", K_SPEED, "E1", "repair")], dropped_ops=[{"op_seq": 1, "rule": "OP1"}])],
              states={"A": "accepted", "B": "going_around"}, go_arounds={"B": 1}),
         push_ok([1], states={"A": "landed"}),
         read_e("B", K_SPEED, at=1),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 3", "new": "MAX_SPEED = 4"}, ok=True,
           premises=[P("entity", K_SPEED, 1, read=True, edit=True), P("query", "refs:" + K_SPEED, 1, derived=True)]),
         submit("B", "Raise MAX_SPEED to 4", [1], "Re-applied on top of the new value 3.", status="validated", states={"B": "validated"}),
         tick(accepted=["B"], heads_ups=[]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 4")},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 1},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "B", "kind": "change"}]})

# ---------------------------------------------------------------- C04
ENERGY_1 = ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 1")
case("C04-hero-shared-rule-lands-first",
     "Meaning change behind an unchanged name: the shared rule lands first, the in-flight creature references it and is repaired",
     ["6.5", "D1", "E2", "HU1", "T8", "CK1"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True,
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", K_EMAX, 0, read=True, derived=True)]),
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True,
           result={"targets": [K_EMAX], "altered": [K_EMAX], "relied_on_by": {K_EMAX: REFS_EMAX_0}},
           premises=[P("entity", K_EMAX, 0, read=True, edit=True), P("query", "refs:" + K_EMAX, 0, derived=True)]),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"],
              judgments=[J("A", "entity", K_EMAX, "E2", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("entity", K_EMAX, "E2", "repair", after_contains="ENERGY_MAX = 1;")], dropped_ops=[])],
              states={"S": "accepted", "A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 0.3"}, ok=True,
           result={"targets": [CRAB + "#update"], "altered": []}, premises=[]),
         submit("A", "Add a crab that hides when its energy is low", [1], "Energy is now a fraction from 0 to 1, so the hide threshold is 0.3.",
                status="validated", premises=[]),
         tick(accepted=["A"], heads_ups=[]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, CRAB: CRAB_03},
      "states": {"A": "landed", "S": "landed"}, "go_arounds": {"A": 1, "S": 0},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="A text merge of these two changes has nothing to report: different files, and the import of ENERGY_MAX stays valid. Without the go-around the crab starts with energy 1 and 1 < 30, so it hides for ever.")

# ---------------------------------------------------------------- C05
case("C05-hero-creature-lands-first",
     "The same conflict in the other order: the creature lands first, and the in-flight shared-rule change learns of the new referrer",
     ["6.5", "D2", "QR1", "HU1", "R4", "8.2 context"],
     {"S": I_FRACTION, "A": I_CRAB},
     [
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True,
           premises=[P("entity", K_EMAX, 0, read=True, edit=True), P("query", "refs:" + K_EMAX, 0, derived=True)]),
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", status="validated"),
         tick(accepted=["A"],
              judgments=[J("S", "query", "refs:" + K_EMAX, "QR1", "rule", "repair")],
              heads_ups=[hu("S", 1, "repair", [item("query", "refs:" + K_EMAX, "QR1", "repair", added=[CRAB_IMPORT, CRAB + "#spawn"], context=[CRAB + "#update"])], dropped_ops=[])],
              states={"A": "accepted", "S": "going_around"}, go_arounds={"S": 1}),
         push_ok([1]),
         S("S", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 0.3"}, ok=True,
           result={"targets": [CRAB + "#update"], "altered": [CRAB + "#update"], "relied_on_by": {CRAB + "#update": []}},
           premises=[P("entity", CRAB + "#update", 1, edit=True), P("query", "refs:" + CRAB + "#update", 1, derived=True),
                     P("entity", K_EMAX, 1, read=True, edit=True, derived=True)]),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", [1], "The new crab compared energy with 30; changed it to 0.3 in the same change.",
                status="validated", premises=[]),
         tick(accepted=["S"], heads_ups=[]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, CRAB: CRAB_03},
      "states": {"A": "landed", "S": "landed"}, "go_arounds": {"A": 0, "S": 1},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "S", "kind": "change"}]},
     note="S's entity premise on ENERGY_MAX still holds when the crab lands. The catch comes from the derived refs: premise pinned when S altered ENERGY_MAX. The item's context carries crab.js#update, the entity with the line that breaks, so S can fix it without a read (R1 needs none). S's replace touches crab.js, whose other entities reference ENERGY_MAX, so that premise gains the derived flag (ModuleRefs).")

# ---------------------------------------------------------------- C06
case("C06-read-not-referenced-triage",
     "The agent read an entity that changed but its patch does not name it: Clef triage zone (class only), then the fail-closed outcome",
     ["E3", "7.3 TR1", "V1", "T5", "CK8"],
     {"A": I_CRAB, "B": "raise the top speed to 3"},
     [
         read_e("A", K_SPEED),
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "entity", K_SPEED, "E3", "triage")],
              heads_ups=[hu("A", 1, "info", [item("entity", K_SPEED, "E3", "pending", after_contains="MAX_SPEED = 3;")], dropped_ops=[], wake=False)],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
         S(None, "triage", {"attempt": "A", "kind": "entity", "key": K_SPEED, "p": None},
           judgments=[J("A", "entity", K_SPEED, "E3", "triage", "confirm")],
           heads_ups=[hu("A", 2, "confirm", [item("entity", K_SPEED, "E3", "confirm")], dropped_ops=[], wake=True)],
           states={"A": "working"}, go_arounds={"A": 0}),
         submit("A", "Add a crab that hides when its energy is low", status="needs_confirm", states={"A": "needs_confirm"}),
         submit("A", "Add a crab that hides when its energy is low", [2], "The crab does not use MAX_SPEED.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {CRAB: CRAB_30}, "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="At the landing the judgment is pending, and an info heads-up already carries the diff (TR1), so the agent cannot write or submit without it (TA3). p = null models Clef being unavailable, which gives confirm in a second heads-up.")

# ---------------------------------------------------------------- C07
case("C07-triage-thresholds",
     "Triage probabilities map to repair, confirm and re-affirm; the diff was already delivered by the info heads-up of the landing",
     ["7.3 TR1", "TR3", "E3", "HU3", "7.4"],
     {"A1": "an urchin on the floor", "A2": "an anemone on the floor", "A3": "a limpet on the floor", "B": "raise the top speed to 3"},
     [
         read_e("A1", K_SPEED), S("A1", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         read_e("A2", K_SPEED), S("A2", "write", {"path": "creatures/anemone.js", "content": ANEMONE}, ok=True),
         read_e("A3", K_SPEED), S("A3", "write", {"path": "creatures/limpet.js", "content": LIMPET}, ok=True),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         tick(accepted=["B"],
              heads_ups=[hu(n, 1, "info", [item("entity", K_SPEED, "E3", "pending")], dropped_ops=[], wake=False) for n in ("A1", "A2", "A3")],
              judgments=[J("A1", "entity", K_SPEED, "E3", "triage"), J("A2", "entity", K_SPEED, "E3", "triage"), J("A3", "entity", K_SPEED, "E3", "triage")]),
         push_ok([1]),
         S(None, "triage", {"attempt": "A1", "kind": "entity", "key": K_SPEED, "p": 0.9},
           judgments=[J("A1", "entity", K_SPEED, "E3", "triage", "repair")],
           heads_ups=[hu("A1", 2, "repair", [item("entity", K_SPEED, "E3", "repair")], dropped_ops=[])],
           states={"A1": "going_around"}, go_arounds={"A1": 1}),
         S(None, "triage", {"attempt": "A2", "kind": "entity", "key": K_SPEED, "p": 0.5},
           judgments=[J("A2", "entity", K_SPEED, "E3", "triage", "confirm")],
           heads_ups=[hu("A2", 2, "confirm", [item("entity", K_SPEED, "E3", "confirm")], dropped_ops=[])],
           states={"A2": "working"}, go_arounds={"A2": 0}),
         S(None, "triage", {"attempt": "A3", "kind": "entity", "key": K_SPEED, "p": 0.05},
           judgments=[J("A3", "entity", K_SPEED, "E3", "triage", "holds")],
           heads_ups=[], states={"A3": "working"}, go_arounds={"A3": 0}),
         submit("A3", "Add a limpet", status="validated"),
     ],
     {"head_seq": 1, "files": {"world/movement.js": MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 3")},
      "states": {"A1": "going_around", "A2": "working", "A3": "validated", "B": "landed"},
      "go_arounds": {"A1": 1, "A2": 0, "A3": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}]},
     constants={"T_REPAIR": 0.7, "T_CONFIRM": 0.2},
     note="A3 needs no acknowledgement: an info heads-up does not block a submit once delivered. A re-affirmed premise gets no second heads-up; its judgment is recorded with the probability.")

# ---------------------------------------------------------------- C08
COMMENT_OLD = "// Remove energy from a creature. `amount` is in points per tick."
COMMENT_NEW = "// Remove energy from a creature.\n// `amount` is in points per tick."
case("C08-cosmetic-change-holds",
     "A comment-only landing breaks no premise: the entity hash is unchanged and the file premise holds by rule F2",
     ["2.4", "E0", "F2", "R4", "CK3"],
     {"A": "a crab that tires quickly", "B": "tidy the comment above drain"},
     [
         read_f("A", "world/energy.js"),
         read_e("A", K_DRAIN),
         S("A", "write", {"path": CRAB, "content": crab_drain("2")}, ok=True),
         S("B", "replace", {"path": "world/energy.js", "old": COMMENT_OLD, "new": COMMENT_NEW}, ok=True,
           result={"targets": [K_DRAIN], "altered": [], "added": [], "removed": []},
           premises=[P("entity", K_DRAIN, 0, edit=True)]),
         submit("B", "Split the comment above drain", status="validated"),
         tick(accepted=["B"], heads_ups=[], judgments=[J("A", "file", "world/energy.js", "F2", "rule", "holds")],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
         submit("A", "Add a crab that tires quickly", status="validated", premises=[]),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY.replace(COMMENT_OLD, COMMENT_NEW), CRAB: crab_drain("2")},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="A's entity premise on drain keeps its pin at seq 0 because the entity hash never changed.")

# ---------------------------------------------------------------- C09
case("C09-blind-spot-confirm",
     "The new code references an entity the agent never read: one confirm turn with the current definition, not a rejection",
     ["6.4", "B1", "B2", "B3", "D1", "CK7", "CK8", "T5"],
     {"A": I_CRAB},
     [
         S("A", "outline", {"path": "world/energy.js"}, ok=True,
           premises=[P("query", "outline:world/energy.js", 0, read=True)]),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True,
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", K_EMAX, 0, derived=True)]),
         submit("A", "Add a crab that hides when its energy is low", status="needs_confirm",
                premises=[],
                judgments=[J("A", "entity", K_EMAX, "B1", "rule", "confirm")],
                heads_ups=[hu("A", 1, "confirm", [item("entity", K_EMAX, "B1", "confirm", after_contains="ENERGY_MAX = 100;")], cause="submit", dropped_ops=[])],
                states={"A": "needs_confirm"}, go_arounds={"A": 0}),
         submit("A", "Add a crab that hides when its energy is low", [1], "ENERGY_MAX is 100 points; the threshold 30 is on that scale.",
                status="validated", heads_ups=[], judgments=[]),
         tick(accepted=["A"]),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {CRAB: CRAB_30}, "states": {"A": "landed"}, "go_arounds": {"A": 0},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}]})

# ---------------------------------------------------------------- C10
case("C10-unread-reference-changes-after-write",
     "The hero conflict when the creature's agent never read the shared rule: the derived premise pinned at the write catches the change live, with the diff",
     ["6.5", "D1", "D3", "E2", "QO0", "B1"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         S("A", "outline", {"path": "world/energy.js"}, ok=True),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True,
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", K_EMAX, 0, derived=True)]),
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], judgments=[J("A", "entity", K_EMAX, "E2", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("entity", K_EMAX, "E2", "repair", after_contains="ENERGY_MAX = 1;")], dropped_ops=[])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 0.3"}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", [1], "ENERGY_MAX is 1, so the hide threshold is 0.3.", status="validated",
                heads_ups=[], judgments=[]),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, CRAB: CRAB_03}, "states": {"A": "landed", "S": "landed"},
      "go_arounds": {"A": 1, "S": 0},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="The outline of world/energy.js does not change when the value changes (QO0). The catch comes from the derived premise that rule D1 pinned when A wrote code that references ENERGY_MAX. The heads-up showed A the new definition, so the submit raises no blind spot.")

# ---------------------------------------------------------------- C11
FISH_HALF = FISH.replace("drain(fish, 1)", "drain(fish, 0.5)")
case("C11-search-sweep-gains-match",
     "A text search the agent is sweeping gains a match: rule-based repair",
     ["2.6", "QT1", "HU1", "D1"],
     {"A": "halve how fast every creature tires", "B": "a crab that tires quickly"},
     [
         S("A", "search", {"query": "drain(", "path": "creatures/"}, ok=True,
           result={"containers": ["creatures/fish.js#update"]},
           premises=[P("query", "text:creatures/:drain(", 0, read=True)]),
         read_e("A", K_DRAIN), read_e("A", K_STEP),
         read_e("A", "creatures/fish.js#update"),
         S("A", "replace", {"path": "creatures/fish.js", "old": "drain(fish, 1)", "new": "drain(fish, 0.5)"}, ok=True,
           result={"targets": ["creatures/fish.js#update"], "altered": ["creatures/fish.js#update"]},
           premises=[P("entity", "creatures/fish.js#update", 0, read=True, edit=True), P("query", "refs:creatures/fish.js#update", 0, derived=True),
                     P("entity", K_DRAIN, 0, read=True, derived=True), P("entity", K_STEP, 0, read=True, derived=True),
                     P("entity", K_EMAX, 0, derived=True)]),
         read_e("B", K_DRAIN),
         S("B", "write", {"path": CRAB, "content": crab_drain("2")}, ok=True),
         submit("B", "Add a crab that tires quickly", status="validated"),
         tick(accepted=["B"],
              judgments=[J("A", "query", "text:creatures/:drain(", "QT1", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("query", "text:creatures/:drain(", "QT1", "repair", added=[CRAB + "#update"])], dropped_ops=[])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         read_e("A", CRAB + "#update", at=1),
         S("A", "replace", {"path": CRAB, "old": "drain(crab, 2)", "new": "drain(crab, 1)"}, ok=True,
           premises=[P("entity", CRAB + "#update", 1, read=True, edit=True), P("query", "refs:" + CRAB + "#update", 1, derived=True)]),
         submit("A", "Halve every drain call", [1], "Halved the new crab's drain as well.", status="validated", premises=[]),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"creatures/fish.js": FISH_HALF, CRAB: crab_drain("1")},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 1, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="A new file never conflicts textually with an edit to another file. The catch comes from the query premise: A altered the only match it found (a sweep of the whole match set), and a new match appeared. The derived premise on ENERGY_MAX comes from fish.js#spawn, an entity A did not alter (ModuleRefs).")

# ---------------------------------------------------------------- C12
TEXT_ENERGY_0 = ["creatures/fish.js#(import ../world/energy.js)", "creatures/fish.js#spawn",
                 "creatures/snail.js#(import ../world/energy.js)", "creatures/snail.js#spawn"]
case("C12-search-gain-not-swept-triage",
     "A text search gains a match but the patch altered none of the old matches: triage zone, then re-affirmed",
     ["QT2", "7.3", "2.6"],
     {"A": "an urchin on the floor", "B": "an anemone on the floor"},
     [
         S("A", "search", {"query": "energy", "path": "creatures/"}, ok=True, result={"containers": TEXT_ENERGY_0},
           premises=[P("query", "text:creatures/:energy", 0, read=True)]),
         S("A", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         S("B", "write", {"path": "creatures/anemone.js", "content": ANEMONE}, ok=True),
         submit("B", "Add an anemone", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "query", "text:creatures/:energy", "QT2", "triage")],
              heads_ups=[hu("A", 1, "info", [item("query", "text:creatures/:energy", "QT2", "pending", added=["creatures/anemone.js#spawn"])], dropped_ops=[], wake=False)],
              states={"A": "working"}),
         push_ok([1]),
         S(None, "triage", {"attempt": "A", "kind": "query", "key": "text:creatures/:energy", "p": 0.1},
           judgments=[J("A", "query", "text:creatures/:energy", "QT2", "triage", "holds")],
           heads_ups=[], states={"A": "working"}),
         submit("A", "Add an urchin", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"creatures/urchin.js": URCHIN, "creatures/anemone.js": ANEMONE},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     constants={"T_REPAIR": 0.7, "T_CONFIRM": 0.2})

# ---------------------------------------------------------------- C13
case("C13-listing-gain-additive-holds",
     "Two creature agents both listed creatures/ and each adds a file: the listing gain is unused, both land in one batch",
     ["L3", "9.4 step 3b", "2.5"],
     {"A": "an urchin on the floor", "B": "an anemone on the floor"},
     [
         S("A", "list", {"path": "creatures/"}, ok=True,
           result={"entries": [{"name": "fish.js", "type": "file"}, {"name": "snail.js", "type": "file"}]},
           premises=[P("listing", "creatures/", 0, read=True)]),
         S("A", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         submit("A", "Add an urchin", status="validated"),
         S("B", "list", {"path": "creatures/"}, ok=True, premises=[P("listing", "creatures/", 0, read=True)]),
         S("B", "write", {"path": "creatures/anemone.js", "content": ANEMONE}, ok=True),
         submit("B", "Add an anemone", status="validated"),
         tick(accepted=["A", "B"], skipped={}, heads_ups=[],
              judgments=[J("B", "listing", "creatures/", "L3", "rule", "holds")]),
         push_ok([1, 2]),
     ],
     {"head_seq": 2, "files": {"creatures/urchin.js": URCHIN, "creatures/anemone.js": ANEMONE},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}, {"seq": 2, "attempt": "B", "kind": "change"}]},
     note="Inside the tick B's listing premise is changed by A (creatures/ gains urchin.js). Rule L3 says holds, so B is still disjoint.")

# ---------------------------------------------------------------- C14
SNAIL_SHY = SNAIL.replace("  snail.x += 0.1;\n", "  snail.x += 0.1;\n  snail.shy = true;\n")
FISH_SHY = FISH.replace("  step(fish);\n", "  step(fish);\n  fish.shy = true;\n")
URCHIN_SHY = URCHIN.replace("energy: 50 }", "energy: 50, shy: true }")
case("C14-listing-gain-during-sweep",
     "An agent editing the existing files of a directory is told when the directory gains a file: rule-based repair",
     ["L1", "HU1", "T8"],
     {"A": "make every creature shy", "B": "an urchin on the floor"},
     [
         S("A", "list", {"path": "creatures/"}, ok=True, premises=[P("listing", "creatures/", 0, read=True)]),
         read_e("A", "creatures/snail.js#update"),
         S("A", "replace", {"path": "creatures/snail.js", "old": "  snail.x += 0.1;\n", "new": "  snail.x += 0.1;\n  snail.shy = true;\n"}, ok=True,
           result={"targets": ["creatures/snail.js#update"], "altered": ["creatures/snail.js#update"]}),
         read_e("A", "creatures/fish.js#update"),
         S("A", "replace", {"path": "creatures/fish.js", "old": "  step(fish);\n", "new": "  step(fish);\n  fish.shy = true;\n"}, ok=True,
           result={"targets": ["creatures/fish.js#update"], "altered": ["creatures/fish.js#update"]}),
         S("B", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         submit("B", "Add an urchin", status="validated"),
         tick(accepted=["B"],
              judgments=[J("A", "listing", "creatures/", "L1", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("listing", "creatures/", "L1", "repair", added=["urchin.js"])], dropped_ops=[])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         read_f("A", "creatures/urchin.js", at=1),
         S("A", "replace", {"path": "creatures/urchin.js", "old": "energy: 50 }", "new": "energy: 50, shy: true }"}, ok=True,
           premises=[P("entity", "creatures/urchin.js#spawn", 1, edit=True), P("query", "refs:creatures/urchin.js#spawn", 1, derived=True)]),
         submit("A", "Make every creature shy", [1], "Made the new urchin shy as well.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"creatures/snail.js": SNAIL_SHY, "creatures/fish.js": FISH_SHY, "creatures/urchin.js": URCHIN_SHY},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 1, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="A holds operations on both files that existed in creatures/ (min(2, 2) distinct paths), so it is sweeping the directory. C40 is the same landing against an attempt that edits one file.")

# ---------------------------------------------------------------- C15
NUDGE_NEW = "export const MAX_SPEED = 2;\n\nexport function nudge(creature) {\n  creature.x += creature.vx;\n}"
MOVEMENT_C15 = (
    "export const MAX_SPEED = 2;\n\nexport function nudge(creature) {\n  creature.x += creature.vx;\n}\n\n"
    "export function step(creature) {\n  creature.x += creature.vx * 0.5;\n  creature.y += creature.vy;\n}\n"
)
case("C15-replace-no-longer-applies",
     "Every premise holds, but the replace text now matches twice: the operation is dropped and the agent goes around",
     ["5.3", "OP2", "OP6", "OP7", "OP8"],
     {"A": "creatures drift half as fast sideways", "B": "add a nudge helper"},
     [
         read_e("A", K_STEP),
         S("A", "replace", {"path": "world/movement.js", "old": "creature.x += creature.vx;", "new": "creature.x += creature.vx * 0.5;"}, ok=True),
         read_f("B", "world/movement.js"),
         S("B", "replace", {"path": "world/movement.js", "old": "export const MAX_SPEED = 2;", "new": NUDGE_NEW}, ok=True,
           result={"targets": [K_SPEED], "altered": [], "added": ["world/movement.js#nudge"]},
           premises=[P("entity", K_SPEED, 0, edit=True), P("entity", "world/movement.js#nudge", absent=True, edit=True)]),
         submit("B", "Add nudge", status="validated"),
         tick(accepted=["B"], judgments=[],
              heads_ups=[hu("A", 1, "repair", [], dropped_ops=[{"op_seq": 1, "rule": "OP2"}])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         read_e("A", K_STEP, at=1),
         S("A", "replace", {"path": "world/movement.js", "old": "creature.x += creature.vx;", "new": "creature.x += creature.vx * 0.5;"},
           ok=False, error="ambiguous"),
         S("A", "replace", {"path": "world/movement.js", "old": "export function step(creature) {\n  creature.x += creature.vx;",
                            "new": "export function step(creature) {\n  creature.x += creature.vx * 0.5;"}, ok=True,
           result={"targets": [K_STEP], "altered": [K_STEP]},
           premises=[P("entity", K_STEP, 1, read=True, edit=True), P("query", "refs:" + K_STEP, 1, derived=True)]),
         submit("A", "Halve sideways drift", [1], "Re-applied the edit with a longer match.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT_C15}, "states": {"A": "landed", "B": "landed"},
      "go_arounds": {"A": 1, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="The entity step is unchanged by B (E0), so no premise changes. Only replay (OP7b) finds the problem.")

# ---------------------------------------------------------------- C16
def limit_case():
    steps = [read_e("A", K_EMAX), S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True)]
    values = [100, 90, 80, 70, 60]
    landings = []
    for k in range(1, 5):
        b = "B%d" % k
        steps += [
            read_e(b, K_EMAX, at=k - 1),
            S(b, "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = %d" % values[k - 1], "new": "ENERGY_MAX = %d" % values[k]}, ok=True),
            submit(b, "Lower ENERGY_MAX to %d" % values[k], status="validated"),
        ]
        if k == 1:
            steps.append(submit("A", "Add a crab", status="validated"))
        else:
            steps.append(submit("A", "Add a crab", [k - 1], "The crab still wants the threshold 30.", status="validated"))
        if k < 4:
            steps.append(tick(accepted=[b], skipped={"A": "not_disjoint"},
                              heads_ups=[hu("A", k, "repair", [item("entity", K_EMAX, "E2", "repair")], dropped_ops=[])],
                              states={"A": "going_around"}, go_arounds={"A": k}, cards=[]))
        else:
            steps.append(tick(accepted=[b], skipped={"A": "not_disjoint"},
                              heads_ups=[hu("A", 4, "repair", [item("entity", K_EMAX, "E2", "repair")], dropped_ops=[])],
                              states={"A": "stopped"}, stop_reasons={"A": "go_around_limit"}, go_arounds={"A": 3},
                              cards=[{"kind": "choice", "reason": "go_around_limit", "attempts": ["A"]}]))
        steps.append(push_ok([k]))
        landings.append({"seq": k, "attempt": b, "kind": "change"})
    steps.append(S("A", "submit", {"summary": "Add a crab"}, status="stopped"))
    return steps, landings
st, la = limit_case()
case("C16-go-around-limit",
     "Three go-arounds are allowed; the fourth repair stops the attempt and opens a choice card",
     ["11.1 GL1", "T8", "T9", "GA1", "GL3a", "CK0"],
     {"A": I_CRAB, "B1": "lower the energy cap to 90", "B2": "lower the energy cap to 80", "B3": "lower the energy cap to 70", "B4": "lower the energy cap to 60"},
     st,
     {"head_seq": 4, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 60"), CRAB: None},
      "states": {"A": "stopped", "B1": "landed", "B2": "landed", "B3": "landed", "B4": "landed"},
      "go_arounds": {"A": 3}, "landings": la},
     constants={"STARVATION_AFTER": 99},
     note="STARVATION_AFTER is raised so that right of way (11.2) does not protect A; C24 tests that rule. A resubmits unchanged each time, which is allowed: a go-around needs an acknowledgement, not an edit.")

# ---------------------------------------------------------------- C17
case("C17-contradiction-card",
     "A second repair on the same edited entity, caused by a different intent, opens a choice card instead of another go-around",
     ["GL3", "T9c", "E1"],
     {"A": "set the top speed to 10", "B": "raise the top speed to 3", "C": "raise the top speed to 4"},
     [
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         read_e("A", K_SPEED),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 10"}, ok=True),
         submit("A", "Set MAX_SPEED to 10", status="validated"),
         tick(accepted=["B"], skipped={"A": "not_disjoint"},
              heads_ups=[hu("A", 1, "repair", [item("entity", K_SPEED, "E1", "repair")], dropped_ops=[{"op_seq": 1, "rule": "OP1"}])],
              states={"A": "going_around"}, go_arounds={"A": 1}, cards=[]),
         push_ok([1]),
         read_e("C", K_SPEED, at=1),
         S("C", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 3", "new": "MAX_SPEED = 4"}, ok=True),
         submit("C", "Raise MAX_SPEED to 4", status="validated"),
         read_e("A", K_SPEED, at=1),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 3", "new": "MAX_SPEED = 10"}, ok=True),
         submit("A", "Set MAX_SPEED to 10", [1], "Re-applied on top of 3.", status="validated"),
         tick(accepted=["C"], skipped={"A": "not_disjoint"},
              heads_ups=[hu("A", 2, "repair", [item("entity", K_SPEED, "E1", "repair")], dropped_ops=[{"op_seq": 2, "rule": "OP1"}])],
              states={"A": "stopped"}, stop_reasons={"A": "contradiction"}, go_arounds={"A": 1},
              cards=[{"kind": "choice", "reason": "contradiction", "attempts": ["A", "C"]}]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 4")},
      "states": {"A": "stopped", "B": "landed", "C": "landed"}, "go_arounds": {"A": 1},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "C", "kind": "change"}]})

# ---------------------------------------------------------------- C18
case("C18-held-path",
     "A change to a held path waits for one owner tap; the card shows the blast radius; landing then repairs the in-flight creature",
     ["10.1 PO1", "PO2", "10.2", "T4", "T13", "11.6", "9.3"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="held",
                cards=[{"kind": "held", "reason": "held_path", "attempts": ["S"], "blast_radius": {"repair": ["A"], "confirm": [], "triage": []}}],
                states={"S": "held"}),
         tick(accepted=[], states={"S": "held"}),
         S(None, "owner", {"action": "land", "attempt": "S"}, states={"S": "validated"}),
         tick(accepted=["S"], heads_ups=[hu("A", 1, "repair", [item("entity", K_EMAX, "E2", "repair")], dropped_ops=[])],
              states={"S": "accepted", "A": "going_around"}),
         push_ok([1], states={"S": "landed"}),
     ],
     {"head_seq": 1, "files": {"world/energy.js": ENERGY_1, CRAB: None},
      "states": {"A": "going_around", "S": "landed"}, "go_arounds": {"A": 1},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}]},
     files={".premise/policy.json": POLICY_HELD})

# ---------------------------------------------------------------- C19
case("C19-causal-undo-reopens-dependents",
     "Undo of the shared-rule change also reverts the creature that referenced it and reopens that creature's attempt; an unrelated creature stays",
     ["11.3", "UN1", "UN2", "UN3", "UN5", "T18", "T19", "E2"],
     {"S": I_FRACTION, "A": I_CRAB, "B": I_EEL},
     [
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"]),
         push_ok([1]),
         read_e("A", K_EMAX, at=1),
         S("A", "write", {"path": CRAB, "content": CRAB_03}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", status="validated", premises=[]),
         read_e("B", K_SPEED, at=1),
         S("B", "write", {"path": "creatures/eel.js", "content": EEL}, ok=True),
         submit("B", "Add an eel", status="validated"),
         tick(accepted=["A", "B"]),
         push_ok([2, 3]),
         S(None, "owner", {"action": "undo", "seq": 1},
           undo={"reverted": [1, 2], "reopened": ["A"], "kept_readers": []},
           states={"S": "landed", "A": "landed", "B": "landed"}),
         tick(accepted=["undo:1"], landings=[{"seq": 4, "kind": "undo", "undoes": [1, 2]}],
              heads_ups=[hu("A", 1, "repair", [item("entity", K_EMAX, "E2", "repair", after_contains="ENERGY_MAX = 100;")], cause="undo", dropped_ops=[])],
              states={"S": "stopped", "A": "going_around", "B": "landed"}, stop_reasons={"S": "undone"}, go_arounds={"A": 1}),
         push_ok([4]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 0.3", "new": "crab.energy < 30"}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", [1], "Energy is back to points from 0 to 100, so the threshold is 30.", status="validated"),
         tick(accepted=["A"]),
         push_ok([5]),
     ],
     {"head_seq": 5, "files": {"world/energy.js": ENERGY, CRAB: CRAB_30, "creatures/eel.js": EEL},
      "states": {"S": "stopped", "A": "landed", "B": "landed"}, "go_arounds": {"A": 1},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"},
                   {"seq": 3, "attempt": "B", "kind": "change"}, {"seq": 4, "kind": "undo"}, {"seq": 5, "attempt": "A", "kind": "change"}]},
     note="After landing 4 the pool has no crab.js and the original energy.js; eel.js is untouched. The reopened crab keeps its operations (a write of the 0.3 version) and adds one replace.")

# ---------------------------------------------------------------- C20-22
def restart_case(id, title, remote, action, rules):
    steps = [
        read_e("A", K_EMAX),
        S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
        submit("A", "Add a crab", status="validated"),
        tick(accepted=["A"], states={"A": "accepted"}, events_include=["landing.accepted"], events_exclude=["landing.landed"]),
    ]
    if remote == "old":
        steps += [
            S(None, "restart", {"remote_main": "old"}, action="repush", landed=[], states={"A": "accepted"}, events_exclude=["landing.landed"]),
            tick(accepted=[], states={"A": "accepted"}),
            push_ok([1], states={"A": "landed"}, events_include=["landing.landed"]),
        ]
        final_state, pool = "landed", None
    elif remote == "new":
        steps += [
            S(None, "restart", {"remote_main": "new"}, action="mark_pushed", landed=[1], states={"A": "landed"}, events_include=["landing.landed"]),
        ]
        final_state = "landed"
    else:
        steps += [
            S(None, "restart", {"remote_main": "other"}, action="pause", pool_state="paused", landed=[], states={"A": "accepted"},
              events_include=["pool.paused"], events_exclude=["landing.landed"]),
            S("B", "write", {"path": "creatures/eel.js", "content": EEL}, ok=False, error="pool_not_ready"),
            tick(accepted=[], states={"A": "accepted"}),
        ]
        final_state = "accepted"
    attempts = {"A": I_CRAB}
    if remote == "other": attempts["B"] = I_EEL
    case(id, title, rules, attempts, steps,
         {"head_seq": 1, "files": {CRAB: CRAB_30}, "states": {"A": final_state},
          "landings": [{"seq": 1, "attempt": "A", "kind": "change"}]})
restart_case("C20-restart-before-push-applied", "Trunk restarts between accepted and pushed, and main still has the old value: the same push is sent again", "old", "repush",
             ["9.6 LP3", "LP6", "9.7 LP7", "LP9", "LP1"])
restart_case("C21-restart-after-push-applied", "Trunk restarts after the push was applied but before it was recorded: reconciliation marks it landed without pushing again", "new", "mark_pushed",
             ["9.7 LP7", "LP9", "T16"])
restart_case("C22-restart-diverged", "Trunk restarts and main has an unknown value: the pool pauses, nothing is called landed, writes are refused", "other", "pause",
             ["9.7 LP7", "LP9", "LP10"])

# ---------------------------------------------------------------- C23
case("C23-duplicate-submit",
     "A retried submit and an unchanged second submit do not queue a second landing",
     ["TA2", "CK0", "9.8"],
     {"A": I_CRAB},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         S("A", "submit", {"summary": "Add a crab"}, call_id="A:3", status="validated"),
         S("A", "submit", {"summary": "Add a crab"}, call_id="A:3", same_response_as=2),
         S("A", "submit", {"summary": "Add a crab"}, call_id="A:4", status="validated", duplicate=True, same_submit_id_as=2),
         tick(accepted=["A"], landings=[{"seq": 1, "attempt": "A", "kind": "change"}]),
         S("A", "submit", {"summary": "Add a crab"}, call_id="A:5", status="accepted", result={"seq": 1}),
         tick(accepted=[]),
         push_ok([1]),
         S("A", "submit", {"summary": "Add a crab"}, call_id="A:6", status="landed", result={"seq": 1}),
         tick(accepted=[]),
     ],
     {"head_seq": 1, "files": {CRAB: CRAB_30}, "states": {"A": "landed"},
      "landings": [{"seq": 1, "attempt": "A", "kind": "change"}]},
     note="same_response_as and same_submit_id_as give the zero-based index of an earlier step. Between acceptance and the confirmed push the answer is `accepted`, never `landed` (LP9).")

# ---------------------------------------------------------------- C24
def row_case():
    steps = [read_e("A", K_EMAX), S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True)]
    values = [100, 90, 80, 70]
    for k in (1, 2):
        b = "B%d" % k
        steps += [
            read_e(b, K_EMAX, at=k - 1),
            S(b, "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = %d" % values[k - 1], "new": "ENERGY_MAX = %d" % values[k]}, ok=True),
            submit(b, "Lower ENERGY_MAX to %d" % values[k], status="validated"),
            submit("A", "Add a crab", status="validated") if k == 1 else
            submit("A", "Add a crab", [k - 1], "The crab still wants the threshold 30.", status="validated"),
            tick(accepted=[b], skipped={"A": "not_disjoint"}, states={"A": "going_around"}, go_arounds={"A": k},
                 right_of_way={"A": k == 2}),
            push_ok([k]),
        ]
    steps += [
        read_e("B3", K_EMAX, at=2),
        S("B3", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 80", "new": "ENERGY_MAX = 70"}, ok=True),
        submit("B3", "Lower ENERGY_MAX to 70", status="validated"),
        tick(accepted=[], skipped={"B3": "right_of_way"}, states={"B3": "validated", "A": "going_around"}, waiting_behind=1, heads_ups=[]),
        submit("A", "Add a crab", [2], "The crab still wants the threshold 30.", status="validated"),
        tick(accepted=["A"], skipped={"B3": "not_disjoint"},
             heads_ups=[hu("B3", 1, "repair", [item("query", "refs:" + K_EMAX, "QR1", "repair", added=[CRAB_IMPORT, CRAB + "#spawn"])], dropped_ops=[])],
             states={"A": "accepted", "B3": "going_around"}, go_arounds={"B3": 1}, waiting_behind=0),
        push_ok([3], states={"A": "landed"}),
    ]
    return steps
case("C24-right-of-way",
     "After two go-arounds an attempt gets right of way: a change that would send it around a third time waits",
     ["11.2 RW1", "RW2", "RW3", "RW5", "LP2", "14.6"],
     {"A": I_CRAB, "B1": "lower the energy cap to 90", "B2": "lower the energy cap to 80", "B3": "lower the energy cap to 70"},
     row_case(),
     {"head_seq": 3, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 80"), CRAB: CRAB_30},
      "states": {"A": "landed", "B1": "landed", "B2": "landed", "B3": "going_around"}, "go_arounds": {"A": 2, "B3": 1},
      "landings": [{"seq": 1, "attempt": "B1", "kind": "change"}, {"seq": 2, "attempt": "B2", "kind": "change"}, {"seq": 3, "attempt": "A", "kind": "change"}]})

# ---------------------------------------------------------------- C25
case("C25-changed-before-any-edit",
     "An entity the agent read changes before the agent has written anything: info heads-up, no go-around, no Clef",
     ["X0", "HU2", "8.4"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         read_e("A", K_EMAX),
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], judgments=[J("A", "entity", K_EMAX, "X0", "rule", "holds")],
              heads_ups=[hu("A", 1, "info", [item("entity", K_EMAX, "X0", "holds", after_contains="ENERGY_MAX = 1;")], dropped_ops=[], wake=False)],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
         S("A", "write", {"path": CRAB, "content": CRAB_03}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", status="validated", premises=[]),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {CRAB: CRAB_03}, "states": {"A": "landed", "S": "landed"}, "go_arounds": {"A": 0},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]})

# ---------------------------------------------------------------- C26
case("C26-heads-up-first",
     "An edit sent before the agent has seen a pending heads-up is refused and not recorded",
     ["TA3", "HU7", "HU8"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         read_e("S", K_EMAX),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], states={"A": "going_around"}),
         push_ok([1]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 3"}, ack=0, ok=False, error="heads_up_first"),
         S("A", "submit", {"summary": "Add a crab"}, ack=0, ok=False, error="heads_up_first"),
         S("A", "read", {"path": "world/energy.js", "entity": "ENERGY_MAX"}, ack=0, ok=True,
           premises=[P("entity", K_EMAX, 1, read=True, derived=True)]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 0.3"}, ok=True, result={"op_seq": 2}),
     ],
     {"head_seq": 1, "files": {CRAB: None}, "states": {"A": "going_around", "S": "landed"}, "go_arounds": {"A": 1},
      "landings": [{"seq": 1, "attempt": "S", "kind": "change"}]},
     note="The refused replace gets no op_seq: the accepted one is operation 2, after the write. The read with ack 0 succeeds and its response carries heads-up 1.")

# ---------------------------------------------------------------- C27
MOVEMENT_3 = MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 3")
MOVEMENT_COMMENT = "// Units per tick.\n" + MOVEMENT
case("C27-whole-file-write-base-changed",
     "A whole-file write needs a prior read, and is sent back when the file's bytes changed underneath, even cosmetically",
     ["W1", "W4", "F1", "OP5", "OP6", "7.2"],
     {"A": "raise the top speed to 3", "B": "document the speed unit"},
     [
         S("A", "write", {"path": "world/movement.js", "content": MOVEMENT_3}, ok=False, error="read_first", premises=[]),
         read_f("A", "world/movement.js"),
         S("A", "write", {"path": "world/movement.js", "content": MOVEMENT_3}, ok=True,
           result={"created": False, "altered": [K_SPEED], "added": [], "removed": []},
           premises=[P("file", "world/movement.js", 0, read=True, edit=True), P("query", "refs:" + K_SPEED, 0, derived=True)]),
         S("B", "replace", {"path": "world/movement.js", "old": "export const MAX_SPEED = 2;", "new": "// Units per tick.\nexport const MAX_SPEED = 2;"}, ok=True,
           result={"targets": [K_SPEED], "altered": []}),
         submit("B", "Document the unit of MAX_SPEED", status="validated"),
         tick(accepted=["B"],
              judgments=[J("A", "file", "world/movement.js", "F1", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("file", "world/movement.js", "F1", "repair")], dropped_ops=[{"op_seq": 1, "rule": "OP5"}])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
         read_f("A", "world/movement.js", at=1),
         S("A", "write", {"path": "world/movement.js", "content": "// Units per tick.\n" + MOVEMENT_3}, ok=True,
           premises=[P("file", "world/movement.js", 1, read=True, edit=True), P("query", "refs:" + K_SPEED, 1, derived=True)]),
         submit("A", "Raise MAX_SPEED to 3", [1], "Rewrote the file on top of the new comment.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": "// Units per tick.\n" + MOVEMENT_3}, "states": {"A": "landed", "B": "landed"},
      "go_arounds": {"A": 1, "B": 0},
      "landings": [{"seq": 1, "attempt": "B", "kind": "change"}, {"seq": 2, "attempt": "A", "kind": "change"}]},
     note="Compare with C08: the same kind of cosmetic landing leaves a reader untouched (F2) but sends back a whole-file writer (F1), because replaying the write would erase the comment.")

# ---------------------------------------------------------------- C28
case("C28-empty-change-rejected",
     "A change whose operations cancel out is rejected, not landed",
     ["CK3", "T7", "D2"],
     {"A": "raise the top speed to 3"},
     [
         read_e("A", K_SPEED),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True,
           premises=[P("entity", K_SPEED, 0, read=True, edit=True), P("query", "refs:" + K_SPEED, 0, derived=True)]),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 3", "new": "MAX_SPEED = 2"}, ok=True,
           result={"targets": [K_SPEED], "altered": []}),
         submit("A", "Raise MAX_SPEED to 3", status="rejected", result={"errors": [{"code": "empty_change"}]}, states={"A": "working"}),
         tick(accepted=[]),
     ],
     {"head_seq": 0, "files": {"world/movement.js": MOVEMENT}, "states": {"A": "working"}, "go_arounds": {"A": 0}, "landings": []})

exec(open(__file__.replace("gen_cases.py", "gen_new.py")).read())

hash_cases = [
    {"id": "H01", "rule": "2.4", "kind": "canonical", "source": "export const ENERGY_MAX = 100;\n", "entity": "ENERGY_MAX",
     "canonical": '{"exports":["ENERGY_MAX"],"nodes":[{"id":{"name":"ENERGY_MAX","type":"Identifier"},"init":{"type":"Literal","value":100},"kind":"const","type":"VariableDeclarator"}]}',
     "hash": "5149f012fe7cd2dfd8820a214ea41ff0"},
    {"id": "H02", "rule": "2.4", "kind": "canonical", "source": 'export { a as b } from "./m.js";\n', "entity": "b",
     "canonical": '{"exports":["b"],"nodes":[{"imported":"a","source":"./m.js","type":"ReExport"}]}',
     "hash": "3f29356aa41908dbce5674be91366cab"},
    {"id": "H03", "rule": "2.4", "kind": "canonical", "source": "export default 42;\n", "entity": "default",
     "canonical": '{"exports":["default"],"nodes":[{"type":"Literal","value":42}]}',
     "hash": "41c54b4e5009639775f4ca196d04e070"},
    {"id": "H04", "rule": "2.4 comments and whitespace", "kind": "entity", "entity": "ENERGY_MAX", "equal": True,
     "a": ENERGY, "b": "export   const ENERGY_MAX =\n  100 ; /* points */\n"},
    {"id": "H05", "rule": "2.4 number spelling", "kind": "entity", "entity": "ENERGY_MAX", "equal": True,
     "a": "export const ENERGY_MAX = 100;\n", "b": "export const ENERGY_MAX = 1e2;\n"},
    {"id": "H06", "rule": "2.4 value change", "kind": "entity", "entity": "ENERGY_MAX", "equal": False,
     "a": "export const ENERGY_MAX = 100;\n", "b": "export const ENERGY_MAX = 1;\n"},
    {"id": "H07", "rule": "2.4 EN1 export status", "kind": "entity", "entity": "ENERGY_MAX", "equal": False,
     "a": "export const ENERGY_MAX = 100;\n", "b": "const ENERGY_MAX = 100;\n"},
    {"id": "H08", "rule": "2.3 export list", "kind": "entity", "entity": "ENERGY_MAX", "equal": True,
     "a": "export const ENERGY_MAX = 100;\n", "b": "const ENERGY_MAX = 100;\nexport { ENERGY_MAX };\n"},
    {"id": "H09", "rule": "2.4 parentheses and semicolons", "kind": "entity", "entity": "drain", "equal": True,
     "a": ENERGY, "b": "export function drain(creature,amount){creature.energy=Math.max(0,(creature.energy-amount))}\n"},
    {"id": "H10", "rule": "2.4 body change", "kind": "entity", "entity": "drain", "equal": False,
     "a": ENERGY, "b": ENERGY.replace("creature.energy - amount", "creature.energy - amount * 2")},
    {"id": "H11", "rule": "2.4 quote style", "kind": "entity", "entity": "NAME", "equal": True,
     "a": "export const NAME = 'crab';\n", "b": 'export const NAME = "crab";\n'},
    {"id": "H12", "rule": "2.4 comment moved between entities", "kind": "entity", "entity": "drain", "equal": True,
     "a": ENERGY, "b": ENERGY.replace(COMMENT_OLD, COMMENT_NEW)},
    {"id": "H13", "rule": "2.5 listing", "kind": "members", "members": ["fish.js", "snail.js"], "hash": "a55430205a91ff9e355e9502080105a5"},
    {"id": "H14", "rule": "2.5 empty set", "kind": "members", "members": [], "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5"},
    {"id": "H15", "rule": "2.5 refs query: referrer keys plus one <path>@<module hash> entry per referrer module", "kind": "members",
     "members": REFS_EMAX_0 + ["creatures/fish.js@854043e6f224188840f8df611e97e6db", "creatures/snail.js@f69fa62b77a6722798673ba3397593f5"],
     "hash": "ff47aaea471d570878c4fe52260ff79a"},
    {"id": "H16", "rule": "2.7 outline", "kind": "members", "members": ["ENERGY_MAX|const|ENERGY_MAX|", "drain|function|drain|2"], "hash": "b7d16f9836653b62fda3cc5d25d0ccea"},
    {"id": "H17", "rule": "2.5 file", "kind": "blob", "content": ENERGY, "hash": "73b9aee0919e88e8402fcc5616756bf206f17fb7"},
    {"id": "H18", "rule": "2.5 file", "kind": "blob", "content": MOVEMENT, "hash": "d46257a07ac14a8d62cf68dd3a721c774fa25c20"},
    {"id": "H19", "rule": "2.5 module hash of creatures/fish.js", "kind": "members",
     "members": ["(import ../world/energy.js) 55adfbec94ba6e1d7e92bcc499dc9d99", "(import ../world/movement.js) 918eb57661a967ac3f67706f30bebb12",
                 "spawn 56ea6cd2b8ec221ef6d026bd223568c6", "update e4edc1a920266d3e2eacbe9e7ffe8984"],
     "hash": "854043e6f224188840f8df611e97e6db"},
    {"id": "H20", "rule": "2.6 text query members carry the match count", "kind": "members", "members": ["creatures/fish.js#update*1"],
     "hash": "437a872bdeb83268a63e62950d702130"},
    {"id": "H21", "rule": "2.4 step 2 non-finite number", "kind": "canonical", "source": "export const X = 1e999;\n", "entity": "X",
     "canonical": '{"exports":["X"],"nodes":[{"id":{"name":"X","type":"Identifier"},"init":{"number":"Infinity","type":"Literal"},"kind":"const","type":"VariableDeclarator"}]}',
     "hash": "9998cc2dbda1d10d1d7f00fe22c2c8eb"},
    {"id": "H22", "rule": "2.4 step 2 non-finite number differs from null", "kind": "entity", "entity": "X", "equal": False,
     "a": "export const X = null;\n", "b": "export const X = 1e999;\n"},
    {"id": "H23", "rule": "2.4 step 2 non-finite number differs from the string", "kind": "entity", "entity": "X", "equal": False,
     "a": 'export const X = "Infinity";\n', "b": "export const X = 1e999;\n"},
]

inbox_cases = [
    {"id": "I01", "rule": "HU6a", "shown_hn": 0, "inbox": [1, 2], "expect": {"show": [1, 2], "sync": False}},
    {"id": "I02", "rule": "HU6a out-of-order push", "shown_hn": 0, "inbox": [2], "expect": {"show": [], "sync": True}},
    {"id": "I03", "rule": "HU6a gap after a run", "shown_hn": 2, "inbox": [3, 5], "expect": {"show": [3], "sync": True}},
    {"id": "I04", "rule": "HU6a nothing pending", "shown_hn": 2, "inbox": [], "expect": {"show": [], "sync": False}},
    {"id": "I05", "rule": "HU6a duplicates of shown heads-ups", "shown_hn": 2, "inbox": [1, 2], "expect": {"show": [], "sync": False}},
]

doc = {
    "format": "premise-cases/2",
    "spec": "docs/spec/01-core.md",
    "about": "Executable test vectors for the pure core. Format: 01-core.md Appendix A. Expected values follow from the rules cited in each case; `at: n` means the hash of that key in the pool after landing n (0 = initial files).",
    "constants": {"GO_AROUND_LIMIT": 3, "STARVATION_AFTER": 2, "MAX_BATCH": 64, "T_REPAIR": 0.7, "T_CONFIRM": 0.2},
    "switches": {"CLEF_TRIAGE": "on", "CLEF_RISK": "off", "CLEF_CONTRADICTION": "off"},
    "pools": {"tidepool": {"files": {
        ".premise/policy.json": POLICY,
        "world/energy.js": ENERGY, "world/movement.js": MOVEMENT,
        "creatures/fish.js": FISH, "creatures/snail.js": SNAIL}}},
    "hash_cases": hash_cases,
    "inbox_cases": inbox_cases,
    "cases": cases,
}
with open(OUT, "w") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(len(cases), "cases,", len(hash_cases), "hash cases,", len(inbox_cases), "inbox cases")
