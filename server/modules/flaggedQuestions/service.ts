import { storage } from "../../storage";
export async function list(tutorId:string,query:any){const filter:{quizId?:number;studentId?:string;unresolvedOnly?:boolean}={unresolvedOnly:String(query.unresolvedOnly||"")==="true"}; if(query.quizId){const id=parseInt(String(query.quizId),10); if(Number.isInteger(id))filter.quizId=id;} if(query.studentId)filter.studentId=String(query.studentId); const flags=await storage.listFlaggedQuestionsForTutor(tutorId,filter); return {flags};}
export async function resolve(id:number,tutorId:string){return storage.resolveFlaggedQuestion(id,tutorId);}
