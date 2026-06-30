import type { HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FluidContainer } from "./FluidContainer";
import { Stack } from "./Stack";
export function PageFrame({ children, className, title, description, actions, width = "wide", ...props }: PropsWithChildren<HTMLAttributes<HTMLElement> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode; width?: "narrow" | "default" | "wide" | "full" }>) {
  return <main className={cn("min-h-[100dvh] py-[clamp(1.5rem,4vw,3rem)]", className)} {...props}><FluidContainer width={width}><Stack>{(title || description || actions) && <header className="flex min-w-0 flex-wrap items-start justify-between gap-4"><div className="min-w-0 space-y-2">{title && <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>}{description && <p className="max-w-3xl text-pretty text-muted-foreground">{description}</p>}</div>{actions && <div className="shrink-0">{actions}</div>}</header>}{children}</Stack></FluidContainer></main>;
}
