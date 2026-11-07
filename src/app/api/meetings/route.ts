import { NextRequest, NextResponse } from "next/server";
import { createMeeting, deleteMeeting, findById, listMeetings, toIcs } from "@/lib/meetings";

export const dynamic = "force-dynamic";

const ADJECTIVES = ["warm", "calm", "bright", "swift", "quiet", "bold", "lucky", "clever"];
const NOUNS = ["fox", "otter", "finch", "cedar", "river", "ember", "maple", "comet"];

function randomRoomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// GET ?owner=<userId>          -> the owner's scheduled meetings
// GET ?id=<id>&format=ics      -> calendar invite for one meeting
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const id = params.get("id");
  if (id && params.get("format") === "ics") {
    const m = await findById(id);
    if (!m) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    const joinUrl = `${req.nextUrl.origin}/rooms/${encodeURIComponent(m.room)}`;
    return new NextResponse(toIcs(m, joinUrl), {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${m.room}.ics"`,
      },
    });
  }
  const owner = params.get("owner");
  if (!owner) return NextResponse.json({ error: "Missing 'owner'" }, { status: 400 });
  return NextResponse.json({ meetings: await listMeetings(owner) });
}

// Schedule a meeting.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { ownerId, ownerName, title, startsAt, durationMin, waitingRoom } = body;
  if (typeof ownerId !== "string" || !ownerId) {
    return NextResponse.json({ error: "Missing 'ownerId'" }, { status: 400 });
  }
  const start = typeof startsAt === "string" ? new Date(startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) {
    return NextResponse.json({ error: "Pick a valid start date and time" }, { status: 400 });
  }
  const duration = Number(durationMin);
  if (!Number.isFinite(duration) || duration < 5 || duration > 24 * 60) {
    return NextResponse.json({ error: "Duration must be 5 minutes to 24 hours" }, { status: 400 });
  }
  const meeting = await createMeeting({
    room: randomRoomName(),
    title: (typeof title === "string" && title.trim()) || "Beldex Meet meeting",
    ownerId,
    ownerName: typeof ownerName === "string" ? ownerName : "",
    startsAt: start.toISOString(),
    durationMin: Math.round(duration),
    waitingRoom: waitingRoom === true,
  });
  return NextResponse.json({ meeting });
}

// DELETE ?id=<id>&owner=<userId>
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const owner = req.nextUrl.searchParams.get("owner");
  if (!id || !owner) return NextResponse.json({ error: "Missing 'id' or 'owner'" }, { status: 400 });
  const ok = await deleteMeeting(id, owner);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Meeting not found" }, { status: 404 });
}
