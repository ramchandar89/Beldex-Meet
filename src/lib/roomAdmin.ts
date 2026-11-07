// Server-side LiveKit admin helpers for host controls (mute, remove, lock,
// waiting room, permissions, roles, end meeting).
//
// These use the LiveKit server SDK with the API key/secret, so they must only
// ever run on the server (route handlers).
//
// Who is the host? In order:
//   1. `settings.host` — set when the host role is transferred, or when the
//      owner of a scheduled meeting joins — if that participant is present;
//   2. otherwise the first co-host still present;
//   3. otherwise the earliest-joined admitted participant (ties by identity).
// Participants still in the waiting room never count. We recompute this from
// the live participant list on every call rather than trusting the client.
//
// Requests are authenticated with the caller's own LiveKit join token (sent as
// `Authorization: Bearer <token>`), so a client can't act as someone else.

import {
  RoomServiceClient,
  TokenVerifier,
  TrackSource,
  type ParticipantInfo,
  type ParticipantPermission,
} from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

// The RoomServiceClient talks to LiveKit over HTTP, but the app configures the
// media URL as a WebSocket URL (ws:// or wss://). Convert ws->http / wss->https.
function livekitHttpUrl(): string {
  const ws = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "ws://localhost:7880";
  return ws.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function credentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set");
  }
  return { apiKey, apiSecret };
}

export function getRoomService(): RoomServiceClient {
  const { apiKey, apiSecret } = credentials();
  return new RoomServiceClient(livekitHttpUrl(), apiKey, apiSecret);
}

/* ------------------------------ room settings ------------------------------ */

// Meeting-wide settings, stored as JSON in the room metadata. LiveKit
// broadcasts room metadata to every connected client, so the UI stays in sync.
export type RoomSettings = {
  locked: boolean;
  waitingRoom: boolean;
  // Zoom's "Allow participants to …" toggles (hosts/co-hosts are exempt).
  allowChat: boolean;
  allowScreenShare: boolean;
  allowUnmute: boolean;
  allowVideo: boolean;
  allowRename: boolean;
  host?: string;
  cohosts: string[];
};

export const DEFAULT_SETTINGS: RoomSettings = {
  locked: false,
  waitingRoom: false,
  allowChat: true,
  allowScreenShare: true,
  allowUnmute: true,
  allowVideo: true,
  allowRename: true,
  cohosts: [],
};

export function parseSettings(meta?: string): RoomSettings {
  if (!meta) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(meta);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      cohosts: Array.isArray(parsed?.cohosts) ? parsed.cohosts : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Settings of a live room, or null if the room doesn't exist yet.
export async function readSettings(
  svc: RoomServiceClient,
  room: string,
): Promise<RoomSettings | null> {
  const rooms = await svc.listRooms([room]);
  if (rooms.length === 0) return null;
  return parseSettings(rooms[0].metadata);
}

// Read-modify-write so one toggle never wipes the others.
export async function writeSettings(
  svc: RoomServiceClient,
  room: string,
  patch: Partial<RoomSettings>,
): Promise<RoomSettings> {
  const current = (await readSettings(svc, room)) ?? { ...DEFAULT_SETTINGS };
  const next = { ...current, ...patch };
  await svc.updateRoomMetadata(room, JSON.stringify(next));
  return next;
}

/* ---------------------------------- roles ---------------------------------- */

export function isWaiting(p: ParticipantInfo): boolean {
  return p.attributes?.waiting === "true";
}

export function pickHost(
  participants: ParticipantInfo[],
  settings: RoomSettings = DEFAULT_SETTINGS,
): ParticipantInfo | null {
  const admitted = participants.filter((p) => !isWaiting(p));
  if (admitted.length === 0) return null;
  const byId = (id?: string) => admitted.find((p) => p.identity === id);
  const explicit = byId(settings.host);
  if (explicit) return explicit;
  for (const id of settings.cohosts) {
    const c = byId(id);
    if (c) return c;
  }
  return [...admitted].sort((a, b) => {
    const ja = Number(a.joinedAt);
    const jb = Number(b.joinedAt);
    if (ja !== jb) return ja - jb;
    return a.identity < b.identity ? -1 : 1;
  })[0];
}

// What a participant may publish. Hosts and co-hosts may always do everything.
export function permissionFor(
  settings: RoomSettings,
  privileged: boolean,
): Partial<ParticipantPermission> {
  const sources: TrackSource[] = [];
  if (privileged || settings.allowUnmute) sources.push(TrackSource.MICROPHONE);
  if (privileged || settings.allowVideo) sources.push(TrackSource.CAMERA);
  if (privileged || settings.allowScreenShare) {
    sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }
  return {
    canSubscribe: true,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canPublishData: privileged || settings.allowChat,
    // Needed for raise hand (participant attributes), so always on.
    canUpdateMetadata: true,
  };
}

// Push the current settings to every admitted participant's permissions.
export async function applyPermissions(
  svc: RoomServiceClient,
  room: string,
  participants: ParticipantInfo[],
  settings: RoomSettings,
): Promise<void> {
  const host = pickHost(participants, settings);
  await Promise.all(
    participants
      .filter((p) => !isWaiting(p))
      .map((p) => {
        const privileged = p.identity === host?.identity || settings.cohosts.includes(p.identity);
        return svc.updateParticipant(room, p.identity, {
          permission: permissionFor(settings, privileged),
        });
      }),
  );
}

// Track SIDs a participant publishes from one source.
export function trackSids(p: ParticipantInfo, source: TrackSource): string[] {
  return p.tracks.filter((t) => t.source === source).map((t) => t.sid);
}

// Microphone (audio) track SIDs published by a participant.
export function micTrackSids(p: ParticipantInfo): string[] {
  return trackSids(p, TrackSource.MICROPHONE);
}

/* ------------------------------ route plumbing ----------------------------- */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Verify the caller's LiveKit join token for `room` and return its identity.
async function authenticate(req: NextRequest, room: string): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Missing join token");
  const { apiKey, apiSecret } = credentials();
  try {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
    if (claims.video?.room !== room || !claims.sub) throw new Error();
    return claims.sub;
  } catch {
    throw new HttpError(401, "Invalid join token for this room");
  }
}

export type HostContext = {
  svc: RoomServiceClient;
  room: string;
  requester: string;
  body: Record<string, unknown>;
  participants: ParticipantInfo[];
  settings: RoomSettings;
  host: ParticipantInfo | null;
  // The requester is the host (not just a co-host).
  isHost: boolean;
};

// Shared wrapper for host-control routes: parses the body, authenticates the
// caller, loads the room state and enforces the required role.
//   "host"    — only the host (end meeting, assign roles)
//   "cohost"  — host or co-host (mute, remove, admit, permissions, …)
//   "member"  — anyone admitted to the room (self-rename)
export async function hostRoute(
  req: NextRequest,
  level: "host" | "cohost" | "member",
  fn: (ctx: HostContext) => Promise<Record<string, unknown> | void>,
): Promise<NextResponse> {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    const room = typeof body.room === "string" ? body.room : "";
    if (!room) throw new HttpError(400, "Missing 'room'");
    const requester = await authenticate(req, room);

    const svc = getRoomService();
    const [participants, settings] = await Promise.all([
      svc.listParticipants(room),
      readSettings(svc, room),
    ]);
    if (!settings) throw new HttpError(404, "Meeting not found");
    const host = pickHost(participants, settings);
    const isHost = host?.identity === requester;
    const isCohost = settings.cohosts.includes(requester);
    const me = participants.find((p) => p.identity === requester);
    const allowed =
      level === "host" ? isHost : level === "cohost" ? isHost || isCohost : !!me && !isWaiting(me);
    if (!allowed) {
      throw new HttpError(403, level === "member" ? "You're not in this meeting" : "Only the host can do that");
    }

    const result = await fn({ svc, room, requester, body, participants, settings, host, isHost });
    return NextResponse.json({ ok: true, ...(result ?? {}) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Request failed";
    return NextResponse.json({ error: msg }, { status });
  }
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw new HttpError(400, `Missing '${key}'`);
  return v;
}
