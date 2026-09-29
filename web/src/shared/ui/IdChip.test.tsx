import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdChip } from "./IdChip";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IdChip", () => {
  it("copies the full identifier and announces the result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<IdChip value="handoff-123456789" label="交接记录" />);

    await userEvent.click(screen.getByRole("button", { name: /复制交接记录/ }));

    expect(writeText).toHaveBeenCalledWith("handoff-123456789");
    expect(screen.getByRole("status")).toHaveTextContent("已复制完整标识");
  });

  it("announces when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue("denied") } });
    render(<IdChip value="handoff-123456789" />);

    await userEvent.click(screen.getByRole("button", { name: /复制标识/ }));

    expect(screen.getByRole("status")).toHaveTextContent("复制失败");
  });
});
