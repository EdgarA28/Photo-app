"""Offline reverse geocoding (13.2b): GPS → nearest town with its region and country.

Data: `data/places.tsv.gz`, built from GeoNames (https://www.geonames.org, CC BY 4.0) by
`scripts/build_places.py`: populated places with 1,000+ inhabitants. No network calls, so
coordinates never leave the Lambda and lookups cost nothing.
"""

import gzip
import math
from collections import defaultdict
from dataclasses import dataclass
from functools import cache
from importlib import resources

# Beyond this nobody would call the nearest town "where it was taken" (sea, wilderness).
MAX_DISTANCE_KM = 50
# A town's reach grows with its size, so a spot in Manhattan is "New York City" (point at City
# Hall, 5 km away), not the small town 2 km away across the river: the winner is the town with
# the smallest distance / reach. Reach = sqrt(population / 1000) * 1.5 km, between 1.5 and 30 km.
_REACH_KM_PER_SQRT_THOUSAND = 1.5
_MIN_REACH_KM, _MAX_REACH_KM = 1.5, 30.0
_EARTH_RADIUS_KM = 6371.0


@dataclass(frozen=True)
class Place:
    city: str
    city_id: str
    """GeoNames ID of the town."""
    region: str | None
    region_id: str | None
    """`{country code}.{admin1 code}`, None when GeoNames has no named region for the town."""
    country: str
    country_code: str


@dataclass(frozen=True)
class _Town:
    lat: float
    lon: float
    geoname_id: str
    name: str
    country_code: str
    admin1: str
    reach_km: float


def _reach_km(population: int) -> float:
    reach = math.sqrt(population / 1000) * _REACH_KM_PER_SQRT_THOUSAND
    return min(_MAX_REACH_KM, max(_MIN_REACH_KM, reach))


class _Index:
    def __init__(self, text: str) -> None:
        self.countries: dict[str, str] = {}
        self.regions: dict[str, str] = {}
        self.cells: dict[tuple[int, int], list[_Town]] = defaultdict(list)
        for line in text.splitlines():
            kind, *fields = line.split("\t")
            if kind == "C":
                self.countries[fields[0]] = fields[1]
            elif kind == "R":
                self.regions[fields[0]] = fields[1]
            elif kind == "P":
                gid, lat, lon, name, cc, admin1, population = fields
                town = _Town(
                    float(lat), float(lon), gid, name, cc, admin1, _reach_km(int(population))
                )
                self.cells[_cell(town.lat, town.lon)].append(town)

    def nearest(self, lat: float, lon: float) -> tuple[_Town, float] | None:
        lat_span = math.ceil(MAX_DISTANCE_KM / 111) or 1
        # A degree of longitude shrinks towards the poles.
        lon_span = math.ceil(MAX_DISTANCE_KM / (111 * max(math.cos(math.radians(lat)), 0.01)))
        lon_span = min(lon_span, 180)
        best: tuple[_Town, float] | None = None  # (town, distance / reach)
        cell_lat, cell_lon = _cell(lat, lon)
        for dlat in range(-lat_span, lat_span + 1):
            for dlon in range(-lon_span, lon_span + 1):
                # Longitude cells wrap around at the antimeridian.
                key = (cell_lat + dlat, (cell_lon + dlon + 180) % 360 - 180)
                for town in self.cells.get(key, ()):
                    km = _distance_km(lat, lon, town.lat, town.lon)
                    if km > MAX_DISTANCE_KM:
                        continue
                    score = km / town.reach_km
                    if best is None or score < best[1]:
                        best = (town, score)
        return best


def lookup(lat: float, lon: float) -> Place | None:
    """The nearest town within MAX_DISTANCE_KM, or None."""
    index = _index()
    found = index.nearest(lat, lon)
    if found is None:
        return None
    town, _ = found
    region_id = f"{town.country_code}.{town.admin1}"
    region = index.regions.get(region_id)
    return Place(
        city=town.name,
        city_id=town.geoname_id,
        region=region,
        region_id=region_id if region else None,
        country=index.countries.get(town.country_code, town.country_code),
        country_code=town.country_code,
    )


@cache
def _index() -> _Index:
    # Loaded on the first photo with GPS (~1 s), then kept for the warm container.
    data = resources.files("thumbnails").joinpath("data/places.tsv.gz").read_bytes()
    return _Index(gzip.decompress(data).decode("utf-8"))


def _cell(lat: float, lon: float) -> tuple[int, int]:
    return math.floor(lat), math.floor(lon)


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))
