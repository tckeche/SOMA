import { Router } from "express"; import { asyncHandler } from "../../lib/asyncHandler"; import { requireTutor } from "../../middleware/roles"; import * as c from "./controller";
export const router=Router();
router.post("/:quizId/assign",requireTutor,asyncHandler(c.assign));
router.delete("/:quizId/unassign/:studentId",requireTutor,asyncHandler(c.unassign));
router.delete("/:quizId/assignments/:studentId",requireTutor,asyncHandler(c.revoke));
router.patch("/:quizId/due-date",requireTutor,asyncHandler(c.updateDueDate));
router.patch("/:quizId/assignments/extend",requireTutor,asyncHandler(c.extend));
router.get("/:quizId/assignments",requireTutor,asyncHandler(c.list));
