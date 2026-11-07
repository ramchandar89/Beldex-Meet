import { NextRequest } from "next/server";
import { hostRoute } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host/co-host: lower every raised hand.
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, participants }) => {
    const raised = participants.filter((p) => p.attributes?.handRaised === "true");
    await Promise.all(
      raised.map((p) => svc.updateParticipant(room, p.identity, { attributes: { handRaised: "" } })),
    );
    return { lowered: raised.length };
  });
}
