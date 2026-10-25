// jsdom has no layout: the router's scroll restoration calls window.scrollTo on navigation.
window.scrollTo = () => {};

// No layout either: give elements a width so the gallery grid lays out rows (1000 px, the desktop
// row height), and a ResizeObserver that never fires.
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 1000,
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix Select uses pointer capture and scrolls the selected option into view.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

// Local previews of queued uploads (8.10): jsdom has no object URLs.
URL.createObjectURL ??= () => "blob:test";
URL.revokeObjectURL ??= () => {};
