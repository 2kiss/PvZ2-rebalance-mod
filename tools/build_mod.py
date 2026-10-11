#!/usr/bin/env python3
"""Build the PvZ2 Night Carnival mod IPA from an original/decrypted PvZ2 IPA.

    python3 tools/build_mod.py input.ipa output.ipa [--config mod/config.json]
"""
import argparse
import copy
import json
import os
import plistlib
import re
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pvz2 import macho, rton  # noqa: E402
from pvz2.rsb import RSB  # noqa: E402

# Third-party code that pirate sites inject into the IPA.
INJECTED = re.compile(r"(IPAOMTK|Check0ver|libsubstr|iGameGod|iOSGods)", re.I)

PACKAGE = "Packages"
END_OF_TIME = 2147483647  # max int32: the schedule never expires
LANGS = ["EN-US", "DE-DE", "ES-ES", "FR-FR", "IT-IT", "PT-BR"]
VARIANTS = ["", "_VARIANT_TREATMENT_A\\", "_VARIANT_TREATMENT_B\\"]
SCHEDULES = [v + "MARKET_SCHEDULE" for v in VARIANTS]
LAYOUTS = [v + "MARKET_LAYOUT" for v in VARIANTS]


def log(*a):
    print("[mod]", *a)


# ---------------------------------------------------------------------------
# IPA level
# ---------------------------------------------------------------------------

def strip_injected(app):
    exe = plistlib.load(open(os.path.join(app, "Info.plist"), "rb"))["CFBundleExecutable"]
    exe_path = os.path.join(app, exe)
    data, removed = macho.remove_dylibs(open(exe_path, "rb").read(), lambda n: bool(INJECTED.search(n)))
    open(exe_path, "wb").write(data)
    for n in removed:
        log("unlinked", n)
    for root in (app, os.path.join(app, "Frameworks")):
        for name in os.listdir(root):
            if INJECTED.search(name):
                p = os.path.join(root, name)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
                log("deleted", os.path.relpath(p, app))


def set_identity(app, name, bundle_id):
    path = os.path.join(app, "Info.plist")
    info = plistlib.load(open(path, "rb"))
    info["CFBundleDisplayName"] = name
    if bundle_id:
        info["CFBundleIdentifier"] = bundle_id
    plistlib.dump(info, open(path, "wb"))


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

class Data:
    """Lazy decoded view of Packages/*.RTON with change tracking."""

    def __init__(self, rsg):
        self.raw = {p.upper(): b for p, b in rsg.files()}
        self.docs = {}

    def __getitem__(self, name):
        key = "PACKAGES\\%s.RTON" % name.upper()
        if key not in self.docs:
            self.docs[key] = rton.decode(self.raw[key])
        return self.docs[key]

    def encoded(self):
        return {k: rton.encode(v) for k, v in self.docs.items()}


def strings_list(data, lang):
    return data["LAWNSTRINGS-" + lang]["objects"][0]["objdata"]["LocStringValues"]


class Strings:
    def __init__(self, data):
        self.lists = {lang: strings_list(data, lang) for lang in LANGS}
        self.maps = {lang: dict(zip(l[0::2], l[1::2])) for lang, l in self.lists.items()}

    def get(self, key, lang="EN-US"):
        return self.maps[lang].get(key) or self.maps["EN-US"].get(key) or key

    def add(self, key, per_lang):
        """per_lang: str or callable(lang) -> str."""
        for lang, lst in self.lists.items():
            val = per_lang(lang) if callable(per_lang) else per_lang
            if key in self.maps[lang]:
                i = lst.index(key, 0)
                lst[i + 1] = val
            else:
                lst += [key, val]
            self.maps[lang][key] = val


def fmt_num(n):
    return "{:,}".format(n)


def round_price(x, step=500):
    return max(step, int(round(x / step)) * step)


# ---------------------------------------------------------------------------
# Patches
# ---------------------------------------------------------------------------

def patch_coins(data, cfg):
    for o in data["COLLECTABLETYPES"]["objects"]:
        od = o["objdata"]
        if od.get("TypeName") in cfg["coins"]:
            log("coin value %s: %s -> %s" % (od["TypeName"], od["CoinValue"], cfg["coins"][od["TypeName"]]))
            od["CoinValue"] = cfg["coins"][od["TypeName"]]


def premium_plants(products, cfg):
    by = {}
    for p in products:
        if p["ObjectType"] == "plant":
            by.setdefault(p["ObjectItem"], []).append(p)
    plants = {}
    for item, prods in by.items():
        usd = max(p["Price"] for p in prods)
        gems = max(p["PriceGems"] for p in prods)
        mints = max(p["PriceMints"] for p in prods)
        if not (usd or gems or mints):
            continue
        if mints:
            tier = "mint"
        elif usd >= 6.99:
            tier = "legendary"
        elif usd >= 4.99 or gems >= 1000:
            tier = "epic"
        else:
            tier = "rare"
        tier = cfg["plant_tier_overrides"].get(item, tier)
        # Template: prefer a product whose name string resolves to the plant name.
        template = sorted(prods, key=lambda p: (p["Price"] == 0 and p["PriceGems"] == 0, len(p["Sku"])))[0]
        plants[item] = dict(tier=tier, price=cfg["plant_prices"][tier], template=template)
    return plants


def donotown_segments(data):
    seg = {}
    for o in data["PLAYERSEGMENTS"]["objects"]:
        alias = (o.get("aliases") or [""])[0]
        rules = o["objdata"].get("Rules", [])
        if alias.startswith("DoNotOwn_") and "Battlez" not in alias and len(rules) == 1 \
                and rules[0].get("Comparator") == "==" and rules[0].get("Value") == "0":
            seg.setdefault(rules[0]["Key"].lower(), alias)
            seg.setdefault(alias[len("DoNotOwn_"):].lower(), alias)
    return seg


def make_product(template, sku, title_key, coins):
    p = copy.deepcopy(template)
    for k in ("IOS_Nimble", "NA_Nimble", "ROW_Nimble", "BundleProps"):
        p.pop(k, None)
    p.update(Sku=sku, Name="Night Carnival - " + sku, LawnShortDescription=title_key,
             Bucket="Plant Unlock", ObjectType="plant", ObjectCount=1, IsFree=False,
             IsAdPlacement=False, Price=0.0, PriceCoins=coins, PriceGems=0, PriceMints=0,
             PriceLTECurrency=0)
    return {"aliases": [sku], "objclass": "StoreProductProps", "objdata": p}


def scheduled(sku, category, cost, segment, visuals, comment):
    return {"Comment": comment, "Category": category, "Priority": "", "ABTest": "",
            "PromotionGroup": "", "AdditionalSegment": segment or "", "SmartKey": "",
            "SoftCurrency": "coins", "SoftCost": cost, "MaxPurchase": 1,
            "SoftCostPerPurchase": -1, "Visuals": visuals, "Sku": [sku], "ProductRedDot": False}


def entry(name, products, repeat, pulls, seed):
    return {"EndDateTime": END_OF_TIME, "RandomFallbackPicking": True, "RandomPersist": True,
            "RandomPersistVersion": 1, "Name": name, "RandomPulls": pulls, "RandomSeed": seed,
            "RepeatStyle": repeat, "ScheduledProducts": products, "StartDateTime": 1577836800,
            "PurchaseLimitResetStyle": "none"}


def convert_real_money(sched, snapshot, by_sku, rm):
    """Re-price every real-money offer in one schedule using pre-mod product prices."""
    converted = 0
    for e in sched:
        for sp in e["ScheduledProducts"]:
            if sp.get("SoftCurrency") != "none":
                continue
            skus = [s for s in (sp["Sku"] if isinstance(sp["Sku"], list) else [sp["Sku"]]) if s in snapshot]
            if not skus or not any(snapshot[s]["Price"] > 0 for s in skus):
                continue
            p0 = snapshot[skus[0]]
            if p0["ObjectType"] == "gem":
                cur, cost = "coins", round_price(p0["ObjectCount"] * rm["gem_pack_coins_per_gem"], 100)
            elif p0["ObjectType"] == "coin":
                cur, cost = "gems", max(1, p0["ObjectCount"] // rm["coin_pack_coins_per_gem"])
            else:
                cur, cost = "gems", max(5, int(round(max(snapshot[s]["Price"] for s in skus) * rm["usd_to_gems"])))
            sp["SoftCurrency"], sp["SoftCost"] = cur, cost
            for s in skus:
                p = by_sku[s]
                p["Price"] = 0.0
                p["PriceGems"] = cost if cur == "gems" else 0
                p["PriceCoins"] = cost if cur == "coins" else 0
            converted += 1
    return converted


def patch_store(data, cfg, strings):
    prod_objs = data["PRODUCTS"]["objects"]
    products = [o["objdata"] for o in prod_objs]
    by_sku = {p["Sku"]: p for p in products}
    snapshot = copy.deepcopy(by_sku)
    segs = donotown_segments(data)
    plants = premium_plants(products, cfg)
    log("premium plants:", len(plants), {t: sum(1 for p in plants.values() if p["tier"] == t)
                                         for t in cfg["plant_prices"]})
    new_entries = []

    # Plants tab: every premium plant, full price, coins.
    full = []
    for item, info in sorted(plants.items(), key=lambda kv: (kv[1]["price"], kv[0])):
        sku = "nc.plant.%s.full" % item
        name_key = info["template"]["LawnShortDescription"]
        prod_objs.append(make_product(info["template"], sku, name_key, info["price"]))
        full.append(scheduled(sku, "Plants", info["price"], segs.get(item.lower()), [], item))
    new_entries.append(entry("Mod - Plants for coins", full, "none", 0, 1))
    log("plants tab offers:", len(full))

    # Night Carnival: random discounted plants, rotating.
    car = cfg["carnival"]
    for n, slot in enumerate(car["slots"]):
        pool = []
        for item, info in sorted(plants.items()):
            if info["tier"] not in slot["tiers"]:
                continue
            for pct in slot["discounts"]:
                cost = round_price(info["price"] * (100 - pct) / 100)
                sku = "nc.carnival.%s.%s.d%d" % (slot["id"].lower(), item, pct)
                key = "NC_TITLE_%s_D%d" % (item.upper(), pct)
                name_key = info["template"]["LawnShortDescription"]
                strings.add(key, lambda lang, nk=name_key, pct=pct, old=info["price"]:
                            car["title_format"].format(name=strings.get(nk, lang), pct=pct, old=fmt_num(old)))
                prod_objs.append(make_product(info["template"], sku, key, cost))
                pool.append(scheduled(sku, "NightCarnival", cost, segs.get(item.lower()),
                                      ["sale", "timeremaining", "shine"], "%s -%d%%" % (item, pct)))
        new_entries.append(entry("Mod - Night Carnival " + slot["id"], pool, car["repeat"], 1, 7340033 + n * 104729))
        log("carnival slot %s: %d offers in pool" % (slot["id"], len(pool)))

    # Apply to the main schedule and its A/B test variants alike.
    for name in SCHEDULES:
        sched = data[name]["objects"][0]["objdata"]["MarketScheduleEntries"]
        n = convert_real_money(sched, snapshot, by_sku, cfg["real_money"])
        for e in sched:
            if e["Name"].startswith("Evergreen - Plants"):
                e["EndDateTime"] = e["StartDateTime"] + 1  # retire: replaced by the coin shop
        sched.extend(copy.deepcopy(new_entries))
        log("%s: %d real-money offers re-priced" % (name, n))


def patch_layout(data, cfg, strings):
    car = cfg["carnival"]
    strings.add("STORE_TAB_NIGHT_CARNIVAL", car["tab_name"])
    for name in LAYOUTS:
        lay = data[name]["objects"][0]["objdata"]
        lay["Clusters"].insert(0, {"Type": "NightCarnival", "Tabs": ["Night Carnival"]})
        lay["Tabs"].insert(0, {"Type": "Night Carnival", "Name": "[STORE_TAB_NIGHT_CARNIVAL]",
                               "ImageDown": "IMAGE_UI_STORE_SPROUTSTAB_DOWN",
                               "ImageActive": "IMAGE_UI_STORE_PINATASTAB_ACTIVE",
                               "TabRedDotOn": True, "Categories": ["NightCarnival"]})
        lay["Categories"].insert(0, {"Type": "NightCarnival", "LabelText": car["label"], "MaxCount": -1,
                                     "Card": "IMAGE_UI_CARDS_STORE_STORE_CARD_PURPLE", "ShowTimer": True})
        for c in lay["Categories"]:
            if c["Type"] == "Plants":
                c["MaxCount"] = -1
        for m in lay["Markets"]:
            if m["Type"] == "Main":
                m["Clusters"].insert(0, "NightCarnival")
        lay["GlobalConfig"]["DefaultTabType"] = "Night Carnival"


# ---------------------------------------------------------------------------

def build(src_ipa, dst_ipa, cfg):
    work = tempfile.mkdtemp(prefix="pvz2mod-")
    try:
        with zipfile.ZipFile(src_ipa) as z:
            z.extractall(work)
        apps = [d for d in os.listdir(os.path.join(work, "Payload")) if d.endswith(".app")]
        app = os.path.join(work, "Payload", apps[0])

        strip_injected(app)
        set_identity(app, cfg["app_display_name"], cfg.get("bundle_id"))

        rsb_path = os.path.join(app, "main.rsb")
        rsb = RSB(rsb_path)
        rsg = rsb.rsg(PACKAGE)
        data = Data(rsg)
        strings = Strings(data)

        patch_coins(data, cfg)
        patch_store(data, cfg, strings)
        patch_layout(data, cfg, strings)

        blob, info = rsg.build(data.encoded())
        rsb.replace_packet(PACKAGE, blob, info)
        problems = rsb.verify()
        if problems:
            raise SystemExit("main.rsb failed integrity check:\n  " + "\n  ".join(problems))
        rsb.save(rsb_path)
        # Re-read what was written and make sure every file still decodes.
        check = RSB(rsb_path)
        for path, raw in check.rsg(PACKAGE).files():
            if path.upper().endswith(".RTON"):
                rton.decode(raw)
        log("main.rsb integrity check passed")
        log("main.rsb rebuilt (%d bytes)" % os.path.getsize(rsb_path))

        if os.path.exists(dst_ipa):
            os.remove(dst_ipa)
        with zipfile.ZipFile(dst_ipa, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for root, dirs, files in os.walk(os.path.join(work, "Payload")):
                dirs.sort()
                for f in sorted(files):
                    full = os.path.join(root, f)
                    z.write(full, os.path.relpath(full, work))
        log("wrote", dst_ipa, "(%d bytes)" % os.path.getsize(dst_ipa))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "..", "mod", "config.json"))
    a = ap.parse_args()
    build(a.input, a.output, json.load(open(a.config)))


if __name__ == "__main__":
    main()
