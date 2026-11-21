"""Build foods.json for the app from the raw Tzameret (Israeli MoH) tables.

Input : data-source/mitzrachim.json, yehidot_mida.json, yehidot_mida_lemitzrachim.json
        (pulled from data.gov.il dataset "nutrition-database" via the CKAN datastore API)
Output: foods.json  (compact array format, loaded by index.html)

Missing nutrient values are kept as null (unknown) - never converted to 0.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data-source")

# Order matters: the app reads nutrients by index.
NUTRIENTS = [
    ("food_energy", "kcal"), ("protein", "pro"), ("carbohydrates", "carb"),
    ("total_fat", "fat"), ("calcium", "calc"), ("sodium", "sod"),
    ("total_dietary_fiber", "fiber"), ("total_sugars", "sugar"),
    ("saturated_fat", "satfat"), ("iron", "iron"), ("cholesterol", "chol"),
]

def num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f == int(f) else round(f, 3)

def main():
    foods = json.load(open(os.path.join(SRC, "mitzrachim.json"), encoding="utf-8"))["records"]
    unit_names = {r["smlmida"].strip(): " ".join(r["shmmida"].split())
                  for r in json.load(open(os.path.join(SRC, "yehidot_mida.json"), encoding="utf-8"))["records"]}
    unit_rows = json.load(open(os.path.join(SRC, "yehidot_mida_lemitzrachim.json"), encoding="utf-8"))["records"]

    units_by_food = {}
    for r in unit_rows:
        code, mida, grams = str(r["mmitzrach"]).strip(), str(r["mida"]).strip(), num(r["mishkal"])
        if mida in ("700", "2000") or not grams or grams <= 0:
            continue  # grams / kilogram are added by the app itself
        units_by_food.setdefault(code, [])
        if all(u[0] != int(mida) for u in units_by_food[code]):
            units_by_food[code].append([int(mida), grams])

    out_foods, last_update = [], ""
    for r in foods:
        name = " ".join(str(r["shmmitzrach"] or "").split())
        if not name:
            continue
        upd = r.get("tarich_idkun") or ""
        if len(upd) >= 10:
            iso = upd[6:10] + "-" + upd[3:5] + "-" + upd[0:2]
            last_update = max(last_update, iso)
        out_foods.append([
            int(r["Code"]),
            num(r["smlmitzrach"]),
            name,
            " ".join(str(r.get("english_name") or "").split()),
            num(r.get("makor")),
            [num(r.get(k)) for k, _ in NUTRIENTS],
            units_by_food.get(str(r["Code"]), []),
        ])

    out = {
        "source": "Tzameret - Israeli National Nutrient Database, Israel Ministry of Health (data.gov.il dataset 'nutrition-database')",
        "sourceUrl": "https://data.gov.il/dataset/nutrition-database",
        "dataLastUpdated": last_update,
        "builtFrom": "data.gov.il datastore API",
        "nutrientKeys": [k for _, k in NUTRIENTS],
        "nutrientsPer": "100 g edible portion",
        "unitNames": {int(k): v for k, v in unit_names.items()},
        "foodFields": ["code", "smlmitzrach", "nameHe", "nameEn", "makor", "nutrients", "units[[unitCode,grams]]"],
        "foods": out_foods,
    }
    path = os.path.join(ROOT, "foods.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    missing = {k: sum(1 for f in out_foods if f[5][i] is None) for i, (_, k) in enumerate(NUTRIENTS)}
    print(f"wrote {path}: {len(out_foods)} foods, {os.path.getsize(path)//1024} KB, last update {last_update}")
    print("foods with missing value per nutrient:", missing)
    print("foods with portion units:", sum(1 for f in out_foods if f[6]))

if __name__ == "__main__":
    main()
