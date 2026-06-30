import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

type Width = "narrow" | "default" | "wide" | "full";
const widths: Record<Width, string> = {
  narrow: "max-w-3xl",
  default: "max-w-6xl",
  wide: "max-w-7xl",
  full: "max-w-none",
};

export function FluidContainer({ children, className, width = "default", ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement> & { width?: Width }>) {
  return <div className={cn("mx-auto w-full min-w-0 px-[clamp(1rem,3vw,2rem)]", widths[width], className)} {...props}>{children}</div>;
}
