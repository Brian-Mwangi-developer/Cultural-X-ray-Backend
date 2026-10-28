"""Build src/modules/lookup/towns.data.json: UK and US towns for onboarding's town search.

Source: GeoNames (https://www.geonames.org, CC BY 4.0): cities1000.txt (places with 1,000+ people)
and admin1CodesASCII.txt (region names). Download both into a folder, then:

    python3 -I scripts/build-towns.py /path/to/geonames-folder

Rows are compact: [id, name, region, country, lat, lon, population], most populous first.
"""
import json
import pathlib
import sys

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent / "src/modules/lookup/towns.data.json"

regions = {}
for line in (src / "admin1CodesASCII.txt").read_text(encoding="utf-8").splitlines():
    code, name, *_ = line.split("\t")
    regions[code] = name

rows = []
with (src / "cities1000.txt").open(encoding="utf-8") as f:
    for line in f:
        c = line.rstrip("\n").split("\t")
        country = c[8]
        if country not in ("GB", "US") or not c[7].startswith("PPL"):
            continue
        rows.append([int(c[0]), c[1], regions.get(f"{country}.{c[10]}", ""), country, round(float(c[4]), 4), round(float(c[5]), 4), int(c[14] or 0)])

rows.sort(key=lambda r: -r[6])
out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(rows)} towns -> {out} ({out.stat().st_size // 1024} KB)")
