import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Login from "./Login";
import { clearToken, getToken } from "../auth/token";

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
    clearToken();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to the dashboard immediately if already authenticated", () => {
    localStorage.setItem("house-maintenance:token", "existing-token");
    renderLogin();
    expect(screen.getByText("Dashboard placeholder")).toBeInTheDocument();
  });

  it("stores the token and navigates to the dashboard on a successful login", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "abc.def.ghi", user: { id: "00000000-0000-0000-0000-0000000000aa", username: "alice" } }),
        { status: 200 }
      )
    );
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Dashboard placeholder")).toBeInTheDocument());
    expect(getToken()).toBe("abc.def.ghi");

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
    expect(getToken()).toBeNull();
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
