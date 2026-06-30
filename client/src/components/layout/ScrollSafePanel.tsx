import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function ScrollSafePanel({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) { return <div className={cn("min-h-0 min-w-0 overflow-auto overscroll-contain", className)} {...props}>{children}</div>; }
