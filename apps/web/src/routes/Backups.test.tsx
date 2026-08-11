import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackupRecord } from "@house/shared";

const runBackup = vi.fn();
const listBackups = vi.fn();
const shareOrDownloadBackup = vi.fn();
const uploadRestoreArchive = vi.fn();
const restoreFromBlobUrl = vi.fn();
const restoreFromBackupId = vi.fn();
const exportReadingsCsv = vi.fn();
const exportTasksCsv = vi.fn();

vi.mock("../data/backup", () => ({
  runBackup: (...args: unknown[]) => runBackup(...args),
  listBackups: (...args: unknown[]) => listBackups(...args),
  shareOrDownloadBackup: (...args: unknown[]) => shareOrDownloadBackup(...args),
  uploadRestoreArchive: (...args: unknown[]) => uploadRestoreArchive(...args),
  restoreFromBlobUrl: (...args: unknown[]) => restoreFromBlobUrl(...args),
  restoreFromBackupId: (...args: unknown[]) => restoreFromBackupId(...args),
}));

vi.mock("../data/export", () => ({
  exportReadingsCsv: (...args: unknown[]) => exportReadingsCsv(...args),
  exportTasksCsv: (...args: unknown[]) => exportTasksCsv(...args),
}));

const Backups = (await import("./Backups")).default;

/** The "Manual · <date>" line is split across sibling text nodes by JSX interpolation — match on combined textContent instead. */
function findByTextContent(pattern: RegExp) {
  return screen.findByText(
    (_, element) =>
      Boolean(element) && element!.children.length === 0 && pattern.test(element!.textContent ?? "")
  );
}

function completeBackup(overrides: Partial<BackupRecord> = {}): BackupRecord {
  return {
    id: "backup-1",
    kind: "manual",
    status: "complete",
    sizeBytes: 1024 * 512,
    tableCounts: { meters: 3 },
    photoCount: 2,
    error: null,
    createdAt: "2024-06-01T12:00:00.000Z",
    completedAt: "2024-06-01T12:00:05.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listBackups.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Backups", () => {
  it("shows an empty state with no backups yet", async () => {
    render(<Backups />);
    expect(await screen.findByText("No backups yet — run one above.")).toBeInTheDocument();
  });

  it("lists a completed backup with its size and photo count", async () => {
    listBackups.mockResolvedValue([completeBackup()]);
    render(<Backups />);

    // The date itself is `toLocaleString(undefined, ...)` — deliberately
    // locale-dependent on the real device, so intentionally not asserted
    // exactly here (CI's ICU locale formats it differently than local
    // dev: "Jun 1, 2024, 12:00 PM" vs "1 Jun 2024, 14:00"). Just confirm
    // the row combines the backup's kind with *some* rendered date.
    expect(await findByTextContent(/^Manual · .*2024/)).toBeInTheDocument();
    expect(screen.getByText(/complete · 512.0 KB · 2 photos/)).toBeInTheDocument();
  });

  it("shows the list error instead of the backup rows when loading fails", async () => {
    listBackups.mockRejectedValue(new Error("Failed to load backups (500)."));
    render(<Backups />);

    expect(await screen.findByText("Failed to load backups (500).")).toBeInTheDocument();
  });

  it("runs a manual backup and refreshes the list", async () => {
    const user = userEvent.setup();
    listBackups.mockResolvedValueOnce([]).mockResolvedValueOnce([completeBackup()]);
    runBackup.mockResolvedValue(completeBackup());
    render(<Backups />);

    await screen.findByText("No backups yet — run one above.");
    await user.click(screen.getByRole("button", { name: "Back up now" }));

    await waitFor(() => expect(runBackup).toHaveBeenCalledTimes(1));
    // The date itself is `toLocaleString(undefined, ...)` — deliberately
    // locale-dependent on the real device, so intentionally not asserted
    // exactly here (CI's ICU locale formats it differently than local
    // dev: "Jun 1, 2024, 12:00 PM" vs "1 Jun 2024, 14:00"). Just confirm
    // the row combines the backup's kind with *some* rendered date.
    expect(await findByTextContent(/^Manual · .*2024/)).toBeInTheDocument();
    expect(listBackups).toHaveBeenCalledTimes(2);
  });

  it("shows the run error and keeps the previous list when a manual backup fails", async () => {
    const user = userEvent.setup();
    listBackups.mockResolvedValue([]);
    runBackup.mockRejectedValue(new Error("Backup failed (500)."));
    render(<Backups />);

    await screen.findByText("No backups yet — run one above.");
    await user.click(screen.getByRole("button", { name: "Back up now" }));

    expect(await screen.findByText("Backup failed (500).")).toBeInTheDocument();
  });

  it("shares a backup and shows the outcome", async () => {
    const user = userEvent.setup();
    listBackups.mockResolvedValue([completeBackup()]);
    shareOrDownloadBackup.mockResolvedValue("shared");
    render(<Backups />);

    await user.click(await screen.findByRole("button", { name: "Save a copy" }));

    expect(await screen.findByText("Shared.")).toBeInTheDocument();
    expect(shareOrDownloadBackup).toHaveBeenCalledWith(expect.objectContaining({ id: "backup-1" }));
  });

  it("restores a backup after confirmation and reports the summary", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listBackups.mockResolvedValue([completeBackup()]);
    restoreFromBackupId.mockResolvedValue({
      ok: true,
      tableCounts: { meters: 3, readings: 10 },
      photosRestored: 2,
      usersCreatedWithDisabledPassword: [],
    });
    render(<Backups />);

    await user.click(await screen.findByRole("button", { name: "Restore this backup" }));

    expect(await screen.findByText("Restored 13 rows, 2 photos.")).toBeInTheDocument();
    expect(restoreFromBackupId).toHaveBeenCalledWith("backup-1");
  });

  it("does not restore when the confirmation dialog is dismissed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    listBackups.mockResolvedValue([completeBackup()]);
    render(<Backups />);

    await user.click(await screen.findByRole("button", { name: "Restore this backup" }));

    expect(restoreFromBackupId).not.toHaveBeenCalled();
  });

  it("flags newly created logins that still need a password after a restore", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listBackups.mockResolvedValue([completeBackup()]);
    restoreFromBackupId.mockResolvedValue({
      ok: true,
      tableCounts: { meters: 1 },
      photosRestored: 0,
      usersCreatedWithDisabledPassword: ["bob"],
    });
    render(<Backups />);

    await user.click(await screen.findByRole("button", { name: "Restore this backup" }));

    expect(await screen.findByText(/run db:seed-user for bob/)).toBeInTheDocument();
  });
});

describe("Export data", () => {
  it("exports readings without touching the tasks export", async () => {
    const user = userEvent.setup();
    exportReadingsCsv.mockResolvedValue(undefined);
    render(<Backups />);

    await user.click(screen.getByRole("button", { name: "Export readings (CSV)" }));

    await waitFor(() => expect(exportReadingsCsv).toHaveBeenCalledTimes(1));
    expect(exportTasksCsv).not.toHaveBeenCalled();
  });

  it("exports tasks without touching the readings export", async () => {
    const user = userEvent.setup();
    exportTasksCsv.mockResolvedValue(undefined);
    render(<Backups />);

    await user.click(screen.getByRole("button", { name: "Export tasks (CSV)" }));

    await waitFor(() => expect(exportTasksCsv).toHaveBeenCalledTimes(1));
    expect(exportReadingsCsv).not.toHaveBeenCalled();
  });

  it("shows an error and re-enables the buttons when an export fails", async () => {
    const user = userEvent.setup();
    exportReadingsCsv.mockRejectedValue(new Error("Export failed."));
    render(<Backups />);

    await user.click(screen.getByRole("button", { name: "Export readings (CSV)" }));

    expect(await screen.findByText("Export failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export tasks (CSV)" })).toBeEnabled();
  });
});
