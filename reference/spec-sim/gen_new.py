# New vectors of revision 2. Executed inside gen_cases.py (shares its helpers).
# Expected values are written by hand from the rules in 01-core.md.

def owner(action, **kw):
    args = {"action": action}
    for k in ("attempt", "seq", "expect_reverted"):
        if k in kw: args[k] = kw.pop(k)
    return S(None, "owner", args, **kw)

def creature_e(x):
    return (
        'import { ENERGY_MAX } from "../world/energy.js";\n'
        "\n"
        "export function spawn() {\n"
        "  return { x: %d, y: 195, vx: 0, vy: 0, energy: ENERGY_MAX };\n"
        "}\n" % x
    )
MOVEMENT_3C = "// Units per tick.\n" + MOVEMENT_3
B_COMMENT = {"path": "world/movement.js", "old": "export const MAX_SPEED = 2;", "new": "// Units per tick.\nexport const MAX_SPEED = 2;"}
S_FRACTION = {"path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1"}
FISH_UPDATE = "creatures/fish.js#update"
FISH_HIDE = {"path": "creatures/fish.js", "old": "  drain(fish, 1);\n", "new": "  drain(fish, 1);\n  fish.hiding = fish.energy < 30;\n"}
FISH_HIDE_30 = FISH.replace("  drain(fish, 1);\n", "  drain(fish, 1);\n  fish.hiding = fish.energy < 30;\n")
FISH_HIDE_03 = FISH_HIDE_30.replace("fish.energy < 30", "fish.energy < 0.3")
L = lambda seq, a: {"seq": seq, "attempt": a, "kind": "change"}

# ---------------------------------------------------------------- C29
case("C29-write-after-landing-needs-reread",
     "A whole-file write is refused when the file changed after the agent read it, even cosmetically and with no heads-up: the agent must read the bytes that are at head",
     ["W1", "3.2 shown", "F2", "V4"],
     {"A": "raise the top speed to 3", "B": "document the speed unit"},
     [
         read_f("A", "world/movement.js"),
         S("B", "replace", B_COMMENT, ok=True),
         submit("B", "Document the unit of MAX_SPEED", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "file", "world/movement.js", "F2", "rule", "holds")], heads_ups=[], states={"A": "working"}),
         push_ok([1]),
         S("A", "write", {"path": "world/movement.js", "content": MOVEMENT_3}, ok=False, error="read_first", premises=[]),
         read_f("A", "world/movement.js", at=1),
         S("A", "write", {"path": "world/movement.js", "content": MOVEMENT_3C}, ok=True,
           premises=[P("file", "world/movement.js", 1, read=True, edit=True), P("query", "refs:" + K_SPEED, 1, derived=True)]),
         submit("A", "Raise MAX_SPEED to 3", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT_3C}, "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0},
      "landings": [L(1, "B"), L(2, "A")]},
     note="C27 in the other order. Rule F2 re-pins A's file premise at the new blob without a heads-up (V4), but the premise's `shown` value stays the blob A actually read, so W1 refuses the write composed from the old bytes.")

# ---------------------------------------------------------------- C30
case("C30-blind-spot-after-meaning-change",
     "The shared rule changed before the creature's agent wrote anything, and the agent never read it: the blind-spot confirm at submit shows the current definition",
     ["6.4", "B1", "B2", "D1", "QO0"],
     {"A": I_CRAB, "S": I_FRACTION},
     [
         S("A", "outline", {"path": "world/energy.js"}, ok=True),
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], heads_ups=[], judgments=[], states={"A": "working"}),
         push_ok([1]),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True,
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", K_EMAX, 1, derived=True)]),
         submit("A", "Add a crab that hides when its energy is low", status="needs_confirm", premises=[],
                judgments=[J("A", "entity", K_EMAX, "B1", "rule", "confirm")],
                heads_ups=[hu("A", 1, "confirm", [item("entity", K_EMAX, "B1", "confirm", after_contains="ENERGY_MAX = 1;")], cause="submit", dropped_ops=[])]),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 0.3"}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", [1], "ENERGY_MAX is 1, so the hide threshold is 0.3.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, CRAB: CRAB_03}, "states": {"A": "landed", "S": "landed"},
      "go_arounds": {"A": 0, "S": 0}, "landings": [L(1, "S"), L(2, "A")]},
     note="No premise existed when S landed, so no heads-up was possible. The reference is one the attempt added and the agent was never shown the entity, so rule B1 requires one confirm turn.")

# ---------------------------------------------------------------- C31
CRAB_IMPORT_LINE = 'import { ENERGY_MAX } from "../world/energy.js";'
CRAB_SPEED = CRAB_30.replace(CRAB_IMPORT_LINE, CRAB_IMPORT_LINE + '\nimport { MAX_SPEED } from "../world/movement.js";').replace("vx: 0, vy: 0", "vx: MAX_SPEED / 2, vy: 0")
case("C31-triage-window-new-reference",
     "While a triage is pending the agent adds code that references the changed entity: the rule rows are run again and decide (E2 repair); the late Clef answer is discarded",
     ["V7", "7.3 TR1", "TR4", "E2", "TA3", "V2"],
     {"A": I_CRAB, "B": "raise the top speed to 3"},
     [
         read_e("A", K_SPEED),
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "entity", K_SPEED, "E3", "triage")],
              heads_ups=[hu("A", 1, "info", [item("entity", K_SPEED, "E3", "pending")], dropped_ops=[], wake=False)]),
         push_ok([1]),
         S("A", "replace", {"path": CRAB, "old": CRAB_IMPORT_LINE, "new": CRAB_IMPORT_LINE + '\nimport { MAX_SPEED } from "../world/movement.js";'},
           ack=0, ok=False, error="heads_up_first"),
         S("A", "replace", {"path": CRAB, "old": CRAB_IMPORT_LINE, "new": CRAB_IMPORT_LINE + '\nimport { MAX_SPEED } from "../world/movement.js";'}, ok=True,
           premises=[P("entity", K_SPEED, 1, read=True, derived=True)],
           judgments=[J("A", "entity", K_SPEED, "E2", "rule", "repair")],
           heads_ups=[hu("A", 2, "repair", [item("entity", K_SPEED, "E2", "repair", after_contains="MAX_SPEED = 3;")], dropped_ops=[])],
           states={"A": "going_around"}, go_arounds={"A": 1}),
         S("A", "replace", {"path": CRAB, "old": "vx: 0, vy: 0", "new": "vx: MAX_SPEED / 2, vy: 0"}, ok=True, judgments=[], heads_ups=[]),
         S(None, "triage", {"attempt": "A", "kind": "entity", "key": K_SPEED, "p": 0.1}, judgments=[], heads_ups=[], states={"A": "going_around"}),
         submit("A", "Add a crab that hides when its energy is low", status="go_around", result={"unresolved": [2]}),
         submit("A", "Add a crab that hides when its energy is low", [2], "The crab uses the new top speed 3.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {CRAB: CRAB_SPEED}, "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 1, "B": 0},
      "landings": [L(1, "B"), L(2, "A")]},
     note="Without rule V7 the answer p = 0.1, computed for the patch as it was at the landing, would re-affirm the premise and the change would land with a reference to a changed entity and no repair.")

# ---------------------------------------------------------------- C32
st32, la32 = limit_case()
st32 += [
    read_e("B5", K_EMAX, at=4),
    S("B5", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 60", "new": "ENERGY_MAX = 50"}, ok=True),
    submit("B5", "Lower ENERGY_MAX to 50", status="validated"),
    tick(accepted=["B5"], judgments=[J("A", "entity", K_EMAX, "E2", "rule", "repair")],
         heads_ups=[hu("A", 5, "repair", [item("entity", K_EMAX, "E2", "repair", after_contains="ENERGY_MAX = 50;")], dropped_ops=[], wake=False)],
         states={"A": "stopped"}, go_arounds={"A": 3}, cards=[]),
    push_ok([5]),
    owner("retry", attempt="A", states={"A": "going_around"}, go_arounds={"A": 1}, right_of_way={"A": True}),
    submit("A", "Add a crab", [4], "The crab still wants the threshold 30.", status="go_around", result={"unresolved": [5]}),
    submit("A", "Add a crab", [5], "The crab still wants the threshold 30.", status="validated"),
    tick(accepted=["A"]),
    push_ok([6]),
]
case("C32-retry-resumes-classified",
     "An attempt stopped on a choice card stays classified while the card is open; 'Try again' resumes it in a go-around with every waiting heads-up",
     ["GL3a", "GL5", "T21", "7.1", "CK8", "GA1"],
     {"A": I_CRAB, "B1": "lower the energy cap to 90", "B2": "lower the energy cap to 80", "B3": "lower the energy cap to 70", "B4": "lower the energy cap to 60", "B5": "lower the energy cap to 50"},
     st32,
     {"head_seq": 6, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 50"), CRAB: CRAB_30},
      "states": {"A": "landed", "B5": "landed"}, "go_arounds": {"A": 1}, "landings": la32 + [L(5, "B5"), L(6, "A")]},
     constants={"STARVATION_AFTER": 99},
     note="Continues C16. Landing 5 arrives while A is stopped with its card open: A is still classified (rule E2), the heads-up waits and does not wake the agent. After 'Try again' A cannot land until it has acknowledged heads-ups 4 and 5.")

# ---------------------------------------------------------------- C33
case("C33-edit-after-validated",
     "An operation accepted after a passing submit takes the attempt out of the landing queue; it must submit again",
     ["T22", "9.3", "CK0", "TA4"],
     {"A": I_CRAB},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         submit("A", "Add a crab", status="validated", states={"A": "validated"}),
         S("A", "replace", {"path": CRAB, "old": "crab.energy < 30", "new": "crab.energy < 25"}, ok=True,
           states={"A": "working"}, events_include=["attempt.state", "op.recorded"]),
         tick(accepted=[], states={"A": "working"}),
         submit("A", "Add a crab", status="validated", duplicate=False),
         tick(accepted=["A"]),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {CRAB: crab("25")}, "states": {"A": "landed"}, "go_arounds": {"A": 0}, "landings": [L(1, "A")]})

# ---------------------------------------------------------------- C34
case("C34-edit-while-held",
     "An operation accepted while a held card is open closes the card as stale; the owner's tap on the old card does nothing; the new submit opens a new card",
     ["T22", "T13", "10.2", "PO2"],
     {"S": I_FRACTION},
     [
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="held", states={"S": "held"},
                cards=[{"kind": "held", "reason": "held_path", "attempts": ["S"]}]),
         S("S", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 1", "new": "ENERGY_MAX = 2"}, ok=True,
           states={"S": "working"}, events_include=["card.closed", "attempt.state"]),
         owner("land", attempt="S", states={"S": "working"}),
         tick(accepted=[], states={"S": "working"}),
         submit("S", "Make ENERGY_MAX 2", status="held", states={"S": "held"}, cards=[{"kind": "held", "reason": "held_path", "attempts": ["S"]}]),
         owner("land", attempt="S", states={"S": "validated"}),
         tick(accepted=["S"]),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 2")}, "states": {"S": "landed"},
      "landings": [L(1, "S")]},
     files={".premise/policy.json": POLICY_HELD})

# ---------------------------------------------------------------- C35
POLICY_CREATURES_HELD = '{\n  "v": 1,\n  "default": "held",\n  "tiers": [\n    { "paths": ["world/**"], "tier": "auto" }\n  ]\n}\n'
case("C35-policy-change-in-batch",
     "A change validated as auto is behind a policy change in the same tick: the tier is checked again against the running state and the change goes to a held card",
     ["9.4 step 3c", "CK9", "PO3", "PO5", "T4"],
     {"P": "creatures need my approval from now on", "A": "an urchin on the floor"},
     [
         read_f("P", ".premise/policy.json"),
         S("P", "write", {"path": ".premise/policy.json", "content": POLICY_CREATURES_HELD}, ok=True),
         submit("P", "Hold creature changes", status="held"),
         owner("land", attempt="P", states={"P": "validated"}),
         S("A", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         submit("A", "Add an urchin", status="validated"),
         tick(accepted=["P"], skipped={"A": "held"}, states={"P": "accepted", "A": "held"},
              cards=[{"kind": "held", "reason": "held_path", "attempts": ["A"]}]),
         push_ok([1]),
         tick(accepted=[], states={"A": "held"}),
         owner("land", attempt="A", states={"A": "validated"}),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {".premise/policy.json": POLICY_CREATURES_HELD, "creatures/urchin.js": URCHIN},
      "states": {"P": "landed", "A": "landed"}, "landings": [L(1, "P"), L(2, "A")]},
     note="P touches .premise/, which is always held (PO3). A was validated under the old policy; in the tick it is judged by the policy as it is after P.")

# ---------------------------------------------------------------- C36
case("C36-hero-sibling-reference-rule-lands-first",
     "The attempt edits one entity of a module whose other entity references the shared rule: the change of the rule gives a rule-based confirm with the diff",
     ["6.3 ModuleRefs", "D1", "E2m", "6.5", "T5"],
     {"A": "make the fish hide when its energy is low", "S": I_FRACTION},
     [
         read_e("A", FISH_UPDATE),
         S("A", "replace", FISH_HIDE, ok=True, result={"targets": [FISH_UPDATE], "altered": [FISH_UPDATE]},
           premises=[P("entity", FISH_UPDATE, 0, read=True, edit=True), P("query", "refs:" + FISH_UPDATE, 0, derived=True),
                     P("entity", K_STEP, 0, derived=True), P("entity", K_DRAIN, 0, derived=True), P("entity", K_EMAX, 0, derived=True)]),
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], judgments=[J("A", "entity", K_EMAX, "E2m", "rule", "confirm")],
              heads_ups=[hu("A", 1, "confirm", [item("entity", K_EMAX, "E2m", "confirm", after_contains="ENERGY_MAX = 1;")], dropped_ops=[], wake=True)],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
         submit("A", "Hide the fish when its energy is low", status="needs_confirm", result={"unresolved": [1]}),
         S("A", "replace", {"path": "creatures/fish.js", "old": "fish.energy < 30", "new": "fish.energy < 0.3"}, ok=True),
         submit("A", "Hide the fish when its energy is low", [1], "Energy is now a fraction, so the threshold is 0.3.", status="validated",
                judgments=[], heads_ups=[]),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, "creatures/fish.js": FISH_HIDE_03},
      "states": {"A": "landed", "S": "landed"}, "go_arounds": {"A": 0, "S": 0}, "landings": [L(1, "S"), L(2, "A")]},
     note="fish.js#update, the entity A alters, does not name ENERGY_MAX; fish.js#spawn, which A does not alter, does. NewRefs misses it, ModuleRefs holds it. A never read ENERGY_MAX: the derived premise was pinned at the operation. The submit raises no blind spot, because the reference is not one the attempt added.")

# ---------------------------------------------------------------- C37
case("C37-hero-sibling-reference-edit-lands-first",
     "The other order: the edit of a module that references the shared rule lands while the shared-rule change is in flight; the referrer set is unchanged, the referrer module changed",
     ["2.5 module hash", "D2", "QR1m", "8.2 context", "6.5"],
     {"S": I_FRACTION, "A": "make the fish hide when its energy is low"},
     [
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         read_e("A", FISH_UPDATE),
         S("A", "replace", FISH_HIDE, ok=True),
         submit("A", "Hide the fish when its energy is low", status="validated"),
         tick(accepted=["A"], judgments=[J("S", "query", "refs:" + K_EMAX, "QR1m", "rule", "confirm")],
              heads_ups=[hu("S", 1, "confirm", [item("query", "refs:" + K_EMAX, "QR1m", "confirm", added=[], context=[FISH_UPDATE])], dropped_ops=[])],
              states={"S": "working"}, go_arounds={"S": 0}),
         push_ok([1]),
         S("S", "replace", {"path": "creatures/fish.js", "old": "fish.energy < 30", "new": "fish.energy < 0.3"}, ok=True,
           result={"targets": [FISH_UPDATE], "altered": [FISH_UPDATE]}),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", [1], "The fish compared energy with 30; changed it to 0.3 in the same change.", status="validated"),
         tick(accepted=["S"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1, "creatures/fish.js": FISH_HIDE_03},
      "states": {"A": "landed", "S": "landed"}, "go_arounds": {"A": 0, "S": 0}, "landings": [L(1, "A"), L(2, "S")]})

# ---------------------------------------------------------------- C38
URCHIN_100 = ("export function spawn() {\n  return { x: 150, y: 195, vx: 0, vy: 0, energy: 100 };\n}\n\n"
              "export function update(urchin) {\n  urchin.tired = urchin.energy < 30;\n}\n")
case("C38-reader-landed-triage",
     "A change whose agent read the shared rule but wrote plain numbers lands while the rule is being altered: no reference exists, so no rule decides; the altering attempt gets a triage",
     ["QR4", "7.3", "6.5 limits", "TR1"],
     {"S": I_FRACTION, "A": "an urchin that tires"},
     [
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         read_e("A", K_EMAX),
         S("A", "write", {"path": "creatures/urchin.js", "content": URCHIN_100}, ok=True,
           premises=[P("file", "creatures/urchin.js", absent=True, edit=True)]),
         submit("A", "Add an urchin that tires", status="validated"),
         tick(accepted=["A"], judgments=[J("S", "query", "refs:" + K_EMAX, "QR4", "triage")],
              heads_ups=[hu("S", 1, "info", [item("query", "refs:" + K_EMAX, "QR4", "pending")], dropped_ops=[], wake=False)],
              states={"S": "working"}),
         push_ok([1]),
         S(None, "triage", {"attempt": "S", "kind": "query", "key": "refs:" + K_EMAX, "p": 0.9},
           judgments=[J("S", "query", "refs:" + K_EMAX, "QR4", "triage", "repair")],
           heads_ups=[hu("S", 2, "repair", [item("query", "refs:" + K_EMAX, "QR4", "repair")], dropped_ops=[])],
           states={"S": "going_around"}, go_arounds={"S": 1}),
     ],
     {"head_seq": 1, "files": {"creatures/urchin.js": URCHIN_100}, "states": {"A": "landed", "S": "going_around"},
      "go_arounds": {"S": 1}, "landings": [L(1, "A")]},
     note="The mirror image of rule E3. In the other order (S lands first) A's read premise on ENERGY_MAX goes to triage by E3. An agent that never read the rule and wrote plain numbers is outside what any premise can see (6.5, stated limit).")

# ---------------------------------------------------------------- C39
def ga_case():
    steps = [read_e("S", K_EMAX), S("S", "replace", S_FRACTION, ok=True)]
    def lands(n, x, **e):
        c = "C%d" % n; path = "creatures/c%d.js" % n
        return [read_e(c, K_EMAX), S(c, "write", {"path": path, "content": creature_e(x)}, ok=True), submit(c, "Add creature %d" % n, status="validated"),
                tick(**e)]
    q = lambda hn: hu("S", hn, "repair", [item("query", "refs:" + K_EMAX, "QR1", "repair")], dropped_ops=[])
    steps += lands(1, 100, accepted=["C1"], heads_ups=[q(1)], states={"S": "going_around"}, go_arounds={"S": 1}, right_of_way={"S": False}) + [push_ok([1])]
    steps += lands(2, 110, accepted=["C2"], heads_ups=[q(2)], states={"S": "going_around"}, go_arounds={"S": 1}, right_of_way={"S": False}) + [push_ok([2])]
    steps += [read_e("S", K_EMAX, edit=True)]
    steps += lands(3, 120, accepted=["C3"], heads_ups=[q(3)], states={"S": "going_around"}, go_arounds={"S": 2}, right_of_way={"S": True},
                   events_include=["attempt.state"]) + [push_ok([3])]
    steps += [read_e("S", K_EMAX, edit=True)]
    steps += lands(4, 130, accepted=[], skipped={"C4": "right_of_way"}, heads_ups=[], go_arounds={"S": 2}, waiting_behind=1)
    steps += [
        submit("S", "Make energy a fraction: ENERGY_MAX is 1", [1, 2, 3], "The three new creatures only start at ENERGY_MAX; nothing else to change.", status="validated"),
        tick(accepted=["S"], skipped={"C4": "not_disjoint"},
             heads_ups=[hu("C4", 1, "repair", [item("entity", K_EMAX, "E2", "repair")], dropped_ops=[])],
             states={"S": "accepted", "C4": "going_around"}, go_arounds={"C4": 1}),
        push_ok([4]),
    ]
    return steps
case("C39-go-around-count-under-repeated-repairs",
     "A repair that arrives before the previous one was delivered joins the go-around; one that arrives after it was delivered starts a new go-around, so right of way engages",
     ["GA1", "T10", "T10a", "HU8", "RW1", "RW3"],
     {"S": I_FRACTION, "C1": "creature 1", "C2": "creature 2", "C3": "creature 3", "C4": "creature 4"},
     ga_case(),
     {"head_seq": 4, "files": {"world/energy.js": ENERGY_1, "creatures/c4.js": None},
      "states": {"S": "landed", "C1": "landed", "C2": "landed", "C3": "landed", "C4": "going_around"},
      "go_arounds": {"S": 2, "C4": 1}, "landings": [L(1, "C1"), L(2, "C2"), L(3, "C3"), L(4, "S")]},
     note="S makes no call between landings 1 and 2, so heads-up 1 is not delivered and heads-up 2 joins go-around 1. S's read delivers both. Landing 3 then starts go-around 2 and grants right of way; C4 waits behind S.")

# ---------------------------------------------------------------- C40
case("C40-listing-gain-single-file-edit-holds",
     "An attempt that listed a directory and edits one of its files is not sweeping it: a new entry breaks nothing",
     ["L3", "7.2 sweeping", "14.4"],
     {"A": "make the snail shy", "B": "an urchin on the floor"},
     [
         S("A", "list", {"path": "creatures/"}, ok=True, premises=[P("listing", "creatures/", 0, read=True)]),
         read_e("A", "creatures/snail.js#update"),
         S("A", "replace", {"path": "creatures/snail.js", "old": "  snail.x += 0.1;\n", "new": "  snail.x += 0.1;\n  snail.shy = true;\n"}, ok=True),
         S("B", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         submit("B", "Add an urchin", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "listing", "creatures/", "L3", "rule", "holds")], heads_ups=[],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
         submit("A", "Make the snail shy", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"creatures/snail.js": SNAIL_SHY, "creatures/urchin.js": URCHIN},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 0, "B": 0}, "landings": [L(1, "B"), L(2, "A")]})

# ---------------------------------------------------------------- C41
case("C41-listing-gain-before-sweep",
     "A directory gains an entry after the agent listed it and before it edits: nothing is sent then (L3); when the attempt becomes a sweep, rule L1 fires at that operation",
     ["L1 late", "L3", "3.2 shown", "OP7"],
     {"A": "make every creature shy", "B": "an urchin on the floor"},
     [
         S("A", "list", {"path": "creatures/"}, ok=True),
         S("B", "write", {"path": "creatures/urchin.js", "content": URCHIN}, ok=True),
         submit("B", "Add an urchin", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "listing", "creatures/", "L3", "rule", "holds")], heads_ups=[], states={"A": "working"}),
         push_ok([1]),
         read_e("A", "creatures/snail.js#update"),
         S("A", "replace", {"path": "creatures/snail.js", "old": "  snail.x += 0.1;\n", "new": "  snail.x += 0.1;\n  snail.shy = true;\n"}, ok=True,
           judgments=[], heads_ups=[], states={"A": "working"}),
         read_e("A", "creatures/fish.js#update"),
         S("A", "replace", {"path": "creatures/fish.js", "old": "  step(fish);\n", "new": "  step(fish);\n  fish.shy = true;\n"}, ok=True,
           result={"op_seq": 2},
           judgments=[J("A", "listing", "creatures/", "L1", "rule", "repair")],
           heads_ups=[hu("A", 1, "repair", [item("listing", "creatures/", "L1", "repair", added=["urchin.js"])], cause="landing", dropped_ops=[])],
           states={"A": "going_around"}, go_arounds={"A": 1}),
         read_f("A", "creatures/urchin.js", at=1),
         S("A", "replace", {"path": "creatures/urchin.js", "old": "energy: 50 }", "new": "energy: 50, shy: true }"}, ok=True),
         submit("A", "Make every creature shy", [1], "Made the new urchin shy as well.", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"creatures/snail.js": SNAIL_SHY, "creatures/fish.js": FISH_SHY, "creatures/urchin.js": URCHIN_SHY},
      "states": {"A": "landed", "B": "landed"}, "go_arounds": {"A": 1, "B": 0}, "landings": [L(1, "B"), L(2, "A")]},
     note="The listing premise is re-pinned at landing 1 (V4), but its `shown` names stay the ones the agent saw. The second replace is accepted and recorded; the same response carries the heads-up.")

# ---------------------------------------------------------------- C42
case("C42-search-gain-one-of-many-altered",
     "A text search with four matches gains a fifth; the attempt altered only one of the four, so it is not a sweep: triage, not a rule-based repair",
     ["QT2", "QT1", "7.2 sweeping", "TR1"],
     {"A": "move the fish to the right", "B": "an anemone on the floor"},
     [
         S("A", "search", {"query": "energy", "path": "creatures/"}, ok=True, result={"containers": TEXT_ENERGY_0}),
         read_e("A", "creatures/fish.js#spawn"),
         S("A", "replace", {"path": "creatures/fish.js", "old": "x: 40, y: 60", "new": "x: 45, y: 60"}, ok=True,
           result={"targets": ["creatures/fish.js#spawn"], "altered": ["creatures/fish.js#spawn"]}),
         S("B", "write", {"path": "creatures/anemone.js", "content": ANEMONE}, ok=True),
         submit("B", "Add an anemone", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "query", "text:creatures/:energy", "QT2", "triage")],
              heads_ups=[hu("A", 1, "info", [item("query", "text:creatures/:energy", "QT2", "pending", added=["creatures/anemone.js#spawn"])], dropped_ops=[], wake=False)],
              states={"A": "working"}, go_arounds={"A": 0}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"creatures/anemone.js": ANEMONE}, "states": {"A": "working", "B": "landed"}, "go_arounds": {"A": 0},
      "landings": [L(1, "B")]})

# ---------------------------------------------------------------- C43
FISH_TWO = FISH.replace("  drain(fish, 1);\n", "  drain(fish, 1);\n  drain(fish, 2);\n")
case("C43-search-second-match-in-same-entity",
     "A second match appears inside an entity that already matched: the match count is part of the premise, so the change is seen",
     ["2.6", "QT0", "X0", "2.5"],
     {"A": "halve how fast every creature tires", "B": "the fish tires twice per tick"},
     [
         S("A", "search", {"query": "drain(", "path": "creatures/"}, ok=True, result={"containers": [FISH_UPDATE]},
           premises=[P("query", "text:creatures/:drain(", 0, read=True)]),
         read_e("B", FISH_UPDATE),
         S("B", "replace", {"path": "creatures/fish.js", "old": "  drain(fish, 1);\n", "new": "  drain(fish, 1);\n  drain(fish, 2);\n"}, ok=True),
         submit("B", "Drain the fish twice", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "query", "text:creatures/:drain(", "X0", "rule", "holds")],
              heads_ups=[hu("A", 1, "info", [item("query", "text:creatures/:drain(", "X0", "holds", added=[FISH_UPDATE])], dropped_ops=[], wake=False)],
              states={"A": "working"}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"creatures/fish.js": FISH_TWO}, "states": {"A": "working", "B": "landed"}, "landings": [L(1, "B")]},
     note="The container set is unchanged ({fish.js#update}); the member changes from fish.js#update*1 to fish.js#update*2. A has no operation yet, so the triage row becomes X0.")

# ---------------------------------------------------------------- C44 / C45
EEL_NS = ('import * as E from "../world/energy.js";\n\n'
          "export function spawn() {\n"
          '  const k = "ENERGY_MAX";\n'
          "  return { x: 5, y: 100, vx: 1, vy: 0, energy: E[k] };\n"
          "}\n")
EEL_P = "creatures/eel.js"
case("C44-whole-module-reference-rule-lands-first",
     "A namespace import used with a computed key references the whole module: a change to any entity of that module is a rule-based repair",
     ["6.2", "D1", "F3", "7.2 exhaustive"],
     {"A": I_EEL, "S": I_FRACTION},
     [
         read_f("A", "world/energy.js"),
         S("A", "write", {"path": EEL_P, "content": EEL_NS}, ok=True,
           premises=[P("file", EEL_P, absent=True, edit=True), P("file", "world/energy.js", 0, read=True, derived=True)]),
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"], judgments=[J("A", "file", "world/energy.js", "F3", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("file", "world/energy.js", "F3", "repair")], dropped_ops=[])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"world/energy.js": ENERGY_1}, "states": {"A": "going_around", "S": "landed"}, "go_arounds": {"A": 1},
      "landings": [L(1, "S")]})
case("C45-whole-module-reference-creature-lands-first",
     "The other order: a new whole-module referrer is a referrer of every entity of that module",
     ["6.2 referrers", "D2", "QR1"],
     {"S": I_FRACTION, "A": I_EEL},
     [
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         read_f("A", "world/energy.js"),
         S("A", "write", {"path": EEL_P, "content": EEL_NS}, ok=True),
         submit("A", "Add an eel", status="validated"),
         tick(accepted=["A"], judgments=[J("S", "query", "refs:" + K_EMAX, "QR1", "rule", "repair")],
              heads_ups=[hu("S", 1, "repair", [item("query", "refs:" + K_EMAX, "QR1", "repair",
                                                    added=[EEL_P + "#(import ../world/energy.js)", EEL_P + "#spawn"], context=[])], dropped_ops=[])],
              states={"S": "going_around"}, go_arounds={"S": 1}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {EEL_P: EEL_NS}, "states": {"A": "landed", "S": "going_around"}, "go_arounds": {"S": 1},
      "landings": [L(1, "A")]})

# ---------------------------------------------------------------- C46
REGEN = "world/energy.js#regen"
REGEN_A = {"path": "world/energy.js", "old": "export const ENERGY_MAX = 100;",
           "new": "export const ENERGY_MAX = 100;\n\nexport function regen(creature) {\n  creature.energy += 1;\n}"}
REGEN_B = {"path": "world/energy.js", "old": "export function drain(creature, amount) {",
           "new": "export function regen(creature) {\n  creature.energy += 2;\n}\n\nexport function drain(creature, amount) {"}
case("C46-same-new-entity-added-twice",
     "Two changes add an entity with the same name to one module from different anchors: the absence each relied on is pinned, so the second is repaired with the diff",
     ["R4a", "E1", "9.4 step 3b"],
     {"A": "creatures slowly regain energy", "B": "creatures regain energy quickly"},
     [
         S("A", "replace", REGEN_A, ok=True, result={"targets": [K_EMAX], "altered": [], "added": [REGEN]},
           premises=[P("entity", K_EMAX, 0, edit=True), P("entity", REGEN, absent=True, edit=True)]),
         S("B", "replace", REGEN_B, ok=True, result={"targets": [K_DRAIN], "altered": [], "added": [REGEN]},
           premises=[P("entity", K_DRAIN, 0, edit=True), P("entity", REGEN, absent=True, edit=True)]),
         submit("A", "Add regen", status="validated"),
         submit("B", "Add regen", status="validated"),
         tick(accepted=["A"], skipped={"B": "not_disjoint"}, judgments=[J("B", "entity", REGEN, "E1", "rule", "repair")],
              heads_ups=[hu("B", 1, "repair", [item("entity", REGEN, "E1", "repair", after_contains="creature.energy += 1;")], dropped_ops=[])],
              states={"A": "accepted", "B": "going_around"}, go_arounds={"B": 1}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"world/energy.js": ENERGY.replace("export const ENERGY_MAX = 100;", REGEN_A["new"])},
      "states": {"A": "landed", "B": "going_around"}, "go_arounds": {"B": 1}, "landings": [L(1, "A")]},
     note="B's replace still matches once in drain, so no operation is dropped; without the premise pinned at `absent` B would reach the tick with every premise holding and a duplicate declaration.")

# ---------------------------------------------------------------- C47
def pull_case():
    steps = [read_e("A", FISH_UPDATE), S("A", "replace", FISH_HIDE, ok=True)]
    values = [100, 90, 80, 70]
    for k in (1, 2):
        b = "B%d" % k
        steps += [
            read_e(b, K_EMAX, at=k - 1),
            S(b, "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = %d" % values[k - 1], "new": "ENERGY_MAX = %d" % values[k]}, ok=True),
            submit(b, "Lower ENERGY_MAX to %d" % values[k], status="validated"),
            submit("A", "Hide the fish when its energy is low", status="validated") if k == 1 else
            submit("A", "Hide the fish when its energy is low", [k - 1], "The threshold 30 still fits.", status="validated"),
            tick(accepted=[b], skipped={"A": "not_disjoint"},
                 heads_ups=[hu("A", k, "confirm", [item("entity", K_EMAX, "E2m", "confirm")], dropped_ops=[])],
                 states={"A": "needs_confirm"}, go_arounds={"A": 0}, pull_backs={"A": k}, right_of_way={"A": k == 2}),
            push_ok([k]),
        ]
    steps += [
        read_e("B3", K_EMAX, at=2),
        S("B3", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 80", "new": "ENERGY_MAX = 70"}, ok=True),
        submit("B3", "Lower ENERGY_MAX to 70", status="validated"),
        tick(accepted=[], skipped={"B3": "right_of_way"}, states={"B3": "validated", "A": "needs_confirm"}, waiting_behind=1, heads_ups=[]),
        submit("A", "Hide the fish when its energy is low", [2], "The threshold 30 still fits.", status="validated"),
        tick(accepted=["A"], skipped={"B3": "not_disjoint"},
             heads_ups=[hu("B3", 1, "confirm", [item("query", "refs:" + K_EMAX, "QR1m", "confirm", context=[FISH_UPDATE])], dropped_ops=[])],
             states={"A": "accepted", "B3": "needs_confirm"}, pull_backs={"B3": 1}, go_arounds={"B3": 0}, waiting_behind=0),
        push_ok([3], states={"A": "landed"}),
    ]
    return steps
case("C47-confirm-pull-backs-are-counted",
     "A confirm that pulls an attempt out of the landing queue is counted; after two the attempt has right of way, and a candidate that would give it another rule-based confirm waits",
     ["T11", "GA3", "RW1", "RW3", "E2m", "QR1m"],
     {"A": "make the fish hide when its energy is low", "B1": "lower the energy cap to 90", "B2": "lower the energy cap to 80", "B3": "lower the energy cap to 70"},
     pull_case(),
     {"head_seq": 3, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 80"), "creatures/fish.js": FISH_HIDE_30},
      "states": {"A": "landed", "B1": "landed", "B2": "landed", "B3": "needs_confirm"}, "go_arounds": {"A": 0, "B3": 0},
      "landings": [L(1, "B1"), L(2, "B2"), L(3, "A")]})

# ---------------------------------------------------------------- C48
def held_row_case(action):
    steps = [read_e("A", K_EMAX), S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True)]
    values = [100, 90, 80, 70]
    for k in (1, 2):
        b = "B%d" % k
        steps += [
            read_e(b, K_EMAX, at=k - 1),
            S(b, "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = %d" % values[k - 1], "new": "ENERGY_MAX = %d" % values[k]}, ok=True),
            submit(b, "Lower ENERGY_MAX to %d" % values[k], status="held"),
            owner("land", attempt=b, states={b: "validated"}),
            submit("A", "Add a crab", status="validated") if k == 1 else
            submit("A", "Add a crab", [k - 1], "The crab still wants the threshold 30.", status="validated"),
            tick(accepted=[b], skipped={"A": "not_disjoint"}, states={"A": "going_around"}, go_arounds={"A": k}, right_of_way={"A": k == 2}),
            push_ok([k]),
        ]
    steps += [
        read_e("A", K_EMAX, at=2, derived=True),
        read_e("B3", K_EMAX, at=2),
        S("B3", "replace", {"path": "world/energy.js", "old": "ENERGY_MAX = 80", "new": "ENERGY_MAX = 70"}, ok=True),
        submit("B3", "Lower ENERGY_MAX to 70", status="held",
               cards=[{"kind": "held", "reason": "held_path", "attempts": ["B3"], "blast_radius": {"repair": ["A"], "confirm": [], "triage": []}}]),
    ]
    if action == "land":
        steps += [
            owner("land", attempt="B3", states={"B3": "validated"}),
            tick(accepted=[], skipped={"B3": "right_of_way"}, states={"B3": "validated", "A": "going_around"}, waiting_behind=1, heads_ups=[], go_arounds={"A": 2}),
        ]
        final = {"head_seq": 2, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 80")},
                 "states": {"A": "going_around", "B3": "validated"}, "go_arounds": {"A": 2}, "landings": [L(1, "B1"), L(2, "B2")]}
    else:
        steps += [
            owner("land_now", attempt="B3", states={"B3": "validated"}),
            tick(accepted=["B3"], skipped={}, heads_ups=[hu("A", 3, "repair", [item("entity", K_EMAX, "E2", "repair")], dropped_ops=[])],
                 states={"B3": "accepted", "A": "going_around"}, go_arounds={"A": 3}),
            push_ok([3]),
        ]
        final = {"head_seq": 3, "files": {"world/energy.js": ENERGY.replace("ENERGY_MAX = 100", "ENERGY_MAX = 70")},
                 "states": {"A": "going_around", "B3": "landed"}, "go_arounds": {"A": 3}, "landings": [L(1, "B1"), L(2, "B2"), L(3, "B3")]}
    return steps, final
B_INTENTS = {"A": I_CRAB, "B1": "lower the energy cap to 90", "B2": "lower the energy cap to 80", "B3": "lower the energy cap to 70"}
st, fi = held_row_case("land")
case("C48-right-of-way-holds-an-approved-landing",
     "Under a policy that holds shared rules, an owner-approved landing still waits behind an attempt with right of way",
     ["RW3", "RW5", "10.2", "11.6"], B_INTENTS, st, fi, files={".premise/policy.json": POLICY_HELD},
     note="C24 with world/** held. The card for B3 shows that landing it sends A around again. 'Land' queues it behind A.")
st, fi = held_row_case("land_now")
case("C49-land-now-bypasses-right-of-way",
     "The owner's explicit 'Land now' on a held card bypasses right of way; the attempt with right of way takes a third go-around",
     ["RW5", "10.2", "GA1", "T10a"], B_INTENTS, st, fi, files={".premise/policy.json": POLICY_HELD},
     note="A's read before B3 delivers heads-up 2, so the repair from landing 3 starts go-around 3 (GA1).")

# ---------------------------------------------------------------- C50
case("C50-push-main-applied-notes-not",
     "A push that updates main but not the notes ref: the landings are on main and are called landed; no new batch forms until the notes ref is updated",
     ["LP5", "LP1", "LP9", "9.6"],
     {"A": I_CRAB, "B": I_EEL},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         submit("A", "Add a crab", status="validated"),
         tick(accepted=["A"], states={"A": "accepted"}),
         S(None, "push_result", {"remote_main": "new", "remote_notes": "old"}, action="retry_notes", landed=[1], states={"A": "landed"},
           events_include=["landing.landed"], events_exclude=["batch.pushed"]),
         read_e("B", K_SPEED),
         S("B", "write", {"path": "creatures/eel.js", "content": EEL}, ok=True),
         submit("B", "Add an eel", status="validated"),
         tick(accepted=[], states={"B": "validated"}),
         S(None, "push_result", {"remote_main": "new", "remote_notes": "new"}, action="mark_pushed", landed=[], events_include=["batch.pushed"]),
         tick(accepted=["B"]),
     ],
     {"head_seq": 2, "files": {CRAB: CRAB_30, "creatures/eel.js": EEL}, "states": {"A": "landed", "B": "accepted"},
      "landings": [L(1, "A"), L(2, "B")]},
     note="push_result gives the values of both remote refs read after a push that did not report all refs ok: old, new or other, relative to the outbox row.")

# ---------------------------------------------------------------- C51
case("C51-push-outcomes-by-ref-value",
     "After any push result that is not all-ok, Trunk reads both refs and decides by value",
     ["LP5", "LP6", "LP7"],
     {"A": I_CRAB},
     [
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         submit("A", "Add a crab", status="validated"),
         tick(accepted=["A"], states={"A": "accepted"}),
         S(None, "push_result", {"remote_main": "old", "remote_notes": "new"}, action="retry_main", landed=[], states={"A": "accepted"}, events_exclude=["landing.landed"]),
         S(None, "push_result", {"remote_main": "old", "remote_notes": "old"}, action="repush", landed=[], states={"A": "accepted"}),
         S(None, "restart", {"remote_main": "old", "remote_notes": "other"}, action="pause", pool_state="paused", landed=[], states={"A": "accepted"},
           events_include=["pool.paused"]),
     ],
     {"head_seq": 1, "files": {CRAB: CRAB_30}, "states": {"A": "accepted"}, "landings": [L(1, "A")]})

# ---------------------------------------------------------------- C52
case("C52-restart-with-pending-triage",
     "Trunk restarts while a Clef answer is awaited: the question is asked again; with no answer the outcome is the fail-closed confirm",
     ["TR6", "7.3", "LP7"],
     {"A": I_CRAB, "B": "raise the top speed to 3"},
     [
         read_e("A", K_SPEED),
         read_e("A", K_EMAX),
         S("A", "write", {"path": CRAB, "content": CRAB_30}, ok=True),
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "entity", K_SPEED, "E3", "triage")]),
         S(None, "restart", {"remote_main": "new", "remote_notes": "new"}, action="mark_pushed", landed=[1],
           reasked=[{"attempt": "A", "kind": "entity", "key": K_SPEED}]),
         submit("A", "Add a crab that hides when its energy is low", status="submitted"),
         S(None, "triage", {"attempt": "A", "kind": "entity", "key": K_SPEED, "p": None},
           judgments=[J("A", "entity", K_SPEED, "E3", "triage", "confirm")],
           heads_ups=[hu("A", 2, "confirm", [item("entity", K_SPEED, "E3", "confirm")], dropped_ops=[])],
           states={"A": "needs_confirm"}, pull_backs={"A": 1}),
     ],
     {"head_seq": 1, "files": {CRAB: None}, "states": {"A": "needs_confirm", "B": "landed"}, "landings": [L(1, "B")]},
     note="A submit with a pending triage answers `submitted` (CK8). The unavailable outcome pulls the attempt back to needs_confirm, which is counted (T11).")

# ---------------------------------------------------------------- C53
case("C53-undo-plan-changed",
     "An undo is confirmed against the plan the owner saw; if the plan is different now, nothing lands and the new plan is returned. An undo landing is not an undo target",
     ["UN4", "UN5a", "11.3"],
     {"S": I_FRACTION, "A": I_CRAB},
     [
         read_e("S", K_EMAX),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="validated"),
         tick(accepted=["S"]),
         push_ok([1]),
         read_e("A", K_EMAX, at=1),
         S("A", "write", {"path": CRAB, "content": CRAB_03}, ok=True),
         submit("A", "Add a crab that hides when its energy is low", status="validated"),
         tick(accepted=["A"]),
         push_ok([2]),
         owner("undo", seq=1, expect_reverted=[1], refused="plan_changed",
               undo={"reverted": [1, 2], "reopened": ["A"], "kept_readers": []}, events_exclude=["undo.planned"]),
         tick(accepted=[]),
         owner("undo", seq=1, expect_reverted=[1, 2], undo={"reverted": [1, 2], "reopened": ["A"], "kept_readers": []}, events_include=["undo.planned"]),
         tick(accepted=["undo:1"], landings=[{"seq": 3, "kind": "undo", "undoes": [1, 2]}], states={"S": "stopped", "A": "going_around"}),
         push_ok([3]),
         owner("undo", seq=3, refused="not_a_change"),
         owner("undo", seq=1, refused="already_undone"),
     ],
     {"head_seq": 3, "files": {"world/energy.js": ENERGY, CRAB: None}, "states": {"S": "stopped", "A": "going_around"}, "go_arounds": {"A": 1},
      "landings": [L(1, "S"), L(2, "A"), {"seq": 3, "kind": "undo"}]})

# ---------------------------------------------------------------- C54
case("C54-second-repair-from-a-race-sibling",
     "A second E1 repair on the same entity caused by an attempt of the attempt's own intent (a Race sibling) is an ordinary go-around, not a contradiction",
     ["GL3", "T8", "E1"],
     {"A": {"intent": "set the top speed to 10", "intent_id": "i_speed10"}, "B": "raise the top speed to 3",
      "C": {"intent": "set the top speed to 10", "intent_id": "i_speed10"}},
     [
         read_e("B", K_SPEED),
         S("B", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         submit("B", "Raise MAX_SPEED to 3", status="validated"),
         read_e("A", K_SPEED),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 10"}, ok=True),
         submit("A", "Set MAX_SPEED to 10", status="validated"),
         tick(accepted=["B"], skipped={"A": "not_disjoint"}, states={"A": "going_around"}, go_arounds={"A": 1}, cards=[]),
         push_ok([1]),
         read_e("C", K_SPEED, at=1),
         S("C", "replace", {"path": "world/movement.js", "old": "export const MAX_SPEED = 3;", "new": "export const MAX_SPEED = 2 * 5;"}, ok=True),
         submit("C", "Set MAX_SPEED to 10", status="validated"),
         read_e("A", K_SPEED, at=1),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 3", "new": "MAX_SPEED = 10"}, ok=True),
         submit("A", "Set MAX_SPEED to 10", [1], "Re-applied on top of 3.", status="validated"),
         tick(accepted=["C"], skipped={"A": "not_disjoint"},
              heads_ups=[hu("A", 2, "repair", [item("entity", K_SPEED, "E1", "repair")], dropped_ops=[{"op_seq": 2, "rule": "OP1"}])],
              states={"A": "going_around"}, go_arounds={"A": 2}, cards=[]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/movement.js": MOVEMENT.replace("MAX_SPEED = 2;", "MAX_SPEED = 2 * 5;")},
      "states": {"A": "going_around", "B": "landed", "C": "landed"}, "go_arounds": {"A": 2}, "landings": [L(1, "B"), L(2, "C")]},
     constants={"STARVATION_AFTER": 99},
     note="Compare C17, where the second landing belongs to another intent. Attempts with the same intent_id are attempts of one intent.")

# ---------------------------------------------------------------- C55
case("C55-info-heads-up-does-not-wake-or-close-a-card",
     "An info heads-up to an attempt waiting on a held card starts no model turn and leaves the card open; the pending triage blocks the owner's tap until it is answered",
     ["HE2", "HU5", "TR1", "TR3", "T13", "11.6"],
     {"S": I_FRACTION, "B": "creatures tire twice as fast"},
     [
         read_e("S", K_EMAX),
         read_e("S", K_DRAIN),
         S("S", "replace", S_FRACTION, ok=True),
         submit("S", "Make energy a fraction: ENERGY_MAX is 1", status="held", states={"S": "held"}),
         read_e("B", K_DRAIN),
         S("B", "replace", {"path": "world/energy.js", "old": "creature.energy - amount", "new": "creature.energy - amount * 2"}, ok=True),
         submit("B", "Double the drain", status="held",
                cards=[{"kind": "held", "reason": "held_path", "attempts": ["B"], "blast_radius": {"repair": [], "confirm": [], "triage": ["S"]}}]),
         owner("land", attempt="B", states={"B": "validated"}),
         tick(accepted=["B"], judgments=[J("S", "entity", K_DRAIN, "E3", "triage")],
              heads_ups=[hu("S", 1, "info", [item("entity", K_DRAIN, "E3", "pending")], dropped_ops=[], wake=False)],
              states={"S": "held"}, events_exclude=["card.closed"]),
         push_ok([1]),
         owner("land", attempt="S", states={"S": "held"}),
         S(None, "triage", {"attempt": "S", "kind": "entity", "key": K_DRAIN, "p": 0.05},
           judgments=[J("S", "entity", K_DRAIN, "E3", "triage", "holds")], heads_ups=[], states={"S": "held"}, events_exclude=["card.closed"]),
         owner("land", attempt="S", states={"S": "validated"}),
         tick(accepted=["S"]),
         push_ok([2]),
     ],
     {"head_seq": 2, "files": {"world/energy.js": ENERGY_1.replace("creature.energy - amount", "creature.energy - amount * 2")},
      "states": {"S": "landed", "B": "landed"}, "go_arounds": {"S": 0}, "landings": [L(1, "B"), L(2, "S")]},
     files={".premise/policy.json": POLICY_HELD})

# ---------------------------------------------------------------- C56
MOVEMENT_4 = MOVEMENT.replace("MAX_SPEED = 2", "MAX_SPEED = 4")
case("C56-replace-then-write-base-changed",
     "A whole-file write that follows a replace on the same path records its own base: when the file changes underneath, every operation on the path is dropped",
     ["W4", "OP5", "OP6", "F1"],
     {"A": "raise the top speed to 4", "B": "document the speed unit"},
     [
         read_f("A", "world/movement.js"),
         S("A", "replace", {"path": "world/movement.js", "old": "MAX_SPEED = 2", "new": "MAX_SPEED = 3"}, ok=True),
         S("A", "write", {"path": "world/movement.js", "content": MOVEMENT_4}, ok=True, result={"op_seq": 2},
           premises=[P("file", "world/movement.js", 0, read=True, edit=True)]),
         S("B", "replace", B_COMMENT, ok=True),
         submit("B", "Document the unit of MAX_SPEED", status="validated"),
         tick(accepted=["B"], judgments=[J("A", "file", "world/movement.js", "F1", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("file", "world/movement.js", "F1", "repair")],
                            dropped_ops=[{"op_seq": 1, "rule": "OP5"}, {"op_seq": 2, "rule": "OP5"}])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"world/movement.js": MOVEMENT_COMMENT}, "states": {"A": "going_around", "B": "landed"}, "go_arounds": {"A": 1},
      "landings": [L(1, "B")]})

# ---------------------------------------------------------------- C57
INDEX = 'export * from "./energy.js";\n'
INDEX_DRAIN = INDEX + "\nexport function drain(creature, amount) {\n  creature.energy -= amount / 2;\n}\n"
CRAB_VIA_INDEX = crab_drain("2").replace("../world/energy.js", "../world/index.js")
case("C57-star-reexport-name-now-shadowed",
     "An import resolved through `export *` relied on the name being absent from the re-exporting module: that absence is pinned, so a local export added later is caught",
     ["6.2 resolveExport", "D1b", "E2", "HU2a"],
     {"A": "a crab that tires quickly", "B": "halve every drain"},
     [
         read_f("A", "world/index.js"),
         read_e("A", K_DRAIN),
         S("A", "write", {"path": CRAB, "content": CRAB_VIA_INDEX}, ok=True,
           premises=[P("file", CRAB, absent=True, edit=True), P("entity", "world/index.js#*./energy.js", 0, derived=True),
                     P("entity", K_DRAIN, 0, read=True, derived=True), P("entity", "world/index.js#drain", absent=True, derived=True)]),
         read_f("B", "world/index.js"),
         S("B", "write", {"path": "world/index.js", "content": INDEX_DRAIN}, ok=True),
         submit("B", "Halve every drain", status="validated"),
         submit("A", "Add a crab that tires quickly", status="validated"),
         tick(accepted=["B"], skipped={"A": "not_disjoint"},
              judgments=[J("A", "entity", "world/index.js#drain", "E2", "rule", "repair"), J("A", "file", "world/index.js", "F3", "rule", "repair")],
              heads_ups=[hu("A", 1, "repair", [item("entity", "world/index.js#drain", "E2", "repair", after_contains="amount / 2")], dropped_ops=[])],
              states={"A": "going_around"}, go_arounds={"A": 1}),
         push_ok([1]),
     ],
     {"head_seq": 1, "files": {"world/index.js": INDEX_DRAIN}, "states": {"A": "going_around", "B": "landed"}, "go_arounds": {"A": 1},
      "landings": [L(1, "B")]},
     files={"world/index.js": INDEX},
     note="The hop entity and energy.js#drain are unchanged by B; what changed is the binding. The file premise on world/index.js is also judged (F3), and its item is folded into the entity item (HU2a).")
