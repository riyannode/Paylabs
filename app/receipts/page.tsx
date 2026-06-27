import ReceiptsClient from "./receipts-client";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run } = await searchParams;
  return <ReceiptsClient initialRunId={run || null} />;
}
