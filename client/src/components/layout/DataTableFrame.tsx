import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function DataTableFrame({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) { return <div className={cn("w-full min-w-0 overflow-x-auto rounded-xl border bg-card", className)} {...props}>{children}</div>; }
