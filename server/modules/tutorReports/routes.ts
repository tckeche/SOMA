import {Router} from "express"; import {asyncHandler} from "../../lib/asyncHandler"; import {requireTutor} from "../../middleware/roles"; import * as c from "./controller";
export const router=Router(); router.get("/:quizId/reports",requireTutor,asyncHandler(c.quizReports));
