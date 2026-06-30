import { storage } from "../../storage"; export async function stats(tutorId:string){return storage.getDashboardStatsForTutor(tutorId);}
