import ReceiptsClient from "./receipts-client";
import PageHeader from "@/components/paylabs/PageHeader";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run } = await searchParams;
  return (
    <>
      <PageHeader />
      <ReceiptsClient initialRunId={run || null} />
    </>
  );
}
