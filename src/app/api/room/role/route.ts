import { NextRequest } from "next/server";
import {
  HttpError,
  applyPermissions,
  hostRoute,
  isWaiting,
  requireString,
  writeSettings,
} from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host only: make someone the host (transfers the role), a co-host, or a
// regular participant again. Permissions are re-applied so the new role's
// publish rights take effect immediately.
export async function POST(req: NextRequest) {
  return hostRoute(req, "host", async ({ svc, room, requester, body, participants, settings }) => {
    const target = requireString(body, "target");
    const role = body.role;
    const p = participants.find((x) => x.identity === target);
    if (!p || isWaiting(p)) throw new HttpError(404, "That participant isn't in the meeting");

    const cohosts = settings.cohosts.filter((id) => id !== target);
    let patch;
    if (role === "host") {
      // The previous host stays on as a co-host, like Zoom's "Make host".
      patch = { host: target, cohosts: [...cohosts.filter((id) => id !== requester), requester] };
    } else if (role === "cohost") {
      // Pin the current host so co-hosts only take over if they leave.
      patch = { host: settings.host ?? requester, cohosts: [...cohosts, target] };
    } else if (role === "participant") {
      patch = { cohosts };
    } else {
      throw new HttpError(400, "'role' must be host, cohost or participant");
    }
    const next = await writeSettings(svc, room, patch);
    await applyPermissions(svc, room, participants, next);
    return { settings: next };
  });
}
