/** Structured logs for the Lambda JSON log format (spec §10 "Logs"). */
import { afterEach, describe, expect, test, vi } from "vitest";
import { log } from "../src/log";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  test("passes an object (not a JSON string) to the console method for the level", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    log("INFO", "Linked", { provider: "Google" });
    log("ERROR", "Linking failed");

    expect(info).toHaveBeenCalledWith({ message: "Linked", provider: "Google" });
    expect(error).toHaveBeenCalledWith({ message: "Linking failed" });
  });
});
