import { AccessToken, type VideoGrant } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  DEFAULT_SETTINGS,
  getRoomService,
  isWaiting,
  permissionFor,
  readSettings,
  writeSettings,
  type RoomSettings,
} from "@/lib/roomAdmin";
import { findByRoom } from "@/lib/meetings";

// Always run on the server, never cached — tokens are per-user and short-lived.
export const dynamic = "force-dynamic";

type JoinPlan = { blocked?: string; waiting: boolean; privileged: boolean; settings: RoomSettings };

// Decide how this person joins: refused (locked), into the waiting room, or
// straight in — and with which publish rights.
// Fails open: if the admin API is unreachable we still mint a normal token so
// a misconfigured/offline LiveKit server doesn't block all joins.
async function planJoin(room: string, identity: string, userId: string | null): Promise<JoinPlan> {
  const open: JoinPlan = { waiting: false, privileged: true, settings: { ...DEFAULT_SETTINGS } };
  try {
    const svc = getRoomService();
    let settings = await readSettings(svc, room);
    if (settings?.locked) {
      return { ...open, blocked: "This room is locked by the host" };
    }

    // Scheduled meetings: the owner is always the host and skips the waiting
    // room; the scheduled waiting-room preference applies when the room is created.
    const scheduled = await findByRoom(room);
    const isOwner = !!scheduled && !!userId && scheduled.ownerId === userId;
    if (!settings && scheduled) {
      const initial = { ...DEFAULT_SETTINGS, waitingRoom: scheduled.waitingRoom };
      await svc.createRoom({ name: room, metadata: JSON.stringify(initial) });
      settings = initial;
    }
    if (isOwner) settings = await writeSettings(svc, room, { host: identity });
    settings ??= { ...DEFAULT_SETTINGS };

    const participants = await svc.listParticipants(room);
    const admitted = participants.filter((p) => !isWaiting(p));
    // Nobody admitted yet => this person will be the host.
    const privileged = isOwner || admitted.length === 0;
    const waiting = settings.waitingRoom && !privileged;
    return { waiting, privileged, settings };
  } catch {
    return open;
  }
}

export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room");
  const username = req.nextUrl.searchParams.get("username");
  const userId = req.nextUrl.searchParams.get("userId");

  if (!room) {
    return NextResponse.json({ error: "Missing 'room' query param" }, { status: 400 });
  }
  if (!username) {
    return NextResponse.json({ error: "Missing 'username' query param" }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "Server misconfigured: LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set" },
      { status: 500 },
    );
  }

  // Identity must be unique per participant: two people called "Alex" (or the
  // same person on two devices) would otherwise kick each other out.
  const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "guest";
  const identity = `${slug}-${randomBytes(3).toString("hex")}`;

  const plan = await planJoin(room, identity, userId);
  if (plan.blocked) {
    return NextResponse.json({ error: plan.blocked }, { status: 403 });
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: username,
    ttl: "4h",
    // Waiting-room state is a participant attribute the host clears on admit.
    attributes: plan.waiting ? { waiting: "true" } : undefined,
  });

  const grant: VideoGrant = { room, roomJoin: true };
  if (plan.waiting) {
    // In the waiting room: connected (so the host sees you) but can't see,
    // hear or send anything until admitted.
    Object.assign(grant, {
      canSubscribe: false,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
  } else {
    const perm = permissionFor(plan.settings, plan.privileged);
    Object.assign(grant, {
      canSubscribe: true,
      canPublish: perm.canPublish,
      canPublishSources: perm.canPublishSources,
      canPublishData: perm.canPublishData,
      // Allows the client to set its own attributes (e.g. raise-hand state).
      canUpdateOwnMetadata: true,
    });
  }
  at.addGrant(grant);

  const token = await at.toJwt();
  // Return the server URL too so native clients (the mobile app) don't need it
  // hardcoded — they just call this one endpoint.
  return NextResponse.json({
    token,
    identity,
    waiting: plan.waiting,
    serverUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL ?? null,
  });
}
