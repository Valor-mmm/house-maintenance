import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Login from "./Login";

function clearSessionMarker() {
  document.cookie = "session_present=; path=/; max-age=0";
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Dashboard placeholder</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Login", () => {
  beforeEach(() => {
    clearSessionMarker();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionMarker();
  });

  it("redirects to the dashboard immediately if already authenticated", () => {
    // Real logins get this cookie from the server's Set-Cookie response
    // header (see auth/token.ts) — jsdom's mocked fetch here doesn't go
    // through a real network stack, so this is the direct equivalent.
    document.cookie = "session_present=1; path=/";
    renderLogin();
    expect(screen.getByText("Dashboard placeholder")).toBeInTheDocument();
  });

  it("navigates to the dashboard on a successful login", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ user: { id: "00000000-0000-0000-0000-0000000000aa", username: "alice" } }),
        { status: 200 }
      )
    );
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Dashboard placeholder")).toBeInTheDocument());

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(init!.body as string)).toEqual({ username: "alice", password: "hunter2" });
  });

  it("shows the server's error message and does not navigate on a failed login", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid username or password." }), { status: 401 })
    );
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
    expect(screen.queryByText("Dashboard placeholder")).not.toBeInTheDocument();
  });

  it("shows a connectivity message when the request itself fails", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't reach the server/i);
  });
});
