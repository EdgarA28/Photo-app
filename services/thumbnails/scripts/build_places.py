"""Builds `src/thumbnails/data/places.tsv.gz`, the offline place list for reverse geocoding (13.2b),
from three GeoNames files (https://www.geonames.org, CC BY 4.0) in one folder:

    cities1000.txt (unzipped cities1000.zip), admin1CodesASCII.txt, countryInfo.txt

    uv run python scripts/build_places.py <folder>

Output lines (tab-separated, UTF-8), sorted, so the same input gives the same file:
    C  <country code>  <country name>
    R  <country code>.<admin1 code>  <region name>
    P  <geonameid>  <lat>  <lon>  <name>  <country code>  <admin1 code>  <population>
"""

import gzip
import math
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "thumbnails" / "data" / "places.tsv.gz"
# Populated places, without sections of cities (PPLX: a district would win over the city) and
# abandoned, destroyed or historical ones.
SKIP_FEATURES = {"PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"}
# Numbered city districts listed as ordinary towns ("Paris 16 Passy", "Lyon 03", "Marseille 08"):
# dropped when a larger town of exactly that name is this close, so the city itself wins.
DISTRICT_NAME = re.compile(r"^(.+?) \d")
DISTRICT_MAX_KM = 30


def rows(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8") as f:
        return [line.rstrip("\n").split("\t") for line in f if line.strip() and line[0] != "#"]


def main() -> None:
    src = Path(sys.argv[1])
    lines = []
    for r in rows(src / "countryInfo.txt"):
        lines.append(f"C\t{r[0]}\t{r[4]}")
    for r in rows(src / "admin1CodesASCII.txt"):
        lines.append(f"R\t{r[0]}\t{r[1]}")
    towns = [r for r in rows(src / "cities1000.txt") if r[6] == "P" and r[7] not in SKIP_FEATURES]
    by_name: dict[tuple[str, str], list[list[str]]] = {}
    for r in towns:
        by_name.setdefault((r[8], r[1]), []).append(r)
    kept = districts = 0
    for r in towns:
        if is_district(r, by_name):
            districts += 1
            continue
        lat, lon = round(float(r[4]), 4), round(float(r[5]), 4)
        population = int(r[14] or 0)
        lines.append(f"P\t{r[0]}\t{lat}\t{lon}\t{r[1]}\t{r[8]}\t{r[10]}\t{population}")
        kept += 1
    print(f"dropped {districts} numbered districts")
    lines.sort()
    OUT.parent.mkdir(exist_ok=True)
    data = ("\n".join(lines) + "\n").encode("utf-8")
    # mtime=0: no timestamp in the header, so rebuilding gives the same bytes.
    with OUT.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        gz.write(data)
    print(f"{kept} places, {len(data) / 1e6:.1f} MB → {OUT.stat().st_size / 1e6:.1f} MB gz")


def is_district(r: list[str], by_name: dict[tuple[str, str], list[list[str]]]) -> bool:
    match = DISTRICT_NAME.match(r[1])
    if not match:
        return False
    for city in by_name.get((r[8], match.group(1)), []):
        bigger = int(city[14] or 0) > int(r[14] or 0)
        if bigger and km(r, city) <= DISTRICT_MAX_KM:
            return True
    return False


def km(a: list[str], b: list[str]) -> float:
    p1, p2 = math.radians(float(a[4])), math.radians(float(b[4]))
    dl = math.radians(float(b[5]) - float(a[5]))
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


if __name__ == "__main__":
    main()
