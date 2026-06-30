import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function DashboardGrid({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <div className={cn("grid min-w-0 grid-cols-1 gap-[clamp(1rem,2vw,1.5rem)] lg:grid-cols-12 [&>*]:min-w-0", className)} {...props}>{children}</div>;
}
