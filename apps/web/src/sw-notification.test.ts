import { describe, expect, it } from "vitest";
import {
  FALLBACK_NOTIFICATION,
  buildNotificationOptions,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-notification";

describe("parsePushPayload", () => {
  it("reads a full payload as sent by api/cron.ts", () => {
    const raw = JSON.stringify({
      title: "Meter reading due",
      body: "Kitchen water hasn't been read since 2026-07-30.",
      url: "/meters",
      tag: "reading-due",
    });
    expect(parsePushPayload(raw)).toEqual({
      title: "Meter reading due",
      body: "Kitchen water hasn't been read since 2026-07-30.",
      url: "/meters",
      tag: "reading-due",
    });
  });

  it("leaves url and tag undefined when the payload omits them", () => {
    const raw = JSON.stringify({ title: "Backup complete", body: "Weekly backup finished." });
    expect(parsePushPayload(raw)).toEqual({
      title: "Backup complete",
      body: "Weekly backup finished.",
      url: undefined,
      tag: undefined,
    });
  });

  it("ignores non-string url and tag values rather than passing them through", () => {
    const raw = JSON.stringify({ title: "T", body: "B", url: 42, tag: { a: 1 } });
    expect(parsePushPayload(raw)).toEqual({ title: "T", body: "B", url: undefined, tag: undefined });
  });

  it.each([
    ["no data at all", undefined],
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON scalar", "42"],
    ["null", "null"],
    ["a payload with no title", JSON.stringify({ body: "B" })],
    ["a payload with no body", JSON.stringify({ title: "T" })],
    ["an empty title", JSON.stringify({ title: "", body: "B" })],
  ])("falls back for %s", (_label, raw) => {
    expect(parsePushPayload(raw)).toEqual(FALLBACK_NOTIFICATION);
  });
});

describe("buildNotificationOptions", () => {
  it("sets renotify alongside a tag, so a replacement still alerts", () => {
    const options = buildNotificationOptions({ title: "T", body: "B", tag: "reading-due" });
    expect(options.tag).toBe("reading-due");
    expect(options.renotify).toBe(true);
  });

  it("omits renotify without a tag — Chrome throws on that combination", () => {
    const options = buildNotificationOptions({ title: "T", body: "B" });
    expect(options.tag).toBeUndefined();
    expect("renotify" in options).toBe(false);
  });

  it("carries the url through as notification data, defaulting to the app root", () => {
    expect(buildNotificationOptions({ title: "T", body: "B", url: "/tasks" }).data).toEqual({
      url: "/tasks",
    });
    expect(buildNotificationOptions({ title: "T", body: "B" }).data).toEqual({ url: "/" });
  });
});

describe("resolveNotificationUrl", () => {
  it("returns a same-origin path unchanged", () => {
    expect(resolveNotificationUrl({ url: "/meters" })).toBe("/meters");
  });

  it.each([
    ["an absolute url", { url: "https://evil.example/steal" }],
    ["a protocol-relative url", { url: "//evil.example/steal" }],
    ["a relative path", { url: "meters" }],
    ["a non-string url", { url: 7 }],
    ["missing data", undefined],
    ["null data", null],
    ["data without a url", {}],
  ])("falls back to the app root for %s", (_label, data) => {
    expect(resolveNotificationUrl(data)).toBe("/");
  });
});
