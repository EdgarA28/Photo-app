import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHideOnScroll } from "../src/gallery/useHideOnScroll";

function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  });
}

describe("useHideOnScroll", () => {
  afterEach(() => {
    scrollTo(0);
    document.body.innerHTML = "";
  });

  it("hides going down and comes back going up", () => {
    const { result } = renderHook(() => useHideOnScroll(true));
    scrollTo(600);
    expect(result.current).toBe(true);
    scrollTo(500);
    expect(result.current).toBe(false);
  });

  it("ignores small movements and always shows near the top", () => {
    const { result } = renderHook(() => useHideOnScroll(true));
    scrollTo(50);
    expect(result.current).toBe(false);
    scrollTo(600);
    scrollTo(595);
    expect(result.current).toBe(true);
    scrollTo(100);
    expect(result.current).toBe(false);
  });

  it("stays while disabled (select mode)", () => {
    const { result } = renderHook(() => useHideOnScroll(false));
    scrollTo(600);
    expect(result.current).toBe(false);
  });

  it("doesn't count the scrolling a pinch does itself", () => {
    const { result } = renderHook(() => useHideOnScroll(true));
    document.body.innerHTML = "<div data-pinching></div>";
    scrollTo(600);
    expect(result.current).toBe(false);
  });
});
