import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no layout engine, so it never implements ResizeObserver — but
// recharts' <ResponsiveContainer> (used by MeterDetail's charts) requires
// one to exist just to mount, even though it'll report a 0x0 box. A no-op
// stub is enough to let those routes render in tests.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
});
