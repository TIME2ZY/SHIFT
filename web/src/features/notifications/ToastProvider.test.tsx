import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

function Trigger() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show("保存失败", { variant: "error" })}>
      显示通知
    </button>
  );
}

describe("ToastProvider", () => {
  it("shows and dismisses a notification", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "显示通知" }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("保存失败");
    await userEvent.click(alert);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
