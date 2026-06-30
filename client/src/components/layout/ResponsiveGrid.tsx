import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function ResponsiveGrid({ children, className, min = "18rem", ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement> & { min?: string }>) {
  return <div className={cn("grid min-w-0 gap-[clamp(1rem,2vw,1.5rem)]", className)} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}), 1fr))`, ...props.style }} {...props}>{children}</div>;
}
