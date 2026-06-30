import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
export function Stack({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <div className={cn("flex min-w-0 flex-col gap-[clamp(1rem,2vw,1.5rem)]", className)} {...props}>{children}</div>;
}
