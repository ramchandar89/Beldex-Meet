import { NextRequest, NextResponse } from "next/server";
import { getRoomFee, setRoomFee } from "@/lib/roomFees";

export const dynamic = "force-dynamic";

const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// GET ?room=<code>  -> { fee: number | null }  (BDX; null when the host set none)
export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room") ?? "";
  if (!ROOM_RE.test(room)) return NextResponse.json({ error: "Invalid room" }, { status: 400 });
  const entry = await getRoomFee(room);
  return NextResponse.json({ fee: entry?.fee ?? null });
}

// POST { room, fee, ownerId }  -> { fee }   Host sets the entry fee on create.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const room = typeof body.room === "string" ? body.room : "";
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
  const fee = typeof body.fee === "number" ? body.fee : Number(body.fee);
  if (!ROOM_RE.test(room)) return NextResponse.json({ error: "Invalid room" }, { status: 400 });
  if (!ownerId) return NextResponse.json({ error: "Missing owner" }, { status: 400 });
  if (!Number.isFinite(fee) || fee <= 0 || fee > 1_000_000) {
    return NextResponse.json({ error: "Fee must be greater than 0" }, { status: 400 });
  }
  const entry = await setRoomFee(room, Math.round(fee * 1e9) / 1e9, ownerId);
  if (!entry) return NextResponse.json({ error: "Fee already set by another host" }, { status: 409 });
  return NextResponse.json({ fee: entry.fee });
}
