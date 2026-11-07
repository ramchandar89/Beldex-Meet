// Scheduled meetings, persisted to a JSON file on the server.
//
// Prototype storage: fine for a single Next.js server. Swap for a database
// before running more than one instance.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type ScheduledMeeting = {
  id: string;
  room: string;
  title: string;
  ownerId: string;
  ownerName: string;
  startsAt: string; // ISO 8601
  durationMin: number;
  waitingRoom: boolean;
  createdAt: string;
};

const FILE = path.join(process.cwd(), ".data", "meetings.json");

async function load(): Promise<ScheduledMeeting[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as ScheduledMeeting[];
  } catch {
    return [];
  }
}

async function save(meetings: ScheduledMeeting[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(meetings, null, 2));
}

export async function listMeetings(ownerId: string): Promise<ScheduledMeeting[]> {
  return (await load())
    .filter((m) => m.ownerId === ownerId)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function findByRoom(room: string): Promise<ScheduledMeeting | undefined> {
  return (await load()).find((m) => m.room === room);
}

export async function findById(id: string): Promise<ScheduledMeeting | undefined> {
  return (await load()).find((m) => m.id === id);
}

export async function createMeeting(
  m: Omit<ScheduledMeeting, "id" | "createdAt">,
): Promise<ScheduledMeeting> {
  const all = await load();
  const meeting = { ...m, id: randomUUID(), createdAt: new Date().toISOString() };
  all.push(meeting);
  await save(all);
  return meeting;
}

export async function deleteMeeting(id: string, ownerId: string): Promise<boolean> {
  const all = await load();
  const next = all.filter((m) => !(m.id === id && m.ownerId === ownerId));
  if (next.length === all.length) return false;
  await save(next);
  return true;
}

// iCalendar invite so the meeting can be added to any calendar app.
export function toIcs(m: ScheduledMeeting, joinUrl: string): string {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = new Date(m.startsAt);
  const end = new Date(start.getTime() + m.durationMin * 60_000);
  const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beldex Meet//EN",
    "BEGIN:VEVENT",
    `UID:${m.id}@beldex-meet`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc(`Join Beldex Meet: ${joinUrl}\nMeeting code: ${m.room}`)}`,
    `URL:${joinUrl}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
