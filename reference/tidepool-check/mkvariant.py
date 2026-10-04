import sys, shutil, os
name, scale, thr, cost = sys.argv[1:5]
shutil.copytree("pool", name, dirs_exist_ok=True)
for f in os.listdir("hero"):
    shutil.copy(os.path.join("hero", f), os.path.join(name, "creatures", f))
if scale == "1":
    p = name + "/world/energy.js"; s = open(p).read()
    old = "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;"
    new = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;"
    assert s.count(old) == 1
    open(p, "w").write(s.replace(old, new))
p = name + "/creatures/crab.js"; s = open(p).read(); assert s.count("crab.energy < 30") == 1
open(p, "w").write(s.replace("crab.energy < 30", "crab.energy < " + thr))
p = name + "/creatures/shrimp.js"; s = open(p).read(); assert s.count("drain(shrimp, 5)") == 1
open(p, "w").write(s.replace("drain(shrimp, 5)", "drain(shrimp, " + cost + ")"))
