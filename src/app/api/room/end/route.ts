import { NextRequest } from "next/server";
import { hostRoute } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host only: end the meeting for everyone. Deleting the LiveKit room
// disconnects every participant (they see "The host ended the meeting").
export async function POST(req: NextRequest) {
  return hostRoute(req, "host", async ({ svc, room }) => {
    await svc.deleteRoom(room);
  });
}
