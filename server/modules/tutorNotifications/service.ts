import { storage } from "../../storage";
export async function list(tutorId: string) { const rows = await storage.listTutorNotifications(tutorId); return { notifications: rows, unreadCount: rows.filter((item) => !item.readAt).length }; }
export async function markRead(id: number, tutorId: string) { return storage.markTutorNotificationRead(id, tutorId); }
