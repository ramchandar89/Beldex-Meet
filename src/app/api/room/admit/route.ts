import { NextRequest } from "next/server";
import { hostRoute, isWaiting, permissionFor } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host/co-host: admit someone from the waiting room (`target`), admit
// everyone waiting (`all: true`), or turn someone away (`deny: true`).
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, body, participants, settings }) => {
    const waiting = participants.filter(isWaiting);
    const targets = body.all === true ? waiting : waiting.filter((p) => p.identity === body.target);

    for (const p of targets) {
      if (body.deny === true) {
        await svc.removeParticipant(room, p.identity);
      } else {
        await svc.updateParticipant(room, p.identity, {
          attributes: { waiting: "" },
          permission: permissionFor(settings, false),
        });
      }
    }
    return { count: targets.length };
  });
}
