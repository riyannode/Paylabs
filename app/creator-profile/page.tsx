import CreatorProfileClient from "./creator-profile-client";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";

export default function CreatorProfilePage() {
  return (
    <>
      <SubPageMobileNav />
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/chat" className="pl-back-btn">← Back to Chat</a>
        <h1 className="page-title">Creator Profile</h1>
      </div>

      <CreatorProfileClient />
    </div>
    </>
  );
}
