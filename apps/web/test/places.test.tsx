import type { Place } from "@photo-app/shared";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { matchPlaces, normalizeForSearch } from "../src/gallery/placeMatch";
import { fakeApi, testId, testPhoto, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const place = (placeId: string, kind: Place["kind"], name: string, context: string, n: number) =>
  ({ placeId, kind, name, context, photoCount: n }) satisfies Place;

// Most photos first, as GET /places returns them.
const PLACES = [
  place("country:DE", "country", "Germany", "", 40),
  place("city:2950159", "city", "Berlin", "State of Berlin, Germany", 25),
  place("region:DE.02", "region", "Bavaria", "Germany", 15),
  place("city:2867714", "city", "München", "Bavaria, Germany", 12),
  place("city:2853572", "city", "Bad Berleburg", "North Rhine-Westphalia, Germany", 2),
  place("city:5128581", "city", "New York City", "New York, United States", 1),
];
const BERLIN = "city:2950159";
const berlinPath = `/places/${encodeURIComponent(BERLIN)}/photos`;

describe("matchPlaces (13.2f)", () => {
  const names = (query: string) => matchPlaces(PLACES, query).map((p) => p.name);

  it("ignores case and accents", () => {
    expect(normalizeForSearch("  MÜNCHEN ")).toBe("munchen");
    expect(names("munch")).toEqual(["München"]);
  });

  it("puts names starting with the text first, then other matches, keeping the count order", () => {
    // "Berlin" starts with it; "Bad Berleburg" has a word starting with it.
    expect(names("berl")).toEqual(["Berlin", "Bad Berleburg"]);
    // Bavaria by name; München because its context says Bavaria.
    expect(names("bavaria")).toEqual(["Bavaria", "München"]);
    expect(names("york")).toEqual(["New York City"]);
  });

  it("finds nothing for empty text or no match", () => {
    expect(names("  ")).toEqual([]);
    expect(names("tokyo")).toEqual([]);
  });

  it("returns at most 8", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      place(`city:${i + 1}`, "city", `Town ${i}`, "", 1),
    );
    expect(matchPlaces(many, "town")).toHaveLength(8);
  });
});

function setup(responses: Record<string, unknown> = {}) {
  return fakeApi({
    ...defaultResponses,
    "GET /photos": testPhotoPage(0, 3),
    "GET /places": { items: PLACES },
    [`GET ${berlinPath}`]: {
      items: [
        testPhoto(7, { place: { city: "Berlin", region: "State of Berlin", country: "Germany" } }),
      ],
      nextCursor: null,
    },
    ...responses,
  });
}

const searchBox = () => screen.getByRole("combobox", { name: "Search places" });

describe("searching the gallery by place (13.2f)", () => {
  it("suggests places as you type and shows the picked place's photos", async () => {
    const { api, request } = setup();
    const { router } = await renderAt("/gallery", { api });

    fireEvent.change(await screen.findByRole("combobox", { name: "Search places" }), {
      target: { value: "ber" },
    });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "BerlinState of Berlin, Germany25",
      "Bad BerleburgNorth Rhine-Westphalia, Germany2",
    ]);
    expect(searchBox().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(options[0]!);
    expect(await screen.findByRole("link", { name: "IMG_7.jpg" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ place: BERLIN });
    expect(screen.getByText("Berlin")).toBeTruthy();
    expect(screen.getByText(/State of Berlin, Germany/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "IMG_0.jpg" })).toBeNull();
    expect(request.mock.calls.some(([, path]) => path === berlinPath)).toBe(true);
    // The search box is cleared for the next search.
    expect((searchBox() as HTMLInputElement).value).toBe("");
  });

  it("works with the keyboard: arrows move, Enter picks, Escape closes", async () => {
    const { api } = setup();
    const { router } = await renderAt("/gallery", { api });
    const box = await screen.findByRole("combobox", { name: "Search places" });
    fireEvent.change(box, { target: { value: "ber" } });
    await screen.findAllByRole("option");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    const second = screen.getAllByRole("option")[1]!;
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(second.id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("option")).toBeNull();

    fireEvent.change(box, { target: { value: "berl" } });
    await screen.findAllByRole("option");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ place: BERLIN }));
  });

  it("says when nothing matches, and when there are no places yet", async () => {
    const { api } = setup();
    await renderAt("/gallery", { api });
    fireEvent.change(await screen.findByRole("combobox", { name: "Search places" }), {
      target: { value: "tokyo" },
    });
    expect(await screen.findByText("No places match “tokyo”.")).toBeTruthy();
    cleanup();

    await renderAt("/gallery", { api: setup({ "GET /places": { items: [] } }).api });
    fireEvent.change(await screen.findByRole("combobox", { name: "Search places" }), {
      target: { value: "ber" },
    });
    expect(await screen.findByText(/No places yet/)).toBeTruthy();
  });

  it("goes back to all photos from the place filter", async () => {
    const { api } = setup();
    const { router } = await renderAt(`/gallery?place=${BERLIN}`, { api });
    await screen.findByRole("link", { name: "IMG_7.jpg" });
    fireEvent.click(screen.getByRole("link", { name: "Show all photos" }));
    expect(await screen.findByRole("link", { name: "IMG_0.jpg" })).toBeTruthy();
    expect(router.state.location.search).not.toHaveProperty("place");
  });

  it("picking a place leaves an album filter, and the place list opens the viewer inside it", async () => {
    const album = testId(900);
    const { api } = setup({
      [`GET /albums/${album}/photos`]: { items: [], nextCursor: null },
    });
    const { router } = await renderAt(`/gallery?album=${album}`, { api });
    const box = await screen.findByRole("combobox", { name: "Search places" });
    fireEvent.change(box, { target: { value: "berlin" } });
    fireEvent.click((await screen.findAllByRole("option"))[0]!);

    const tile = await screen.findByRole("link", { name: "IMG_7.jpg" });
    expect(router.state.location.search).toEqual({ place: BERLIN, sort: "taken-desc" });
    const href = new URL(tile.getAttribute("href")!, "http://app.test");
    expect(href.pathname).toBe(`/photos/${testId(7)}`);
    expect(Object.fromEntries(href.searchParams)).toEqual({ place: BERLIN, sort: "taken-desc" });
  });
});

describe("the viewer (13.2f)", () => {
  it("shows where an own photo was taken", async () => {
    const { api } = setup();
    await renderAt(`/photos/${testId(7)}?place=${BERLIN}`, { api });
    expect(await screen.findByText("Berlin, Germany")).toBeTruthy();
  });

  it("shows nothing for a photo without a place", async () => {
    const { api } = setup();
    await renderAt(`/photos/${testId(0)}`, { api });
    await screen.findByRole("heading", { name: "IMG_0.jpg" });
    expect(screen.queryByText(/Germany/)).toBeNull();
  });
});
