import { NextRequest } from "next/server";
import { applyPermissions, hostRoute, writeSettings, type RoomSettings } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

const TOGGLES = [
  "waitingRoom",
  "allowChat",
  "allowScreenShare",
  "allowUnmute",
  "allowVideo",
  "allowRename",
] as const;

// Host/co-host: change meeting-wide settings (waiting room, "allow
// participants to …" permissions). Permission changes are enforced by LiveKit:
// every admitted participant's publish rights are updated immediately.
// An empty patch just re-applies the current permissions (used when the host
// role moves to someone whose rights were restricted).
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, body, participants }) => {
    const patch: Partial<RoomSettings> = {};
    for (const key of TOGGLES) {
      if (typeof body[key] === "boolean") patch[key] = body[key] as boolean;
    }
    const settings = await writeSettings(svc, room, patch);
    await applyPermissions(svc, room, participants, settings);
    return { settings };
  });
}
