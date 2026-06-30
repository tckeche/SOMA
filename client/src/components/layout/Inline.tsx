import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function Inline({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <div className={cn("flex min-w-0 flex-wrap items-center gap-3", className)} {...props}>{children}</div>;
}
