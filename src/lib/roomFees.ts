// Entry fees for paid rooms (codes starting with 9), persisted to a JSON file
// on the server so people joining can see the amount the host set.
//
// Prototype storage, like meetings.ts: fine for a single Next.js server.
// Payment itself is still simulated.

import { promises as fs } from "fs";
import path from "path";

export type RoomFee = {
  room: string;
  fee: number; // BDX
  ownerId: string;
  createdAt: string;
};

const FILE = path.join(process.cwd(), ".data", "room-fees.json");

async function load(): Promise<RoomFee[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as RoomFee[];
  } catch {
    return [];
  }
}

async function save(fees: RoomFee[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(fees, null, 2));
}

export async function getRoomFee(room: string): Promise<RoomFee | undefined> {
  return (await load()).find((f) => f.room === room);
}

/** Set a room's fee. The first host to set it owns it; others can't overwrite. */
export async function setRoomFee(room: string, fee: number, ownerId: string): Promise<RoomFee | null> {
  const all = await load();
  const existing = all.find((f) => f.room === room);
  if (existing && existing.ownerId !== ownerId) return null;
  const entry: RoomFee = { room, fee, ownerId, createdAt: existing?.createdAt ?? new Date().toISOString() };
  await save([...all.filter((f) => f.room !== room), entry]);
  return entry;
}
