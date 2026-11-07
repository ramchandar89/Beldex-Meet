import RoomClient from "./RoomClient";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomName: string }>;
}) {
  const { roomName } = await params;
  return <RoomClient roomName={decodeURIComponent(roomName)} />;
}
