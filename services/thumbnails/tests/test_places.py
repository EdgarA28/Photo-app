"""Offline reverse geocoding (13.2b): the bundled GeoNames list and the lookup rules."""

import pytest

from thumbnails import places


def test_city_region_country() -> None:
    place = places.lookup(52.5200, 13.4050)
    assert place == places.Place(
        city="Berlin",
        city_id="2950159",
        region="State of Berlin",
        region_id="DE.16",
        country="Germany",
        country_code="DE",
    )


@pytest.mark.parametrize(
    ("lat", "lon", "city"),
    [
        (48.8584, 2.2945, "Paris"),  # Eiffel tower: numbered arrondissements are dropped
        (43.2951, 5.3740, "Marseille"),
        (-33.8568, 151.2153, "Sydney"),  # a big city's reach beats a nearer small suburb
        (52.5360, 13.2000, "Berlin"),  # Spandau, 15 km from Berlin's point
        (52.3906, 13.0645, "Potsdam"),  # a city of its own next to Berlin stays itself
        (-34.6037, -58.3816, "Buenos Aires"),  # southern and western hemispheres
    ],
)
def test_known_places(lat: float, lon: float, city: str) -> None:
    place = places.lookup(lat, lon)
    assert place is not None and place.city == city


def test_nothing_far_from_any_town() -> None:
    assert places.lookup(30.0, -40.0) is None  # mid Atlantic


TOWNS = "\n".join(
    [
        "C\tAA\tAland",
        "R\tAA.01\tNorth",
        "P\t1\t-16.8\t179.95\tEastville\tAA\t01\t5000",
        "P\t2\t10.0\t10.0\tBigcity\tAA\t02\t4000000",
        "P\t3\t10.0\t10.03\tSuburb\tAA\t01\t1000",
    ]
)


def test_lookup_wraps_around_the_antimeridian() -> None:
    town, _ = places._Index(TOWNS).nearest(-16.8, -179.95) or (None, 0)
    assert town is not None and town.name == "Eastville"


def test_reach_prefers_the_big_city_unless_very_close_to_the_small_town() -> None:
    index = places._Index(TOWNS)
    # 2 km from Suburb (reach 1.5 km), 3.3 km from Bigcity (reach 30 km).
    near_both = index.nearest(10.0, 10.018)
    assert near_both is not None and near_both[0].name == "Bigcity"
    on_suburb = index.nearest(10.0, 10.0301)
    assert on_suburb is not None and on_suburb[0].name == "Suburb"


def test_region_missing_from_the_list_is_left_out() -> None:
    index = places._Index(TOWNS)
    found = index.nearest(10.0, 10.0)
    assert found is not None
    assert f"AA.{found[0].admin1}" not in index.regions  # "AA.02" has no name
