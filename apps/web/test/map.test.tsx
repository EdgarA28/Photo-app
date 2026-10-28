import type { PhotoLocation } from "@photo-app/shared";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markerElement } from "../src/map/markers";
import { mapStyleUrl } from "../src/map/style";
import { fakeApi, testId } from "./fakes";
import { defaultResponses, renderAt } from "./render";

// jsdom has no WebGL: the map itself is replaced by a list of the pins it was given.
vi.mock("../src/map/PhotoMap", () => ({
  PhotoMap: ({
    photos,
    onOpen,
  }: {
    photos: PhotoLocation[];
    onOpen: (photoId: string) => void;
  }) => (
    <ul aria-label="Fake map">
      {photos.map((p) => (
        <li key={p.photoId}>
          <button type="button" onClick={() => onOpen(p.photoId)}>
            {`${p.lat},${p.lon}`}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

afterEach(cleanup);

const pin = (n: number, lat: number, lon: number): PhotoLocation => ({
  photoId: testId(n),
  lat,
  lon,
  takenAt: `2024-0${n}-01T10:00:00.000Z`,
  thumbUrl: `/users/u/thumbs/${testId(n)}.jpg`,
});

describe("map page (13.2h)", () => {
  it("shows the photos with a location and opens the viewer from a pin", async () => {
    const { api } = fakeApi({
      ...defaultResponses,
      "GET /places/map": { items: [pin(2, 52.52, 13.41), pin(1, -33.857, -151.215)] },
    });
    const { router } = await renderAt("/map", { api });

    const map = await screen.findByRole("list", { name: "Fake map" });
    expect([...map.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "52.52,13.41",
      "-33.857,-151.215",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "52.52,13.41" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/photos/${testId(2)}`));
  });

  it("explains an empty map", async () => {
    const { api } = fakeApi({ ...defaultResponses, "GET /places/map": { items: [] } });
    await renderAt("/map", { api });
    expect(await screen.findByText("No photos with a location yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Fake map" })).toBeNull();
  });
});

describe("map pins (13.2h)", () => {
  it("shows the thumbnail, and the count for a cluster", () => {
    const onClick = vi.fn();
    const single = markerElement(pin(1, 0, 0), 1, onClick);
    expect(single.getAttribute("aria-label")).toMatch(/^Open photo from /);
    expect(single.querySelector("img")?.getAttribute("src")).toBe(pin(1, 0, 0).thumbUrl);
    expect(single.textContent).toBe("");
    single.click();
    expect(onClick).toHaveBeenCalledOnce();

    const cluster = markerElement(pin(1, 0, 0), 12, () => {});
    expect(cluster.getAttribute("aria-label")).toBe("12 photos");
    expect(cluster.textContent).toBe("12");
    expect(markerElement(pin(1, 0, 0), 1500, () => {}).textContent).toBe("1k");
  });

  it("follows the colour scheme", () => {
    expect(mapStyleUrl(false)).toBe("https://tiles.openfreemap.org/styles/positron");
    expect(mapStyleUrl(true)).toBe("https://tiles.openfreemap.org/styles/dark");
  });
});
