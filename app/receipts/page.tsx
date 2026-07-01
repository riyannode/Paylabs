import ReceiptsClient from "./receipts-client";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run } = await searchParams;
  return (
    <>
      <SubPageMobileNav />
      <ReceiptsClient initialRunId={run || null} />
    </>
  );
}
