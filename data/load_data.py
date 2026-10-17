"""
Build the ChooseNorth database from all data sources in one step.

Sources (put them in a "data" folder next to this script):
    data/trycanadian.json          main source: brands, ownership tags, sources
    data/canadian_alternatives.csv team list: extra swaps, merged into the above
    data/ownership_overrides.csv   your team's own verified ownership facts

Tables created (all rebuilt from the files on every run):
    categories            13 top-level categories
    brands                Canadian brands (TryCanadian + team-list additions)
    us_brands             US / foreign brands people search for
    matches               US brand -> Canadian brand recommendations
    ownership_overrides   team-verified owners; these win over everything else
    swaps (view)          one row per match with an ownership_status of
                          canadian_owned | foreign_owned | unconfirmed

Setup (once):
    pip install "psycopg[binary]" python-dotenv

Run from the folder with your .env file:
    python load_data.py

Re-run any time a data file changes. The files are the source of truth, so
edit them (not the database) and reload.
"""

import csv
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

HERE = Path(__file__).resolve().parent
DATA = HERE if (HERE / "trycanadian.json").exists() else HERE / "data"

for folder in (HERE, HERE.parent, Path(".")):
    for name in folder.glob("*.env"):
        load_dotenv(name)
load_dotenv()
URL = (os.getenv("DATABASE_URL") or os.getenv("TIMESCALE_SERVICE_URL")
       or os.getenv("SERVICE_URL") or "")

CATEGORY_MAP = {
    "clothing": "Clothing", "jewelry": "Clothing",
    "household": "Household",
    "personal care": "Personal Care", "baby food": "Groceries",
    "restaurant": "Food & Drink",
}
DEFAULT_CATEGORY = "Groceries"

EXACT_ONLY = {"maple", "apple"}

SCHEMA = """
DROP VIEW  IF EXISTS swaps;
DROP TABLE IF EXISTS ownership_overrides, matches, us_brands, brands, categories CASCADE;

CREATE TABLE categories (
  slug text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE brands (
  slug          text PRIMARY KEY,
  name          text NOT NULL,
  source        text NOT NULL,          -- trycanadian | team_list
  category      text,
  subcategory   text,
  city          text,
  region        text,                   -- province code
  website       text,
  logo_url      text,
  description   text,
  status_tags   text[] NOT NULL DEFAULT '{}',
  status_notes  text[] NOT NULL DEFAULT '{}',
  verification  text NOT NULL DEFAULT 'Unverified',
  sources       jsonb NOT NULL DEFAULT '[]',
  profile_url   text
);

CREATE TABLE us_brands (
  slug         text PRIMARY KEY,
  name         text NOT NULL,
  source       text NOT NULL,
  category     text,
  subcategory  text,
  profile_url  text
);

CREATE TABLE matches (
  id                    bigserial PRIMARY KEY,
  us_slug               text NOT NULL REFERENCES us_brands(slug) ON DELETE CASCADE,
  brand_slug            text NOT NULL REFERENCES brands(slug) ON DELETE CASCADE,
  source                text NOT NULL,
  us_product_name       text NOT NULL DEFAULT '',   -- team list is product-level
  canadian_product_name text NOT NULL DEFAULT '',
  coverage              text,                       -- Broad | Partial | Niche coverage
  match_verified        boolean NOT NULL DEFAULT false,
  match_partial         boolean NOT NULL DEFAULT false,
  notes                 text[] NOT NULL DEFAULT '{}',
  UNIQUE (us_slug, brand_slug, us_product_name, canadian_product_name)
);

CREATE TABLE ownership_overrides (
  brand_slug     text PRIMARY KEY REFERENCES brands(slug) ON DELETE CASCADE,
  owner_name     text NOT NULL,
  owner_country  text NOT NULL,          -- ISO code: CA, US, JP, ...
  note           text,
  source_url     text,
  team_confirmed boolean NOT NULL DEFAULT false
);

CREATE INDEX brands_name_idx    ON brands (lower(name));
CREATE INDEX brands_cat_idx     ON brands (category);
CREATE INDEX us_brands_name_idx ON us_brands (lower(name));
CREATE INDEX matches_brand_idx  ON matches (brand_slug);

CREATE VIEW swaps AS
SELECT
  u.name                 AS us_brand,
  u.slug                 AS us_slug,
  m.us_product_name,
  b.name                 AS canadian_brand,
  b.slug                 AS canadian_slug,
  m.canadian_product_name,
  b.category, b.subcategory,
  b.city, b.region, b.website,
  CASE
    WHEN o.owner_country = 'CA'                 THEN 'canadian_owned'
    WHEN o.owner_country IS NOT NULL            THEN 'foreign_owned'
    WHEN 'Canadian-owned' = ANY (b.status_tags) THEN 'canadian_owned'
    ELSE 'unconfirmed'
  END                    AS ownership_status,
  o.owner_name, o.owner_country, o.note AS owner_note,
  o.team_confirmed,
  'Made in Canada' = ANY (b.status_tags) AS made_in_canada,
  b.status_tags, b.status_notes,
  b.verification,
  m.coverage, m.match_verified,
  b.sources,
  COALESCE(o.source_url, b.profile_url) AS source_url,
  m.source               AS match_source
FROM matches m
JOIN us_brands u ON u.slug = m.us_slug
JOIN brands b    ON b.slug = m.brand_slug
LEFT JOIN ownership_overrides o ON o.brand_slug = b.slug;
"""

FUZZY = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX brands_name_trgm    ON brands    USING gin (lower(name) gin_trgm_ops);
CREATE INDEX us_brands_name_trgm ON us_brands USING gin (lower(name) gin_trgm_ops);
"""

# helpers

def norm(s):
    """Lowercase, straighten quotes, strip accents/punctuation for matching."""
    s = (s or "").replace("’", "'").replace("‘", "'")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9' &+]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", norm(s)).strip("-")


def strip_note(name):
    """'Silk Almond Milk (Canadian-made)' -> ('Silk Almond Milk', 'Canadian-made')"""
    m = re.match(r"^(.*?)\s*\(([^)]*)\)$", name.strip())
    return (m.group(1).strip(), m.group(2).strip()) if m else (name.strip(), "")


class NameIndex:
    """Find the known brand whose name starts a product name, longest first.
    'Marcelle Hydra-C Gel Cream' -> brand 'Marcelle'."""

    def __init__(self, names_to_slug):
        self.items = sorted(((norm(n), s) for n, s in names_to_slug.items() if len(norm(n)) >= 3),
                            key=lambda x: -len(x[0]))

    def find(self, product):
        p = norm(product)
        for n, slug in self.items:
            if p == n or (n not in EXACT_ONLY and p.startswith(n + " ")):
                return slug
        return None


# build

def build():
    tc = json.load(open(DATA / "trycanadian.json", encoding="utf-8"))

    categories = {c["slug"]: c["name"] for c in tc["categories"]}
    brands, us_brands, matches = {}, {}, {}

    # 1. TryCanadian: the main source
    for b in tc["brands"]:
        brands[b["slug"]] = dict(
            slug=b["slug"], name=b["name"], source="trycanadian",
            category=b.get("category"), subcategory=None,
            city=b.get("city"), region=b.get("region"), website=b.get("website"),
            logo_url=b.get("logo_url"), description=b.get("description"),
            status_tags=b.get("status_tags") or [], status_notes=b.get("status_notes") or [],
            verification=b.get("verification") or "Unverified",
            sources=b.get("sources") or [], profile_url=b.get("url"))
    for a in tc["alternatives"]:
        us_brands[a["slug"]] = dict(
            slug=a["slug"], name=a["us_brand_name"], source="trycanadian",
            category=a.get("category"), subcategory=None, profile_url=a.get("url"))
    for l in tc["alternative_brands"]:
        key = (l["alternative_slug"], l["brand_slug"], "", "")
        matches[key] = dict(
            us_slug=l["alternative_slug"], brand_slug=l["brand_slug"], source="trycanadian",
            us_product_name="", canadian_product_name="",
            coverage=l.get("coverage"), match_verified=bool(l.get("match_verified")),
            match_partial=bool(l.get("match_partial")), notes=l.get("notes") or [])

    # 2. Team list: merge into TryCanadian brands where names match
    brand_idx = NameIndex({b["name"]: s for s, b in brands.items()})
    us_idx = NameIndex({u["name"]: s for s, u in us_brands.items()})
    stats = dict(rows=0, ca_merged=0, ca_new=0, us_merged=0, us_new=0, matches_new=0)

    with open(DATA / "canadian_alternatives.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            us_name, ca_full = r["us_product"].strip(), r["canadian_alternative"].strip()
            if not us_name or not ca_full:
                continue
            stats["rows"] += 1
            sub = r["category"].strip()
            cat = CATEGORY_MAP.get(sub.lower(), DEFAULT_CATEGORY)
            ca_name, ca_note = strip_note(ca_full)

            us_slug = us_idx.find(us_name)
            if us_slug:
                stats["us_merged"] += 1
            else:
                us_slug = "team-" + slugify(us_name)
                if us_slug not in us_brands:
                    us_brands[us_slug] = dict(slug=us_slug, name=us_name, source="team_list",
                                              category=cat, subcategory=sub, profile_url=None)
                    us_idx = None
                stats["us_new"] += 1

            ca_slug = brand_idx.find(ca_name)
            if ca_slug:
                stats["ca_merged"] += 1
            else:
                ca_slug = "team-" + slugify(ca_name)
                if ca_slug not in brands:
                    brands[ca_slug] = dict(
                        slug=ca_slug, name=ca_name, source="team_list", category=cat,
                        subcategory=sub, city=None, region=None, website=None, logo_url=None,
                        description=ca_note or None, status_tags=[], status_notes=[],
                        verification="Unverified", sources=[], profile_url=None)
                stats["ca_new"] += 1

            key = (us_slug, ca_slug, us_name, ca_full)
            if key not in matches:
                matches[key] = dict(
                    us_slug=us_slug, brand_slug=ca_slug, source="team_list",
                    us_product_name=us_name, canadian_product_name=ca_full,
                    coverage=None, match_verified=False, match_partial=False,
                    notes=[ca_note] if ca_note else [])
                stats["matches_new"] += 1
            if us_idx is None:
                us_idx = NameIndex({u["name"]: s for s, u in us_brands.items()})

    # 3. Team-verified ownership (wins over everything)
    overrides = []
    path = DATA / "ownership_overrides.csv"
    if path.exists():
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                slug = (r.get("brand_slug") or "").strip()
                if not slug:
                    continue
                if slug not in brands:
                    print(f"  ! ownership_overrides.csv: unknown brand_slug '{slug}', skipped")
                    continue
                overrides.append(dict(
                    brand_slug=slug, owner_name=r["owner_name"].strip(),
                    owner_country=r["owner_country"].strip().upper(),
                    note=(r.get("note") or "").strip() or None,
                    source_url=(r.get("source_url") or "").strip() or None,
                    team_confirmed=(r.get("team_confirmed") or "").strip().lower() in ("true", "yes", "1")))

    return categories, brands, us_brands, list(matches.values()), overrides, stats


def insert(cur, table, rows):
    if not rows:
        return
    cols = list(rows[0].keys())
    cur.executemany(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        [[Jsonb(r[c]) if c == "sources" else r[c] for c in cols] for r in rows])


def main():
    for f in ("trycanadian.json", "canadian_alternatives.csv"):
        if not (DATA / f).exists():
            sys.exit(f"Missing data/{f}. Put the data files in a 'data' folder next to this script.")

    categories, brands, us_brands, matches, overrides, stats = build()

    with psycopg.connect(URL, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
            insert(cur, "categories", [dict(slug=s, name=n) for s, n in categories.items()])
            insert(cur, "brands", list(brands.values()))
            insert(cur, "us_brands", list(us_brands.values()))
            insert(cur, "matches", matches)
            insert(cur, "ownership_overrides", overrides)
            try:
                with conn.transaction():
                    cur.execute(FUZZY)
                fuzzy = "on"
            except psycopg.Error:
                fuzzy = "off (exact matching only)"
            status = dict(cur.execute(
                "SELECT ownership_status, count(DISTINCT canadian_slug) FROM swaps GROUP BY 1").fetchall())
        conn.commit()

    print(f"Brands:    {len(brands)}  (TryCanadian {sum(b['source']=='trycanadian' for b in brands.values())}, "
          f"team list {sum(b['source']=='team_list' for b in brands.values())})")
    print(f"US brands: {len(us_brands)}")
    print(f"Matches:   {len(matches)}")
    print(f"Team list: {stats['rows']} rows; {stats['ca_merged']} Canadian alternatives and "
          f"{stats['us_merged']} US products matched existing TryCanadian brands")
    print(f"Ownership overrides: {len(overrides)}")
    print(f"Brands by status: {status}")
    print(f"Fuzzy matching: {fuzzy}")


if __name__ == "__main__":
    main()
