import { NextRequest } from "next/server";
import { HttpError, hostRoute, writeSettings } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host/co-host: lock or unlock the room. The lock state lives in the room's
// metadata, which LiveKit broadcasts to every connected client (so the UI can
// reflect it) and which the token endpoint checks to refuse new joins.
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, body }) => {
    if (typeof body.locked !== "boolean") throw new HttpError(400, "Missing boolean 'locked'");
    await writeSettings(svc, room, { locked: body.locked });
    return { locked: body.locked };
  });
}
