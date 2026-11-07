import { NextRequest } from "next/server";
import { HttpError, hostRoute, requireString } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host/co-host: remove a participant from the room. They are disconnected and
// can rejoin unless the room is also locked.
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, requester, body, host }) => {
    const target = requireString(body, "target");
    if (target === requester) throw new HttpError(400, "You can't remove yourself");
    if (target === host?.identity) throw new HttpError(403, "A co-host can't remove the host");
    await svc.removeParticipant(room, target);
  });
}
