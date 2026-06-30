import type { DomainModuleDefinition } from "../routerTypes";
import { registerPdfAiMarkingRoutes } from "../../routes/pdfAiMarking";

export const moduleDefinition: DomainModuleDefinition = {
  name: "pdfAiMarking",
  register: registerPdfAiMarkingRoutes,
};
