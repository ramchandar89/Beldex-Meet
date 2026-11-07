import { NextRequest } from "next/server";
import { TrackSource } from "livekit-server-sdk";
import { hostRoute, isWaiting, trackSids } from "@/lib/roomAdmin";

export const dynamic = "force-dynamic";

// Host/co-host: server-mute a participant's microphone (or stop their camera
// with `source: "camera"`), or everyone but the requester when `target` is
// omitted ("Mute all"). Server-side mute still lets the person unmute
// themselves later (unless the host disallowed it), matching Zoom.
export async function POST(req: NextRequest) {
  return hostRoute(req, "cohost", async ({ svc, room, requester, body, participants }) => {
    const target = typeof body.target === "string" ? body.target : undefined;
    const source = body.source === "camera" ? TrackSource.CAMERA : TrackSource.MICROPHONE;

    const targets = target
      ? participants.filter((p) => p.identity === target)
      : participants.filter((p) => p.identity !== requester && !isWaiting(p));

    let muted = 0;
    for (const p of targets) {
      for (const sid of trackSids(p, source)) {
        await svc.mutePublishedTrack(room, p.identity, sid, true);
        muted += 1;
      }
    }
    return { muted };
  });
}
