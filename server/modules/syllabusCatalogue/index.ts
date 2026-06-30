import type { DomainModuleDefinition } from "../routerTypes";
import { authCatalogueRouter, catalogueRouter } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "syllabusCatalogue", register: (app) => { app.use("/api/catalogue", catalogueRouter); app.use("/api/auth", authCatalogueRouter); } };
