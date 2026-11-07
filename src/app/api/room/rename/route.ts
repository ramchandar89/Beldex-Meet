import { NextRequest } from "next/server";
import { HttpError, hostRoute, requireString } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Rename a participant. Anyone may rename themselves (unless the host turned
// off "Allow participants to rename themselves"); hosts/co-hosts may rename
// anybody.
export async function POST(req: NextRequest) {
  return hostRoute(req, "member", async ({ svc, room, requester, body, settings, host }) => {
    const name = requireString(body, "name").trim().slice(0, 64);
    if (!name) throw new HttpError(400, "Name can't be empty");
    const target = typeof body.target === "string" && body.target ? body.target : requester;
    const privileged = host?.identity === requester || settings.cohosts.includes(requester);
    if (target !== requester && !privileged) throw new HttpError(403, "Only the host can do that");
    if (target === requester && !privileged && !settings.allowRename) {
      throw new HttpError(403, "The host has disabled renaming");
    }
    await svc.updateParticipant(room, target, { name });
    return { name };
  });
}
